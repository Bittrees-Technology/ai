import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import {
  QualificationResearch,
  validateQualification,
  evidenceExcerpt,
  gates,
} from "../modules/research/qualification.js";
import { Vault } from "../modules/storage/vault.js";
const url = "https://example.org/team";
const page = {
  url,
  text: "Jane Smith invests private family capital in international vehicles.",
  links: [],
  retrievedAt: new Date().toISOString(),
};
const output = () => ({
  summary: "Mandate evidence remains incomplete",
  gates: Object.fromEntries(
    gates.map((k) => [k, { status: "unknown", evidence: "", url: "" }]),
  ),
});
test("qualification rejects invented evidence and never promotes incomplete gates", () => {
  const q = output();
  q.gates.investmentRole = { status: "supported", evidence: page.text, url };
  q.gates.ticket = {
    status: "supported",
    evidence: "Invented investment ticket range",
    url,
  };
  const result = validateQualification(
    q,
    [page],
    "BBRF-PT | Priority research",
  );
  assert.equal(result.status, "Priority research");
  assert.equal(result.gates.investmentRole.status, "supported");
  assert.equal(result.gates.ticket.status, "unknown");
  const unknown = validateQualification(output(), [page], "");
  assert.equal(unknown.status, "Needs research");
  q.gates.individualUS = { status: "contradicted", evidence: page.text, url };
  assert.equal(validateQualification(q, [page], "").status, "Needs research");
});
async function fixture(conflict = false, uncertain = false) {
  const dir = mkdtempSync(join(tmpdir(), "qualification-")),
    datasetId = randomUUID(),
    projectId = randomUUID(),
    entryId = randomUUID();
  let writes = 0,
    contexts = 0,
    version = 1;
  const record = {
    id: randomUUID(),
    version: 1,
    category: "BBRF-PT | Priority research",
  };
  let entry: any = {
    id: entryId,
    kind: "people",
    name: "Jane Smith",
    website: url,
    category: record.category,
    research: { training: "pending" },
  };
  let failed = false;
  const connector: any = {
    status: async () => ({ datasetId }),
    project: async (name: string, args: any) => {
      assert.equal(args.projectId, projectId);
      if (name === "qualification.context") {
        contexts++;
        if (conflict && contexts === 3)
          entry = { ...entry, title: "User edited" };
        return structuredClone({
          datasetId,
          datasetVersion: version,
          entries: [{ entry, record }],
        });
      }
      assert.equal(name, "qualification.enrich");
      writes++;
      entry = {
        ...entry,
        research: { ...entry.research, qualification: args.qualification },
      };
      record.category = "BBRF-PT | " + args.qualification.status;
      version = 2;
      if (uncertain && !failed) {
        failed = true;
        throw new Error("Response lost");
      }
      return { receipts: [{ recordId: record.id }] };
    },
  };
  let turns = 0;
  const runtime: any = {
    pin: async () => ({
      profile: { contextTokens: 16384, maxOutputTokens: 2048 },
    }),
    generate: async () => JSON.stringify(output()),
  };
  const worker = new QualificationResearch(
    join(dir, "test.db"),
    new Vault(randomBytes(32)),
    connector,
    runtime,
    () => ({}),
    () => ({ reason: "ready", seconds: 10 }),
    async () => page,
    async (_s, run) => {
      turns++;
      return run();
    },
  );
  const created = await worker.create({
    confirmed: true,
    projectId,
    profileId: "local",
    brief: "BBRF-PT investment requirements with six evidence gates",
    entryIds: [entryId],
    urls: [url],
  });
  for (let i = 0; i < 100 && worker.isRunning; i++)
    await new Promise((r) => setTimeout(r, 5));
  return {
    worker,
    created,
    cleanup: async () => {
      await worker.close();
      rmSync(dir, { recursive: true, force: true });
    },
    get writes() {
      return writes;
    },
    get turns() {
      return turns;
    },
  };
}
test("existing profile enrichment verifies CRM readback and uses shared model turn", async () => {
  const f = await fixture();
  try {
    assert.equal(f.worker.status()[0]!.state, "complete");
    assert.equal(f.writes, 1);
    assert.equal(f.turns, 1);
    assert.equal(f.worker.status()[0]!.results.length, 1);
  } finally {
    await f.cleanup();
  }
});
test("concurrent dataset edit blocks stale enrichment before write", async () => {
  const f = await fixture(true);
  try {
    assert.equal(f.worker.status()[0]!.state, "needs_attention");
    assert.equal(f.writes, 0);
  } finally {
    await f.cleanup();
  }
});
test("uncertain save keeps exact payload for resume without generating again", async () => {
  const f = await fixture(false, true);
  try {
    assert.equal(f.worker.status()[0]!.pendingSave, true);
    await f.worker.resume(f.created.id);
    for (let i = 0; i < 100 && f.worker.isRunning; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(f.worker.status()[0]!.state, "complete");
    assert.equal(f.writes, 2);
    assert.equal(f.turns, 1);
  } finally {
    await f.cleanup();
  }
});

test("qualification endpoints require local authentication and reject foreign origins", async () => {
  const { createServer } = await import("node:http");
  const { localApi } = await import("../apps/companion/http.js");
  const { Store } = await import("../modules/storage/store.js");
  const store = new Store(":memory:", new Vault(randomBytes(32)));
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  let calls = 0;
  const token = "local-test-credential".repeat(3);
  server.on(
    "request",
    localApi({
      store,
      owner: { userId: "owner", tenantId: "personal" },
      token,
      port,
      qualificationResearch: {
        status: () => [],
        create: async () => {
          calls++;
          return { id: randomUUID() };
        },
      } as any,
    }),
  );
  const request = (headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${port}/v1/research/qualification/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: "{}",
    });
  try {
    assert.equal((await request({})).status, 401);
    assert.equal(
      (
        await request({
          Authorization: `Bearer ${token}`,
          Origin: "https://evil.example",
        })
      ).status,
      403,
    );
    assert.equal(calls, 0);
    assert.equal(
      (await request({ Authorization: `Bearer ${token}` })).status,
      200,
    );
    assert.equal(calls, 1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});

test("qualification excerpts retain a buried biography without inventing contiguous quotes", () => {
  const biography = "Jane Smith is the investment partner based in Boston.";
  const text =
    "Navigation boilerplate ".repeat(400) +
    biography +
    " Filler".repeat(400) +
    "Bitcoin collateral is not permitted.";
  const excerpt = evidenceExcerpt(text, "Jane Smith", 2200);
  assert(excerpt.includes(biography));
  assert(excerpt.includes("Bitcoin collateral"));
  assert(excerpt.length <= 2200);
  const q = output();
  q.gates.investmentRole = {
    status: "supported",
    evidence:
      "Jane Smith is the investment partner based in Boston. Bitcoin collateral is not permitted.",
    url,
  };
  assert.equal(
    validateQualification(q, [{ ...page, text }], "", "Jane Smith").gates
      .investmentRole.status,
    "unknown",
  );
});

test("another person's role or a firm address cannot establish the selected person's role or location", () => {
  const p = {
    ...page,
    text: "Other Person is an investment partner in New York. Our office is in Miami, Florida.",
  };
  const q = output();
  q.gates.investmentRole = {
    status: "supported",
    evidence: "Other Person is an investment partner in New York.",
    url,
  };
  q.gates.individualUS = {
    status: "supported",
    evidence: "Our office is in Miami, Florida.",
    url,
  };
  const result = validateQualification(q, [p], "", "Jane Smith");
  assert.equal(result.gates.investmentRole.status, "unknown");
  assert.equal(result.gates.individualUS.status, "unknown");
});

test("real quotations about global staff and investment services do not prove the mandate", () => {
  const q = output();
  q.summary = "Invented biography, wealth and residence must never be saved.";
  const role =
    "Mark W. Yusko CEO & Chief Investment Officer, Morgan Creek; Managing Partner, Morgan Creek Digital";
  const global =
    "Our investment professionals are globally-based, giving Morgan Creek an advantage by allowing our team to live and work in the same locations as many of our managers.";
  const services =
    "Morgan Creek Capital Management, LLC is a SEC-registered investment adviser providing investment management services to institutions and wealthy families.";
  q.gates.investmentRole = { status: "supported", evidence: role, url };
  q.gates.crossBorder = { status: "supported", evidence: global, url };
  q.gates.vehicle = { status: "supported", evidence: services, url };
  const result = validateQualification(
    q,
    [{ ...page, text: [role, global, services].join(" ") }],
    "BBRF-PT | Priority research",
    "Mark W. Yusko",
  );
  assert.equal(result.gates.investmentRole.status, "supported");
  assert.equal(result.gates.crossBorder.status, "unknown");
  assert.equal(result.gates.vehicle.status, "unknown");
  assert.equal(result.status, "Priority research");
  assert(!result.summary.includes("Invented"));
  assert(result.summary.includes("1 of 6"));
});

test("partial or negated compound requirements cannot establish fit or rejection", () => {
  for (const [key, evidence] of [
    ["bitcoinLeverage", "The firm invests in Bitcoin."],
    ["bitcoinLeverage", "The firm does not invest in leveraged Bitcoin."],
    ["crossBorder", "The firm invests globally, including Portugal."],
    ["vehicle", "The firm provides advice on preferred shares."],
    ["ticket", "The firm manages EUR50,000 million in assets."],
    [
      "individualUS",
      "Jane Smith is CIO. The firm is headquartered in the United States.",
    ],
  ] as const) {
    const q = output();
    q.gates[key] = { status: "supported", evidence, url };
    assert.equal(
      validateQualification(q, [{ ...page, text: evidence }], "", "Jane Smith")
        .gates[key].status,
      "unknown",
    );
  }
});

test("personal location must attach to the selected name, not another person in the quote", () => {
  const q = output();
  const evidence =
    "Jane Smith is CIO. Bob Jones is based in the United States.";
  q.gates.individualUS = { status: "supported", evidence, url };
  assert.equal(
    validateQualification(q, [{ ...page, text: evidence }], "", "Jane Smith")
      .gates.individualUS.status,
    "unknown",
  );
  const direct = "Jane Smith is based in the United States.";
  q.gates.individualUS.evidence = direct;
  assert.equal(
    validateQualification(q, [{ ...page, text: direct }], "", "Jane Smith")
      .gates.individualUS.status,
    "supported",
  );
});
