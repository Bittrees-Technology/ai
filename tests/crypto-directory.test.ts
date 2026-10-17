import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  CryptoDirectoryResearch,
  groundedDirectoryAnswer,
  directoryURL,
} from "../modules/research/crypto-directory.js";
import { Vault } from "../modules/storage/vault.js";
const text =
  "Example is an onchain lending protocol. It offers lending markets.";
const answer = {
  fits: true,
  name: "Example",
  summary: "A lending protocol.",
  tags: ["DeFi"],
  claims: [
    {
      field: "name",
      value: "Example",
      quote: "Example is an onchain lending protocol.",
    },
    {
      field: "description",
      value: "Lending",
      quote: "It offers lending markets.",
    },
  ],
  uncertainties: ["Founding year unconfirmed"],
};
test("source assessment rejects invented quotes, tags, and missing project evidence", () => {
  assert.equal(groundedDirectoryAnswer(answer, text, ["DeFi"]).fits, true);
  assert.throws(() =>
    groundedDirectoryAnswer({ ...answer, tags: ["Invented"] }, text, ["DeFi"]),
  );
  assert.throws(() =>
    groundedDirectoryAnswer(
      {
        ...answer,
        claims: [
          {
            field: "name",
            value: "Example",
            quote: "This quote is fabricated",
          },
        ],
      },
      text,
      ["DeFi"],
    ),
  );
  assert.throws(() =>
    groundedDirectoryAnswer({ ...answer, claims: [] }, text, ["DeFi"]),
  );
  for (const url of [
    "http://example.com",
    "https://user:pass@example.com",
    "https://example.com:123",
  ])
    assert.throws(() => directoryURL(url));
});
test("enabled validation saves grounded local results, respects cadence, preserves repository and pause", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "directory-workflow-")),
  );
  await mkdir(join(root, "content/projects"), { recursive: true });
  const path = join(root, "content/projects/example.md");
  const original =
    "---\nname: Example\nprimary_url: https://example.org\ntags: [DeFi]\nlead_category: DeFi\n---\n";
  await writeFile(path, original);
  let calls = 0,
    admission = "ready";
  const runtime: any = {
    pin: async () => ({
      profile: { model: "local", contextTokens: 32000, maxOutputTokens: 2000 },
      digest: "abc",
    }),
    generate: async () => {
      calls++;
      return JSON.stringify(answer);
    },
  };
  const worker = new CryptoDirectoryResearch(
    join(root, "state.db"),
    new Vault(randomBytes(32)),
    runtime,
    () => ({ id: "test" }),
    () => ({ reason: admission, seconds: 60 }),
    async (_signal, work) => work(),
    { page: async () => ({ url: "https://example.org/", text, links: [] }) },
  );
  try {
    await worker.configure({
      confirmed: true,
      enabled: true,
      repository: root,
      profileId: "test",
    });
    admission = "paused";
    await worker.tick();
    assert.equal(calls, 0);
    admission = "ready";
    await worker.tick();
    assert.equal(calls, 1);
    assert.equal(worker.status().results[0].status, "source-assessed");
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal(
      worker.status().workflows.find((w) => w.mode === "validation")?.state,
      "waiting",
    );
    await worker.pause();
    await worker.tick();
    assert.equal(calls, 1);
    assert.equal(worker.status().enabled, false);
  } finally {
    await worker.close();
    await rm(root, { recursive: true });
  }
});

test("discovery hands off durably, validation receipts prove model execution, failures never complete", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "directory-chain-")),
  );
  await mkdir(join(root, "content/projects"), { recursive: true });
  await writeFile(
    join(root, "content/projects/example.md"),
    "---\nname: Example\nprimary_url: https://existing.org\ntags: [DeFi]\n---\n",
  );
  const vault = new Vault(randomBytes(32));
  let calls = 0,
    fail = false;
  const runtime: any = {
    pin: async () => ({
      profile: { model: "local", contextTokens: 32000, maxOutputTokens: 2000 },
      digest: "digest",
    }),
    generate: async () => {
      calls++;
      if (fail) throw Error("Model failed");
      return JSON.stringify(answer);
    },
  };
  const make = () =>
    new CryptoDirectoryResearch(
      join(root, "state.db"),
      vault,
      runtime,
      () => ({}),
      () => ({ reason: "ready", seconds: 60 }),
      async (_s, work) => work(),
      {
        page: async (url) => ({ url, text, links: [] }),
        feed: async () => [{ url: "https://new.org" }],
      },
    );
  let worker = make();
  try {
    await worker.configure({
      confirmed: true,
      enabled: true,
      repository: root,
      profileId: "test",
    });
    await worker.tick(); // existing validation
    await worker.tick(); // discovery
    assert.equal(calls, 2);
    assert.equal(worker.status().followups.length, 1);
    assert.equal(worker.status().followups[0].state, "queued");
    await worker.close();
    worker = make();
    await worker.tick(); // follow-up ignores hourly delay
    assert.equal(calls, 3);
    const q = worker.status().followups[0];
    assert.equal(q.state, "completed");
    const r = worker.status().receipts.find((r: any) => r.id === q.receiptId);
    assert.equal(r.state, "completed");
    assert.ok(
      r.modelStartedAt && r.modelFinishedAt && r.evidenceHash && r.sourceHash,
    );
    assert.equal(r.parentId, q.parentId);
    await worker.tick();
    assert.equal(calls, 3); // idempotent
    await worker.close();
    worker = make();
    await worker.tick();
    assert.equal(calls, 3); // completed stays completed
    // Fresh discovery parent schedules an independent follow-up for failure testing.
    (worker as any).enqueue("https://failure.org", "test-parent");
    fail = true;
    await worker.tick();
    const failed = worker
      .status()
      .followups.find((q: any) => q.parentId === "test-parent");
    assert.equal(failed.state, "queued");
    assert.equal(failed.attempts, 1);
    assert.ok(failed.nextAt > Date.now());
    assert.equal(worker.status().receipts[0].state, "needs-research");
    assert.equal(worker.status().receipts[0].resultId, undefined);
    await worker.tick();
    assert.equal(calls, 4); // retry backoff
  } finally {
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
});
