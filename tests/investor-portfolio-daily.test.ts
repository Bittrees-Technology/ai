import {
  mkdtempSync,
  realpathSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Vault } from "../modules/storage/vault.js";
import { canonical } from "../modules/contracts/canonical-json.js";
import {
  InvestorPortfolioDaily,
  PortfolioDailyJournal,
  portfolioProfiles,
  portfolioDailyAdapters,
} from "../modules/workflows/investor-portfolio-daily.js";
const digest = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
const id = (i: number) =>
  `10000000-0000-4000-a000-${String(i).padStart(12, "0")}`;
const signal = () => new AbortController().signal;
function setup(overrides: any = {}) {
  let now = 100000,
    writes = 0,
    reads = 0,
    denied = false,
    uncertain = false;
  const journal = new PortfolioDailyJournal(
    ":memory:",
    new Vault(randomBytes(32)),
  );
  const data = new Map(
    portfolioProfiles.map((profile, i) => [
      profile,
      {
        id: id(i + 1),
        name: profile,
        version: 1,
        entries: [] as any[],
        crm: [],
        links: [],
      },
    ]),
  );
  const datasets = new Map(
    portfolioProfiles.map((profile, i) => [
      profile,
      {
        id: id(i + 1),
        name: profile,
        client: {
          read: async () => {
            reads++;
            return structuredClone(data.get(profile)!);
          },
          append: async (args: any, expected: string) => {
            writes++;
            const d = data.get(profile)!;
            assert.equal(expected, d.id);
            assert.equal(args.version, d.version);
            d.entries.push(...args.entries);
            d.version++;
            if (uncertain) throw Error("lost response");
            return { id: d.id, version: d.version, added: args.entries.length };
          },
          patch: async (args: any) => {
            writes++;
            const d = data.get(profile)!;
            assert.equal(args.version, d.version);
            assert.deepEqual(args.removeIds, []);
            for (const change of args.changes)
              Object.assign(
                d.entries.find((e: any) => e.id === change.id),
                change,
              );
            d.version++;
            return { id: d.id, version: d.version };
          },
        },
      },
    ]),
  );
  const candidate = {
    identity: "org:fixture.example",
    aliases: ["Fixture Fund"],
    name: "Fixture",
    kind: "organizations",
    profile: portfolioProfiles[0]!,
    datasetId: id(1),
    urls: ["https://fixture.example/team"],
  };
  const options = {
    queue: [candidate],
    hosts: ["fixture.example"],
    modelProfileId: id(99),
    datasets,
    now: () => now,
    authorize: async () => {
      if (denied) throw Error("revoked");
    },
    publicRead: async (url: string) => ({
      url,
      text: "Initial cheque: EUR 50,000. Public business team.",
      sha256: createHash("sha256")
        .update("Initial cheque: EUR 50,000. Public business team.")
        .digest("hex"),
      robotsAllowed: true,
      retrievedAt: now,
    }),
    propose: async (c: any, pages: any[]) => ({
      facts: [
        {
          field: "initial-cheque",
          value: "EUR 50,000",
          quote: "Initial cheque: EUR 50,000.",
          sourceUrl: c.urls[0],
        },
      ],
      modelDigest: "a".repeat(64),
      inputDigest: digest([c, pages]),
      modelProfileId: id(99),
    }),
    ...overrides,
  };
  return {
    daily: new InvestorPortfolioDaily(journal, options),
    journal,
    options,
    data,
    readCount: () => reads,
    writeCount: () => writes,
    deny: () => {
      denied = true;
    },
    uncertain: () => {
      uncertain = true;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}
test("daily preparation and private append use eight private scopes only and never publish", async () => {
  const c = setup();
  try {
    const r = await c.daily.collect(signal(), "slot1");
    assert.equal(r.state, "confirmed");
    assert.equal(c.writeCount(), 0);
    assert.equal(c.readCount(), 8);
    const saved = await c.daily.apply(signal(), "action1");
    assert.equal(saved.state, "confirmed");
    assert.equal((saved.evidence as any).workspacePublished, false);
    assert.equal(c.writeCount(), 1);
    assert.equal(c.data.get(portfolioProfiles[0]!)!.entries.length, 1);
    await c.daily.apply(signal(), "action1");
    assert.equal(c.writeCount(), 1);
  } finally {
    c.journal.close();
  }
});
test("lost append response reconciles actual private entry without mutation retry", async () => {
  const c = setup();
  try {
    await c.daily.collect(signal(), "slot1");
    c.uncertain();
    assert.equal((await c.daily.apply(signal(), "action1")).state, "held");
    const r = await c.daily.collect(signal(), "slot1");
    assert.equal(r.state, "confirmed");
    assert.equal((r.evidence as any).sourceReceipt.reconciledPresence, true);
    assert.equal(c.writeCount(), 1);
  } finally {
    c.journal.close();
  }
});
test("revocation between preparation and save denies all mutations", async () => {
  const c = setup();
  try {
    await c.daily.collect(signal(), "slot1");
    c.deny();
    assert.equal((await c.daily.apply(signal(), "action1")).state, "held");
    assert.equal(c.writeCount(), 0);
  } finally {
    c.journal.close();
  }
});
test("ambiguous aliases across lists hold without append", async () => {
  const c = setup();
  try {
    for (const i of [0, 1])
      c.data.get(portfolioProfiles[i]!)!.entries.push({
        id: id(80 + i),
        kind: "organizations",
        name: "Fixture Fund",
      });
    assert.equal((await c.daily.collect(signal(), "slot1")).state, "held");
    assert.equal(c.writeCount(), 0);
  } finally {
    c.journal.close();
  }
});
test("new duplicate arriving after research holds before mutation", async () => {
  const c = setup();
  try {
    await c.daily.collect(signal(), "slot1");
    c.data.get(portfolioProfiles[1]!)!.entries.push({
      id: id(80),
      kind: "organizations",
      name: "Fixture Fund",
    });
    assert.equal((await c.daily.apply(signal(), "action1")).state, "held");
    assert.equal(c.writeCount(), 0);
  } finally {
    c.journal.close();
  }
});
test("enrichment preserves original ID, name and description and uses fresh version", async () => {
  const c = setup();
  try {
    const d = c.data.get(portfolioProfiles[0]!)!;
    d.entries.push({
      id: id(80),
      kind: "organizations",
      name: "Fixture Fund",
      description: "Original evidence",
    });
    await c.daily.collect(signal(), "slot1");
    d.version = 4;
    await c.daily.apply(signal(), "action1");
    assert.equal(d.entries.length, 1);
    assert.equal(d.entries[0].id, id(80));
    assert.equal(d.entries[0].name, "Fixture Fund");
    assert.match(d.entries[0].description, /^Original evidence/);
    assert.equal(d.version, 5);
  } finally {
    c.journal.close();
  }
});
test("changed description and expired research hold instead of overwrite", async () => {
  for (const expired of [false, true]) {
    const c = setup();
    try {
      const d = c.data.get(portfolioProfiles[0]!)!;
      d.entries.push({
        id: id(80),
        kind: "organizations",
        name: "Fixture Fund",
        description: "Original",
      });
      await c.daily.collect(signal(), "slot1");
      if (expired) c.advance(86400001);
      else d.entries[0].description = "Other owner's change";
      assert.equal((await c.daily.apply(signal(), "action1")).state, "held");
      assert.equal(c.writeCount(), 0);
    } finally {
      c.journal.close();
    }
  }
});
test("linked CRM scope is rejected even when otherwise authorized", async () => {
  const c = setup();
  try {
    c.data.get(portfolioProfiles[0]!)!.crm.push({} as never);
    assert.equal((await c.daily.collect(signal(), "slot1")).state, "held");
    assert.equal(c.writeCount(), 0);
  } finally {
    c.journal.close();
  }
});
test("model instruction-like unsupported facts cannot choose writes or sources", async () => {
  const c = setup({
    propose: async (c: any, pages: any[]) => ({
      facts: [
        {
          field: "business-email",
          value: "guessed@example.com",
          quote: "Initial cheque: EUR 50,000.",
          sourceUrl: c.urls[0],
        },
      ],
      modelDigest: "a".repeat(64),
      inputDigest: digest([c, pages]),
      modelProfileId: id(99),
    }),
  });
  try {
    assert.equal((await c.daily.collect(signal(), "slot1")).state, "held");
    assert.equal(c.writeCount(), 0);
  } finally {
    c.journal.close();
  }
});
test("robots denial, source hash mismatch and private host selectors remain held", async () => {
  for (const extra of [
    { robotsAllowed: false },
    { sha256: "b".repeat(64) },
    { url: "https://127.0.0.1/private" },
  ]) {
    const c = setup({
      publicRead: async (url: string) => ({
        url,
        text: "Initial cheque: EUR 50,000.",
        retrievedAt: 100000,
        sha256: createHash("sha256")
          .update("Initial cheque: EUR 50,000.")
          .digest("hex"),
        robotsAllowed: true,
        ...extra,
      }),
    });
    try {
      assert.equal((await c.daily.collect(signal(), "slot1")).state, "held");
      assert.equal(c.writeCount(), 0);
    } finally {
      c.journal.close();
    }
  }
});

test("unchanged sourced facts do not append repeated daily description blocks", async () => {
  const c = setup();
  try {
    await c.daily.collect(signal(), "slot1");
    await c.daily.apply(signal(), "action1");
    c.advance(1000);
    const r = await c.daily.collect(signal(), "slot2");
    assert.equal(r.state, "confirmed");
    assert.equal((r.evidence as any).sourceReceipt.unchanged, true);
    await c.daily.apply(signal(), "action2");
    assert.equal(c.writeCount(), 1);
  } finally {
    c.journal.close();
  }
});
test("an accepted source receipt without exact entry presence stays uncertain and is not replayed", async () => {
  const c = setup();
  try {
    c.options.datasets.get(portfolioProfiles[0]!)!.client.append =
      async () => ({
        id: id(1),
        version: 2,
        added: 0,
      });
    await c.daily.collect(signal(), "slot1");
    assert.equal((await c.daily.apply(signal(), "action1")).state, "held");
    assert.equal((c.journal.load() as any).phase, "pending");
    const d = new InvestorPortfolioDaily(c.journal, c.options);
    assert.equal((await d.collect(signal(), "slot1")).state, "held");
    assert.equal(c.data.get(portfolioProfiles[0]!)!.entries.length, 0);
  } finally {
    c.journal.close();
  }
});
test("revoked uncertain reconciliation retains pending state for honest later source inspection", async () => {
  const c = setup();
  try {
    await c.daily.collect(signal(), "slot1");
    c.uncertain();
    await c.daily.apply(signal(), "action1");
    c.deny();
    assert.equal((await c.daily.collect(signal(), "slot1")).state, "held");
    assert.equal((c.journal.load() as any).phase, "pending");
    assert.equal(c.writeCount(), 1);
  } finally {
    c.journal.close();
  }
});

test("default registration remains held without touching sources or publishing", async () => {
  const adapter = portfolioDailyAdapters();
  const r = await adapter.collector.read(signal(), "fixture");
  assert.equal(r.state, "held");
  assert.equal((r.evidence as any).workspacePublished, false);
  assert.equal(adapter.collector.decide(r).decision, "escalate");
  assert.equal((await adapter.action.read(signal(), "fixture")).state, "held");
});
test("guarded encrypted journal survives reopen; competing state changes fail atomically", () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "portfolio-journal-")),
    path = join(dir, "state.db"),
    vault = new Vault(randomBytes(32));
  try {
    const a = new PortfolioDailyJournal(path, vault);
    const s = a.save(undefined, {
      revision: 0,
      binding: "a".repeat(64),
      cursor: 0,
      phase: "pending",
      reason: "PRIVATE RESEARCH DATA",
    } as any);
    const b = new PortfolioDailyJournal(path, vault);
    assert.equal(b.load()!.phase, "pending");
    a.save(s, { ...s, cursor: 1 });
    assert.throws(() => b.save(s, { ...s, cursor: 2 }), /owner state changed/);
    b.close();
    a.close();
    assert.equal(
      readFileSync(path).includes(Buffer.from("PRIVATE RESEARCH DATA")),
      false,
    );
    const foreign = join(dir, "foreign.db");
    writeFileSync(foreign, "do not initialize", { mode: 0o600 });
    assert.throws(() => new PortfolioDailyJournal(foreign, vault));
    assert.equal(readFileSync(foreign, "utf8"), "do not initialize");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("fund and LP commitment figures cannot be labelled an initial cheque", async () => {
  const text = "Fund size EUR 50,000; LP minimum commitment EUR 50,000.";
  const c = setup({
    publicRead: async (url: string) => ({
      url,
      text,
      sha256: createHash("sha256").update(text).digest("hex"),
      robotsAllowed: true,
      retrievedAt: 100000,
    }),
    propose: async (c: any, pages: any[]) => ({
      facts: [
        {
          field: "initial-cheque",
          value: "EUR 50,000",
          quote: text,
          sourceUrl: c.urls[0],
        },
      ],
      modelDigest: "a".repeat(64),
      inputDigest: digest([c, pages]),
      modelProfileId: id(99),
    }),
  });
  try {
    assert.equal((await c.daily.collect(signal(), "slot1")).state, "held");
    assert.equal(c.writeCount(), 0);
  } finally {
    c.journal.close();
  }
});

test("aborted noncooperating private mutation remains pending without replay", async () => {
  const c = setup();
  try {
    await c.daily.collect(signal(), "slot1");
    let calls = 0;
    let started: () => void = () => {};
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    c.options.datasets.get(portfolioProfiles[0]!)!.client.append = async () => {
      calls++;
      started();
      return await new Promise<any>(() => {});
    };
    const controller = new AbortController();
    const run = c.daily.apply(controller.signal, "action1");
    await began;
    controller.abort();
    assert.equal((await run).state, "held");
    assert.equal(c.journal.load()!.phase, "pending");
    await c.daily.apply(signal(), "action1");
    assert.equal(calls, 1);
  } finally {
    c.journal.close();
  }
});

test("historical occurrence IDs remain durable after later cursor advancement", async () => {
  const c = setup();
  try {
    await c.daily.collect(signal(), "slot1");
    await c.daily.apply(signal(), "action1");
    await c.daily.collect(signal(), "slot2");
    const before = c.readCount();
    assert.equal((await c.daily.collect(signal(), "slot1")).state, "held");
    assert.equal(c.readCount(), before);
    assert.equal(c.writeCount(), 1);
    assert.equal(c.journal.seen("action", "action1"), true);
  } finally {
    c.journal.close();
  }
});
