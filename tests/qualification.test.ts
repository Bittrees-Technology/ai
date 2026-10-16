import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import {
  QualificationResearch,
  validateQualification,
  retainQualification,
  evidenceExcerpt,
  roleRetryPages,
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
async function fixture(
  conflict = false,
  uncertain = false,
  previous?: any,
  fetched = page,
  generate?: (call: number) => any,
) {
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
    research: {
      training: "pending",
      ...(previous ? { qualification: previous } : {}),
    },
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
  let turns = 0,
    calls = 0;
  const runtime: any = {
    pin: async () => ({
      profile: { contextTokens: 16384, maxOutputTokens: 2048 },
    }),
    generate: async () =>
      JSON.stringify(generate ? generate(++calls) : output()),
  };
  const worker = new QualificationResearch(
    join(dir, "test.db"),
    new Vault(randomBytes(32)),
    connector,
    runtime,
    () => ({}),
    () => ({ reason: "ready", seconds: 10 }),
    async () => fetched,
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
    assert.equal(f.turns, 2);
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
    assert.equal(f.turns, 2);
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

test("named investment director titles support only the role requirement", () => {
  for (const title of [
    "Managing Director of Investments",
    "Managing Director Investments",
    "Director of Investments",
    "Managing Director, Investments",
    "Managing Director — Investments",
    "Managing Director\n of\tInvestments",
  ]) {
    const evidence = `Jane Smith ${title}`;
    const q = output();
    q.gates.investmentRole = { status: "supported", evidence, url };
    const result = validateQualification(
      q,
      [{ ...page, text: evidence }],
      "BBRF-PT | Priority research",
      "Jane Smith",
    );
    assert.equal(result.gates.investmentRole.status, "supported", title);
    assert.equal(result.status, "Priority research");
    for (const key of gates.filter((k) => k !== "investmentRole"))
      assert.equal(result.gates[key].status, "unknown");
  }
});

test("director title expansion retains person, quotation and current-role requirements", () => {
  for (const evidence of [
    "Jane Smith Managing Director",
    "Jane Smith Managing Director of Investor Relations",
    "Jane Smith Director of Investment Operations",
    "Jane Smith former Managing Director of Investments",
    "Jane Smith was Managing Director of Investments",
    "Jane Smith formerly Managing Director of Investments",
    "Jane Smith served as Managing Director of Investments",
    "Jane Smith ex-Managing Director of Investments",
    "Jane Smith is not Managing Director of Investments",
    "Other Person Managing Director of Investments",
  ]) {
    const q = output();
    q.gates.investmentRole = { status: "supported", evidence, url };
    assert.equal(
      validateQualification(q, [{ ...page, text: evidence }], "", "Jane Smith")
        .gates.investmentRole.status,
      "unknown",
      evidence,
    );
  }
  const q = output();
  q.gates.investmentRole = {
    status: "supported",
    evidence: "Jane Smith Managing Director of Investments",
    url,
  };
  assert.equal(
    validateQualification(q, [page], "", "Jane Smith").gates.investmentRole
      .status,
    "unknown",
  );
});

function savedRole() {
  const raw = output();
  raw.gates.investmentRole = { status: "supported", evidence: page.text, url };
  return validateQualification(
    raw,
    [page],
    "BBRF-PT | Priority research",
    "Jane Smith",
  );
}
test("freshly revalidated prior role survives an unknown new extraction", () => {
  const previous = savedRole();
  const fresh = { ...page, retrievedAt: "2026-10-17T12:00:00.000Z" };
  const result = retainQualification(
    output(),
    [fresh],
    "BBRF-PT | Priority research",
    "Jane Smith",
    previous,
  );
  assert.equal(result.gates.investmentRole.status, "supported");
  assert.equal(result.sources[0]!.retrievedAt, fresh.retrievedAt);
  assert.equal(result.sources[0]!.quote, page.text);
  assert.equal(result.gates.ticket.status, "unknown");
  assert.notEqual(result.status, "Qualified");
});
test("missing, changed, uncited, wrong-person and contradictory prior evidence holds the write", () => {
  const previous = savedRole();
  for (const pages of [
    [],
    [{ ...page, text: "A different current biography without the old role." }],
    [{ ...page, url: "https://other.org/team" }],
  ])
    assert.throws(() =>
      retainQualification(output(), pages, "", "Jane Smith", previous),
    );
  assert.throws(() =>
    retainQualification(output(), [page], "", "Other Person", previous),
  );
  assert.throws(() =>
    retainQualification(output(), [page], "", "Jane Smith", {
      ...previous,
      sources: [],
    }),
  );
  const conflicting = output();
  conflicting.gates.investmentRole = {
    status: "contradicted",
    url,
    evidence: page.text,
  };
  assert.throws(
    () => retainQualification(conflicting, [page], "", "Jane Smith", previous),
    /Conflicting evidence/,
  );
});
test("worker retains valid support and an encrypted prior-assessment receipt", async () => {
  const previous = savedRole();
  const f = await fixture(false, false, previous);
  try {
    assert.equal(f.worker.status()[0]!.state, "complete");
    assert.equal(f.writes, 1);
    const result = f.worker.list()[0]!.results[0];
    assert.deepEqual(result.previousQualification, previous);
    assert.equal(
      "previousQualification" in f.worker.status()[0]!.results[0],
      false,
    );
    assert.equal(result.status, "Priority research");
  } finally {
    await f.cleanup();
  }
});
test("worker does not overwrite CRM when prior evidence disappears", async () => {
  const f = await fixture(false, false, savedRole(), {
    ...page,
    text: "A new navigation page with no investment biography.",
  });
  try {
    assert.equal(f.worker.status()[0]!.state, "needs_attention");
    assert.equal(f.writes, 0);
  } finally {
    await f.cleanup();
  }
});

test("pre-upgrade pending assessments cannot bypass retention validation", async () => {
  const f = await fixture(false, true);
  try {
    const old = f.worker.list()[0]!;
    delete old.retentionChecked;
    (f.worker as any).save(old);
    await f.worker.resume(f.created.id);
    for (let i = 0; i < 100 && f.worker.isRunning; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(f.writes, 1);
    assert.equal(f.worker.status()[0]!.state, "needs_attention");
    assert.match(f.worker.status()[0]!.error!, /predates evidence-retention/);
  } finally {
    await f.cleanup();
  }
});

test("missed named role gets one bounded retry, other model claims cannot escape it", async () => {
  const f = await fixture(false, false, undefined, page, (call) => {
    const q = output();
    if (call === 2) {
      q.gates.investmentRole = {
        status: "supported",
        evidence: page.text,
        url,
      };
      q.gates.ticket = {
        status: "supported",
        evidence: "Invented allocation EUR50,000",
        url,
      };
    }
    return q;
  });
  try {
    const job = f.worker.list()[0]!;
    assert.equal(job.state, "complete");
    assert.equal(f.turns, 2);
    assert.equal(f.writes, 1);
    const audit = job.results[0].evidenceAudit;
    assert.equal(audit.attempts.length, 2);
    assert.equal(audit.attempts[1].accepted.investmentRole.status, "supported");
    assert.equal(audit.attempts[1].accepted.ticket.status, "unknown");
    assert.ok(audit.excerpts[0].text.includes("Jane Smith"));
    assert.equal("evidenceAudit" in f.worker.status()[0]!.results[0], false);
    assert.equal("evidenceAudit" in f.worker.status()[0]!, false);
  } finally {
    await f.cleanup();
  }
});
test("role retry does not manufacture evidence or loop on another unknown", async () => {
  const f = await fixture(false, false, undefined, page, (call) => {
    const q = output();
    if (call === 2)
      q.gates.investmentRole = {
        status: "supported",
        evidence: "Jane Smith Chief Investment Officer",
        url,
      };
    return q;
  });
  try {
    const job = f.worker.list()[0]!;
    assert.equal(f.turns, 2);
    assert.equal(
      job.results[0].evidenceAudit.attempts[1].accepted.investmentRole.status,
      "unknown",
    );
    assert.equal(job.state, "complete");
  } finally {
    await f.cleanup();
  }
});
test("role retry source selection excludes other people, history, and navigation", () => {
  const p = (text: string) => ({ ...page, text });
  assert.deepEqual(
    roleRetryPages(
      [p("Jane Smith was Chief Investment Officer")],
      "Jane Smith",
    ),
    [],
  );
  assert.deepEqual(
    roleRetryPages([p("John Smith Chief Investment Officer")], "Jane Smith"),
    [],
  );
  assert.deepEqual(
    roleRetryPages([p("Jane Smith Contact About Services")], "Jane Smith"),
    [],
  );
  const jacob = p(
    "Navigation ".repeat(500) +
      "JACOB HODES Managing Partner of Private Investments",
  );
  assert.ok(
    roleRetryPages([jacob], "Jacob Hodes")[0]!.text.includes(
      "JACOB HODES Managing Partner",
    ),
  );
});
