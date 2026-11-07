import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";
import { createDirectoryResearchBridge } from "../modules/research/directory-research-bridge.js";

type Manifest = {
  originalValidationRunId: string;
  items: {
    originalReceiptId: string;
    lastRecordedRetryReceiptId: string;
    reviewedResearchUrl: string;
    historicalAttempts: number;
  }[];
};
const signal = () => new AbortController().signal;
const synthetic: Manifest = {
  originalValidationRunId: randomUUID(),
  items: Array.from({ length: 9 }, (_, index) => ({
    originalReceiptId: randomUUID(),
    lastRecordedRetryReceiptId: randomUUID(),
    reviewedResearchUrl: "https://example.com/project/" + index,
    historicalAttempts: 2,
  })),
};
const request = (scope: Manifest) => ({
  originalValidationRunId: scope.originalValidationRunId,
  pairs: scope.items.map(
    ({ originalReceiptId, lastRecordedRetryReceiptId }) => ({
      originalReceiptId,
      lastRecordedRetryReceiptId,
    }),
  ),
});
const source = "Fixture Project builds a public example protocol.";
const validAnswer = {
  fits: true,
  name: "Fixture Project",
  tags: ["protocol"],
  summary: "Example protocol",
  claims: [
    { field: "name", value: "Fixture Project", quote: source },
    { field: "description", value: "public example protocol", quote: source },
  ],
  uncertainties: [],
};
type Host = Parameters<typeof createDirectoryResearchBridge>[2];
function stage(
  scope: Manifest,
  overrides: Partial<Host> = {},
  expectedDigest?: string,
) {
  const text = JSON.stringify(scope);
  const digest =
    expectedDigest ?? createHash("sha256").update(text).digest("hex");
  const calls = { auth: 0, reserve: 0, reads: [] as string[], model: 0 };
  const bridge = createDirectoryResearchBridge(text, digest, {
    allowedTags: ["protocol"],
    async authorize() {
      calls.auth++;
      return true;
    },
    async reserve() {
      return ++calls.reserve === 1;
    },
    async readSource(url) {
      calls.reads.push(url);
      return { url, text: source };
    },
    async analyze() {
      calls.model++;
      return {
        model: "fixture",
        modelDigest: "sha256:" + "a".repeat(64),
        answer: validAnswer,
      };
    },
    ...overrides,
  });
  return { bridge, calls, digest };
}

function outside(scope: Manifest) {
  const input = request(scope);
  const [first, second, ...rest] = input.pairs;
  const reversed = {
    originalReceiptId: first!.lastRecordedRetryReceiptId,
    lastRecordedRetryReceiptId: first!.originalReceiptId,
  };
  return [
    { ...input, originalValidationRunId: randomUUID() },
    { ...input, pairs: input.pairs.slice(1) },
    { ...input, pairs: [...input.pairs, first] },
    { ...input, pairs: [first, first, ...rest] },
    {
      ...input,
      pairs: [{ ...first, originalReceiptId: randomUUID() }, second, ...rest],
    },
    {
      ...input,
      pairs: [
        { ...first, lastRecordedRetryReceiptId: randomUUID() },
        second,
        ...rest,
      ],
    },
    {
      ...input,
      pairs: [
        {
          ...first,
          lastRecordedRetryReceiptId: second!.lastRecordedRetryReceiptId,
        },
        {
          ...second,
          lastRecordedRetryReceiptId: first!.lastRecordedRetryReceiptId,
        },
        ...rest,
      ],
    },
    { ...input, pairs: [reversed, second, ...rest] },
    {
      ...input,
      pairs: [
        { ...first, reviewedResearchUrl: "https://example.net/" },
        second,
        ...rest,
      ],
    },
    {
      ...input,
      pairs: [
        { ...first, lastRecordedRetryReceiptId: "invalid" },
        second,
        ...rest,
      ],
    },
    { ...input, ignoreBudget: true },
  ];
}

test("scope pin, malformed manifest and out-of-scope batch deny before host I/O", async () => {
  const { bridge, calls } = stage(synthetic);
  assert.throws(
    () =>
      createDirectoryResearchBridge(
        JSON.stringify(synthetic),
        "0".repeat(64),
        {} as Host,
      ),
    /digest/,
  );
  const duplicate = structuredClone(synthetic);
  duplicate.items[1]!.lastRecordedRetryReceiptId =
    duplicate.items[0]!.lastRecordedRetryReceiptId;
  assert.throws(() => stage(duplicate), /duplicate/);
  for (const raw of outside(synthetic))
    await assert.rejects(bridge.research(raw, signal()));
  assert.deepEqual(calls, { auth: 0, reserve: 0, reads: [], model: 0 });
});

test("exact synthetic batch produces nine grounded receipts once, in manifest order", async () => {
  const { bridge, calls, digest } = stage(synthetic);
  const raw = request(synthetic);
  raw.pairs.reverse();
  const result = await bridge.research(raw, signal());
  assert.equal(result.scopeDigest, digest);
  assert.deepEqual(
    result.receipts.map(
      ({ originalReceiptId, lastRecordedRetryReceiptId }) => ({
        originalReceiptId,
        lastRecordedRetryReceiptId,
      }),
    ),
    request(synthetic).pairs,
  );
  assert.equal(
    result.receipts[0]!.sourceHash,
    createHash("sha256").update(source).digest("hex"),
  );
  assert.deepEqual(
    calls.reads,
    synthetic.items.map((entry) => entry.reviewedResearchUrl),
  );
  assert.equal(calls.model, 9);
  await assert.rejects(bridge.research(raw, signal()), /already reserved/);
  assert.equal(calls.reads.length, 9);
  assert.equal(calls.model, 9);
});

test("denial after source read stops model and unexpected source URL fails closed", async () => {
  const revoked = stage(synthetic, {
    async authorize(_s, _i, action) {
      return action !== "model";
    },
  });
  await assert.rejects(
    revoked.bridge.research(request(synthetic), signal()),
    /authorization/,
  );
  assert.equal(revoked.calls.reads.length, 1);
  assert.equal(revoked.calls.model, 0);
  const redirected = stage(synthetic, {
    async readSource() {
      return { url: "https://example.com/other", text: source };
    },
  });
  await assert.rejects(
    redirected.bridge.research(request(synthetic), signal()),
    /reviewed evidence/,
  );
  assert.equal(redirected.calls.model, 0);
  const fabricated = stage(synthetic, {
    async analyze() {
      return {
        model: "fixture",
        modelDigest: "sha256:" + "a".repeat(64),
        answer: {
          ...validAnswer,
          claims: [
            { field: "name", value: "Fabricated", quote: "Fabricated Project" },
          ],
        },
      };
    },
  });
  await assert.rejects(
    fabricated.bridge.research(request(synthetic), signal()),
    /quote not present/,
  );
  const releaseDenied = stage(synthetic, {
    async authorize(_s, _i, action) {
      return action !== "release-evidence";
    },
  });
  await assert.rejects(
    releaseDenied.bridge.research(request(synthetic), signal()),
    /authorization/,
  );
});

const reviewPath = process.env.BITTREES_DIRECTORY_STAGING_REVIEW;
test(
  "loopback staging admits the exact original nine for review and holds exhausted research",
  {
    skip: !reviewPath,
  },
  async () => {
    const review = JSON.parse(readFileSync(reviewPath!, "utf8"));
    assert.equal(review.liveSync, false);
    assert.equal(review.activationAllowed, false);
    const actual: Manifest = {
      originalValidationRunId: review.originalValidationRunId,
      items: review.source.batch.map(
        ({
          originalReceiptId,
          lastRecordedRetryReceiptId,
          reviewedResearchUrl,
          historicalAttempts,
        }: Manifest["items"][number]) => ({
          originalReceiptId,
          lastRecordedRetryReceiptId,
          reviewedResearchUrl,
          historicalAttempts,
        }),
      ),
    };
    const reviewedDigest = process.env.BITTREES_DIRECTORY_STAGING_DIGEST;
    assert.match(reviewedDigest ?? "", /^[a-f0-9]{64}$/);
    const { bridge, calls, digest } = stage(actual, {}, reviewedDigest);
    const server = createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = JSON.parse(Buffer.concat(chunks).toString());
        const result =
          req.url === "/review"
            ? bridge.review(raw)
            : await bridge.research(raw, signal());
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify(result));
      } catch (error) {
        const status =
          error instanceof Error && /budget exhausted/.test(error.message)
            ? 409
            : 400;
        res.writeHead(status).end();
      }
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const send = (route: string, data: unknown) =>
        fetch("http://127.0.0.1:" + address.port + route, {
          method: "POST",
          body: JSON.stringify(data),
          signal: AbortSignal.timeout(2_000),
        });
      const result = await send("/review", request(actual));
      assert.equal(result.status, 200);
      assert.deepEqual(await result.json(), {
        scopeDigest: digest,
        pairCount: 9,
        exhausted: 9,
      });
      assert.equal((await send("/research", request(actual))).status, 409);
      for (const raw of outside(actual)) {
        assert.equal((await send("/review", raw)).status, 400);
        assert.equal((await send("/research", raw)).status, 400);
      }
      assert.deepEqual(calls, { auth: 0, reserve: 0, reads: [], model: 0 });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
