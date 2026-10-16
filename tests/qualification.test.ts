import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import {
  QualificationResearch,
  validateQualification,
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
  assert.equal(
    validateQualification(q, [page], "").status,
    "Outside US target",
  );
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
