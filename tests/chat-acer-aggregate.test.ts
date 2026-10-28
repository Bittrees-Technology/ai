import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acerFresh,
  parseAcerAggregate,
  type AcerSourceBinding,
  type AcerSourceTransport,
} from "../modules/workflows/chat-acer-aggregate.js";
import {
  ChatOperationJournal,
  createChatMonitorCollector,
  type ChatAuthority,
} from "../modules/workflows/recurring-chat-source.js";
const binding: AcerSourceBinding = {
  sourceId: "acer_chat_mail_aggregate",
  hostIdentitySha256: "1".repeat(64),
  helperSha256: "2".repeat(64),
  contractSha256: "3".repeat(64),
};
const revision = "a".repeat(64),
  workflowId = "fixture-chat",
  signal = () => new AbortController().signal;
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const report = () => ({
  version: 1,
  status: "healthy",
  components: [
    {
      component: "inbound",
      status: "healthy",
      reportAgeMs: 1000,
      workerHeartbeatAgeMs: 2000,
    },
    {
      component: "outbound",
      status: "healthy",
      reportAgeMs: 1000,
      workerHeartbeatAgeMs: 2000,
    },
  ],
  readOnly: true,
  workerStarted: false,
  mailSent: false,
});
const encode = (r: unknown) => Buffer.from(JSON.stringify(r));
function setup(
  opts: {
    authority?: ChatAuthority;
    source?: AcerSourceTransport;
    binding?: AcerSourceBinding;
    journal?: ChatOperationJournal;
    enabled?: boolean;
    monotonic?: () => number;
  } = {},
) {
  let at = 100000,
    publicCalls = 0,
    privateCalls = 0;
  const journal = opts.journal ?? new ChatOperationJournal(":memory:");
  const options = {
    enabled: opts.enabled ?? true,
    workflowId,
    revision,
    journal,
    now: () => at,
    monotonic: opts.monotonic,
    authority: opts.authority ?? (async () => "authorized" as const),
    transport: async () => {
      publicCalls++;
      return new Response(
        JSON.stringify({
          readiness: { syncReady: true, gateReady: false, releaseReady: false },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
    acer: {
      binding: opts.binding ?? binding,
      transport: async (
        check: Parameters<AcerSourceTransport>[0],
        s: AbortSignal,
      ) => {
        privateCalls++;
        return opts.source
          ? opts.source(check, s)
          : { exitCode: 0, output: encode(report()) };
      },
    },
  };
  return {
    journal,
    options,
    collector: createChatMonitorCollector(options),
    publicCalls: () => publicCalls,
    privateCalls: () => privateCalls,
    advance: (ms: number) => {
      at += ms;
    },
  };
}
for (const value of [0, 300000])
  test(`independent inclusive age bound ${value}`, () => {
    const r = report();
    for (const c of r.components) {
      c.reportAgeMs = value;
      c.workerHeartbeatAgeMs = value;
    }
    assert.equal(acerFresh(parseAcerAggregate(encode(r), 0), 0), true);
  });
for (const field of ["reportAgeMs", "workerHeartbeatAgeMs"] as const)
  for (const bad of [
    -1,
    0.5,
    300001,
    "1000",
    true,
    Number.MAX_SAFE_INTEGER + 1,
    null,
  ])
    test(`healthy ${field} rejects ${bad}`, () => {
      const r = report();
      (r.components[0] as any)[field] = bad;
      assert.throws(() => parseAcerAggregate(encode(r), 0));
    });
test("double-cache counterexample cannot appear healthy", () => {
  const r = report();
  r.components[0]!.reportAgeMs = 240000;
  r.components[0]!.workerHeartbeatAgeMs = 480000;
  assert.throws(() => parseAcerAggregate(encode(r), 0));
  r.components[0]!.status = "degraded";
  r.status = "degraded";
  assert.equal(acerFresh(parseAcerAggregate(encode(r), 2), 0), false);
});
for (const mutate of [
  (r: any) => r.components.pop(),
  (r: any) => r.components.push({ ...r.components[0] }),
  (r: any) => (r.components[1].component = "inbound"),
  (r: any) => (r.components[1].component = "foreign"),
  (r: any) => (r.components[0].status = "disabled"),
  (r: any) => delete r.components[0].reportAgeMs,
  (r: any) => delete r.components[0].workerHeartbeatAgeMs,
  (r: any) => (r.readOnly = false),
  (r: any) => (r.workerStarted = true),
  (r: any) => (r.mailSent = true),
  (r: any) => (r.version = 2),
])
  test("incomplete/contradictory aggregate is rejected", () => {
    const r = report();
    mutate(r);
    assert.throws(() => parseAcerAggregate(encode(r), 0));
  });
for (const key of [
  "body",
  "wallet",
  "mailbox",
  "eventId",
  "invocationId",
  "privateKey",
])
  test(`private field ${key} is rejected without echo`, () => {
    for (const nested of [false, true]) {
      const r: any = report();
      (nested ? r.components[0] : r)[key] = "private_sentinel";
      assert.throws(
        () => parseAcerAggregate(encode(r), 0),
        (e) => e instanceof Error && !e.message.includes("private_sentinel"),
      );
    }
  });
test("free-form reason cannot carry private data", () => {
  const r: any = report();
  r.components[0].reason = "private_sentinel";
  assert.throws(() => parseAcerAggregate(encode(r), 0));
});
test("bounded UTF8 and matching exit code required", () => {
  assert.throws(() => parseAcerAggregate(Buffer.alloc(4097), 0));
  assert.throws(() => parseAcerAggregate(Buffer.from([255]), 0));
  assert.throws(() => parseAcerAggregate(encode(report()), 2));
  assert.throws(() => parseAcerAggregate(encode(report()), 1));
  const bytes = encode(report());
  assert.doesNotThrow(() =>
    parseAcerAggregate(
      Buffer.concat([bytes, Buffer.alloc(4096 - bytes.length, 32)]),
      0,
    ),
  );
});
for (const status of ["disabled", "degraded", "unavailable"])
  test(`${status} never becomes healthy`, async () => {
    const r: any = report();
    r.status = status;
    r.components = r.components.map((c: any) => ({
      component: c.component,
      status,
      ...(status === "disabled" ? { reason: "timer_not_enabled_active" } : {}),
    }));
    assert.equal(acerFresh(parseAcerAggregate(encode(r), 2), 0), false);
    const c = setup({
      source: async () => ({ exitCode: 2, output: encode(r) }),
    });
    const result = await c.collector.read(signal(), "occurrence");
    assert.equal(result.state, "held");
    assert.equal((result.evidence as any).acer.status, status);
    assert.equal((result.evidence as any).aggregateHealthy, false);
    c.journal.close();
  });
test("disabled startup and unresolved/foreign binding cannot dispatch private source", async () => {
  const disabled = setup({ enabled: false });
  await disabled.collector.read(signal(), "occurrence");
  assert.equal(disabled.privateCalls(), 0);
  assert.equal(disabled.publicCalls(), 0);
  disabled.journal.close();
  for (const b of [undefined, { ...binding, host: "selector" } as any]) {
    const c = setup();
    c.options.acer.binding = b as any;
    const r = await c.collector.read(signal(), "occurrence");
    assert.equal((r.evidence as any).acer, "unresolved");
    assert.equal(c.privateCalls(), 0);
    c.journal.close();
  }
});
test("healthy fixture confirms only source observation with fixed frozen binding", async () => {
  const contexts: any[] = [];
  const c = setup({
    authority: async (x) => {
      contexts.push(x);
      return "authorized";
    },
    source: async (check, s) => {
      assert.equal(check.id, "acer_aggregate");
      assert.equal(check.timeoutMs, 22000);
      assert.equal(check.maxBytes, 4096);
      assert.deepEqual(Object.keys(check).sort(), [
        "binding",
        "id",
        "maxBytes",
        "timeoutMs",
      ]);
      assert.ok(Object.isFrozen(check) && Object.isFrozen(check.binding));
      assert.deepEqual(check.binding, binding);
      assert.ok(!s.aborted);
      return { exitCode: 0, output: encode(report()) };
    },
  });
  const r = await c.collector.read(signal(), "occurrence");
  assert.equal(r.state, "confirmed");
  assert.equal(r.objectiveComplete, false);
  assert.equal((r.evidence as any).monitoringAccepted, false);
  assert.equal((r.evidence as any).aggregateHealthy, true);
  assert.equal(contexts.filter((x) => x.phase === "aggregate").length, 3);
  c.journal.close();
});
test("cached Acer ages never refresh and stale healthy occurrence cannot replay", async () => {
  const r = report();
  r.components.forEach((c) => {
    c.reportAgeMs = 295000;
    c.workerHeartbeatAgeMs = 295000;
  });
  const c = setup({ source: async () => ({ exitCode: 0, output: encode(r) }) });
  assert.equal(
    (await c.collector.read(signal(), "occurrence")).state,
    "confirmed",
  );
  c.advance(6000);
  const cached = await c.collector.read(signal(), "occurrence");
  assert.equal(cached.state, "held");
  assert.equal((cached.evidence as any).acer.status, "degraded");
  assert.equal(c.privateCalls(), 1);
  assert.equal(c.publicCalls(), 2);
  c.journal.close();
});
test("transport and final authority latency both count against each age", async () => {
  for (const final of [false, true]) {
    const c = setup({
      source: async () => {
        if (!final) c.advance(299001);
        return { exitCode: 0, output: encode(report()) };
      },
      authority: async (x) => {
        if (final && x.phase === "aggregate" && x.check.id === "acer_aggregate")
          c.advance(299001);
        return "authorized";
      },
    });
    assert.equal(
      (await c.collector.read(signal(), "occurrence")).state,
      "held",
    );
    c.journal.close();
  }
});
test("clock rollback holds cached private evidence", async () => {
  const c = setup();
  await c.collector.read(signal(), "occurrence");
  c.advance(-1);
  assert.equal((await c.collector.read(signal(), "occurrence")).state, "held");
  assert.equal(c.privateCalls(), 1);
  c.journal.close();
});
for (const phase of ["read", "dispatch", "accept", "aggregate"] as const)
  test(`private revocation at ${phase} holds aggregate`, async () => {
    const c = setup({
      authority: async (x) =>
        x.check.id === "acer_aggregate" && x.phase === phase
          ? "revoked"
          : "authorized",
    });
    const r = await c.collector.read(signal(), "occurrence");
    assert.equal((r.evidence as any).reason, "authority_held");
    assert.equal((r.evidence as any).checks, undefined);
    c.journal.close();
  });
test("public revocation at final aggregate suppresses accepted cached private evidence", async () => {
  let revoked = false;
  const c = setup({
    authority: async (x) =>
      revoked && x.phase === "aggregate" && x.check.id === "chat_public"
        ? "revoked"
        : "authorized",
  });
  await c.collector.read(signal(), "occurrence");
  revoked = true;
  const r = await c.collector.read(signal(), "occurrence");
  assert.equal((r.evidence as any).reason, "authority_held");
  assert.equal((r.evidence as any).checks, undefined);
  assert.equal(c.privateCalls(), 1);
  c.journal.close();
});
test("abort during ignored final authority never returns a confirmed receipt", async () => {
  const controller = new AbortController();
  const c = setup({
    authority: async (x) => {
      if (x.phase === "aggregate" && x.check.id === "acer_aggregate")
        controller.abort();
      return "authorized";
    },
  });
  assert.equal(
    (await c.collector.read(controller.signal, "occurrence")).state,
    "held",
  );
  c.journal.close();
});
test("private binding replacement holds old occurrence instead of replay", async () => {
  const c = setup();
  await c.collector.read(signal(), "occurrence");
  c.options.acer.binding = { ...binding, helperSha256: "4".repeat(64) };
  assert.equal(
    ((await c.collector.read(signal(), "occurrence")).evidence as any).reason,
    "source_or_journal_held",
  );
  assert.equal(c.privateCalls(), 1);
  assert.equal(c.publicCalls(), 2);
  c.journal.close();
});
test("pending legacy public operation prevents every new dispatch", async () => {
  const c = setup();
  c.journal.reserve(
    hash([workflowId, "occurrence"]),
    revision,
    "chat_public",
    100000,
  );
  assert.equal(
    ((await c.collector.read(signal(), "occurrence")).evidence as any).reason,
    "uncertain_attempt",
  );
  assert.equal(c.privateCalls(), 0);
  assert.equal(c.publicCalls(), 0);
  c.journal.close();
});
test("legacy public results stay readable but cannot stand in for Acer", async () => {
  const c = setup(),
    op = hash([workflowId, "occurrence"]);
  for (const check of ["chat_public", "mail_public"]) {
    c.journal.reserve(op, revision, check, 100000);
    c.journal.settle(op, revision, check, { available: true });
  }
  assert.equal((await c.collector.read(signal(), "occurrence")).state, "held");
  assert.equal(c.publicCalls(), 0);
  assert.equal(c.privateCalls(), 1);
  c.journal.close();
  const j = new ChatOperationJournal(":memory:");
  j.reserve(op, revision, "acer_aggregate", 100000);
  assert.throws(() =>
    j.settle(op, revision, "acer_aggregate", { available: true }),
  );
  j.close();
});
test("malformed private source never persists raw secret fields", async () => {
  const r: any = report();
  r.privateKey = "private_sentinel";
  const c = setup({ source: async () => ({ exitCode: 0, output: encode(r) }) });
  const result = await c.collector.read(signal(), "occurrence");
  const stored = c.journal.load(
    hash([workflowId, "occurrence"]),
    hash([revision, binding]),
    "acer_aggregate",
  );
  assert.ok(!JSON.stringify([result, stored]).includes("private_sentinel"));
  assert.equal(result.state, "held");
  c.journal.close();
});
test("private journal survives restart and revoked cached access stays held", async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "acer-cache-")),
    path = join(dir, "journal.db");
  try {
    const c = setup({ journal: new ChatOperationJournal(path) });
    await c.collector.read(signal(), "occurrence");
    c.journal.close();
    const d = setup({
      journal: new ChatOperationJournal(path),
      authority: async (x) =>
        x.check.id === "acer_aggregate" ? "revoked" : "authorized",
    });
    assert.equal(
      (await d.collector.read(signal(), "occurrence")).state,
      "held",
    );
    assert.equal(d.privateCalls(), 0);
    assert.equal(d.publicCalls(), 0);
    d.journal.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("private failure retries remain delayed and limited to two", async () => {
  const c = setup({
    source: async () => {
      throw Error("private_sentinel");
    },
  });
  await c.collector.read(signal(), "occurrence");
  await c.collector.read(signal(), "occurrence");
  assert.equal(c.privateCalls(), 1);
  c.advance(30000);
  await c.collector.read(signal(), "occurrence");
  c.advance(30000);
  const r = await c.collector.read(signal(), "occurrence");
  assert.equal(c.privateCalls(), 2);
  assert.ok(!JSON.stringify(r).includes("private_sentinel"));
  c.journal.close();
});
test("private timeout is bounded to 22 seconds even for ignored abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const c = setup({ source: async () => new Promise(() => {}) });
  const pending = c.collector.read(signal(), "occurrence");
  for (let n = 0; n < 8; n++) {
    for (let k = 0; k < 20; k++) await Promise.resolve();
    t.mock.timers.tick(22000);
  }
  assert.equal((await pending).state, "held");
  assert.equal(c.privateCalls(), 1);
  c.journal.close();
});

test("reversed unique components normalize without broadening membership", () => {
  const r = report();
  r.components.reverse();
  assert.deepEqual(
    parseAcerAggregate(encode(r), 0).components.map((c) => c.component),
    ["inbound", "outbound"],
  );
});
test("a healthy status cannot coexist with a disabled reason", () => {
  const r: any = report();
  r.components[0].reason = "timer_not_enabled_active";
  assert.throws(() => parseAcerAggregate(encode(r), 0));
});
test("missing private transport holds even with a valid binding", async () => {
  const c = setup();
  c.options.acer.transport = undefined as any;
  const r = await c.collector.read(signal(), "occurrence");
  assert.equal((r.evidence as any).acer, "unresolved");
  assert.equal(c.privateCalls(), 0);
  c.journal.close();
});
test("pending private occurrence cannot replay under the same or changed binding", async () => {
  for (const changed of [false, true]) {
    const c = setup();
    const op = hash([workflowId, "occurrence"]);
    c.journal.reserve(op, hash([revision, binding]), "acer_aggregate", 100000);
    if (changed)
      c.options.acer.binding = {
        ...binding,
        hostIdentitySha256: "5".repeat(64),
      };
    const r = await c.collector.read(signal(), "occurrence");
    assert.equal(r.state, "held");
    assert.equal(c.privateCalls(), 0);
    c.journal.close();
  }
});
test("current authority is required again before cached aggregate completion", async () => {
  let revoke = false;
  const c = setup({
    authority: async (x) =>
      revoke && x.phase === "aggregate" && x.check.id === "acer_aggregate"
        ? "revoked"
        : "authorized",
  });
  await c.collector.read(signal(), "occurrence");
  revoke = true;
  const r = await c.collector.read(signal(), "occurrence");
  assert.equal((r.evidence as any).reason, "authority_held");
  assert.equal((r.evidence as any).acer, "held");
  assert.equal(c.privateCalls(), 1);
  c.journal.close();
});
test("private result binding digest must match even with an injected journal", async () => {
  const c = setup(),
    op = hash([workflowId, "occurrence"]),
    rev = hash([revision, binding]);
  c.journal.reserve(op, rev, "acer_aggregate", 100000);
  c.journal.settle(op, rev, "acer_aggregate", {
    kind: "acer",
    available: true,
    bindingSha256: "9".repeat(64),
    report: parseAcerAggregate(encode(report()), 0),
  });
  const r = await c.collector.read(signal(), "occurrence");
  assert.equal((r.evidence as any).reason, "acer_binding_held");
  assert.equal(c.privateCalls(), 0);
  c.journal.close();
});
test("private journal result is not accepted in public legacy rows", () => {
  const j = new ChatOperationJournal(":memory:"),
    op = hash([workflowId, "occurrence"]);
  j.reserve(op, revision, "chat_public", 100000);
  assert.throws(() =>
    j.settle(op, revision, "chat_public", {
      kind: "acer",
      available: true,
      bindingSha256: hash(binding),
      report: parseAcerAggregate(encode(report()), 0),
    }),
  );
  j.close();
});

for (const field of ["reportAgeMs", "workerHeartbeatAgeMs"] as const)
  test(`cached ${field} ages independently from the other clock`, async () => {
    const r = report();
    r.components.forEach((c) => {
      c.reportAgeMs = 1000;
      c.workerHeartbeatAgeMs = 1000;
      c[field] = 299000;
    });
    const c = setup({
      source: async () => ({ exitCode: 0, output: encode(r) }),
    });
    assert.equal(
      (await c.collector.read(signal(), "occurrence")).state,
      "confirmed",
    );
    c.advance(1001);
    const result = await c.collector.read(signal(), "occurrence");
    assert.equal(result.state, "held");
    assert.equal((result.evidence as any).acer.available, false);
    assert.equal((result.evidence as any).acer.elapsedMs, 1001);
    assert.equal(c.privateCalls(), 1);
    c.journal.close();
  });
for (const field of [
  "host",
  "account",
  "path",
  "key",
  "args",
  "url",
  "command",
])
  test(`binding cannot select ${field}`, async () => {
    const c = setup();
    c.options.acer.binding = { ...binding, [field]: "selector" } as any;
    const r = await c.collector.read(signal(), "occurrence");
    assert.equal((r.evidence as any).acer, "unresolved");
    assert.equal(c.privateCalls(), 0);
    c.journal.close();
  });

test("duplicate JSON keys and escaped equivalents cannot override source identity", () => {
  const raw = JSON.stringify(report());
  for (const inserted of ['"version":2,', '"vers\\u0069on":2,'])
    assert.throws(() =>
      parseAcerAggregate(Buffer.from("{" + inserted + raw.slice(1)), 0),
    );
  const component = raw.replace(
    '"component":"inbound"',
    '"component":"foreign","component":"inbound"',
  );
  assert.throws(() => parseAcerAggregate(Buffer.from(component), 0));
});
test("JSON structural markers inside strings do not broaden the protocol", () => {
  const r: any = report();
  r.components[0].reason = '} ], "status":"healthy"';
  assert.throws(() => parseAcerAggregate(encode(r), 0));
  assert.throws(() =>
    parseAcerAggregate(Buffer.from("[".repeat(33) + "]".repeat(33)), 0),
  );
});
test("unresolved private authority holds without private dispatch", async () => {
  const c = setup({
    authority: async (x) =>
      x.check.id === "acer_aggregate" ? "unresolved" : "authorized",
  });
  const r = await c.collector.read(signal(), "occurrence");
  assert.equal((r.evidence as any).reason, "authority_held");
  assert.equal(c.privateCalls(), 0);
  c.journal.close();
});

test("positive wall rollback cannot extend the monotonic worker freshness window", async () => {
  let mono = 0;
  const c = setup({ monotonic: () => mono });
  assert.equal(
    (await c.collector.read(signal(), "occurrence")).state,
    "confirmed",
  );
  c.advance(240000);
  mono = 240000;
  assert.equal(
    (await c.collector.read(signal(), "occurrence")).state,
    "confirmed",
  );
  c.advance(-180000);
  mono = 360000;
  const r = await c.collector.read(signal(), "occurrence");
  assert.equal(r.state, "held");
  assert.equal((r.evidence as any).acer.elapsedMs, 360000);
  assert.equal(c.privateCalls(), 1);
  c.journal.close();
});
test("private cached evidence after restart holds instead of replaying", async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "acer-clock-restart-")),
    path = join(dir, "journal.db");
  try {
    const c = setup({ journal: new ChatOperationJournal(path) });
    await c.collector.read(signal(), "occurrence");
    c.journal.close();
    const d = setup({ journal: new ChatOperationJournal(path) });
    const r = await d.collector.read(signal(), "occurrence");
    assert.equal(r.state, "held");
    assert.equal((r.evidence as any).acer.elapsedMs, null);
    assert.equal(d.privateCalls(), 0);
    assert.equal(d.publicCalls(), 0);
    d.journal.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("a decreasing elapsed clock cannot make an old cache younger", async () => {
  let mono = 0;
  const c = setup({ monotonic: () => mono });
  await c.collector.read(signal(), "occurrence");
  c.advance(240000);
  mono = 240000;
  await c.collector.read(signal(), "occurrence");
  c.advance(-180000);
  mono = 60000;
  assert.equal((await c.collector.read(signal(), "occurrence")).state, "held");
  assert.equal(c.privateCalls(), 1);
  c.journal.close();
});

test("fresh private retry cannot revive hour-old public successes", async () => {
  let mono = 0,
    attempts = 0;
  const c = setup({
    monotonic: () => mono,
    source: async () => {
      if (++attempts === 1) throw Error("fixture unavailable");
      return { exitCode: 0, output: encode(report()) };
    },
  });
  assert.equal((await c.collector.read(signal(), "occurrence")).state, "held");
  c.advance(3600000);
  mono = 3600000;
  const r = await c.collector.read(signal(), "occurrence");
  const e = r.evidence as any;
  assert.equal(r.state, "held");
  assert.equal(e.acer.available, true);
  assert.equal(e.publicAvailabilityPassed, false);
  assert.equal(e.aggregateHealthy, false);
  assert.equal(e.monitoringAccepted, false);
  assert.ok(
    e.checks.every(
      (x: any) =>
        x.observedAt === 100000 &&
        x.elapsedMs === 3600000 &&
        x.freshness === "held" &&
        !x.available,
    ),
  );
  assert.equal(c.publicCalls(), 2);
  assert.equal(c.privateCalls(), 2);
  await c.collector.read(signal(), "occurrence");
  assert.equal(c.publicCalls(), 2);
  assert.equal(c.privateCalls(), 2);
  c.journal.close();
});

for (const phase of ["transport", "aggregate"] as const)
  test(`public freshness includes ${phase} latency`, async () => {
    const c = setup({
      authority: async (context) => {
        if (
          phase === "aggregate" &&
          context.phase === "aggregate" &&
          context.check.id === "acer_aggregate"
        )
          c.advance(300001);
        return "authorized";
      },
      source: async () => {
        if (phase === "transport") c.advance(300001);
        return { exitCode: 0, output: encode(report()) };
      },
    });
    const e = (await c.collector.read(signal(), "occurrence")).evidence as any;
    assert.equal(e.publicAvailabilityPassed, false);
    assert.ok(
      e.checks.every((x: any) => x.elapsedMs === 300001 && !x.available),
    );
    assert.equal(c.publicCalls(), 2);
    c.journal.close();
  });

test("public cache without collector clock continuity holds despite a fresh private retry", async () => {
  const c = setup({
    source: async () => {
      throw Error("fixture unavailable");
    },
  });
  await c.collector.read(signal(), "occurrence");
  const d = setup({ journal: c.journal });
  d.advance(30000);
  const e = (await d.collector.read(signal(), "occurrence")).evidence as any;
  assert.equal(e.acer.available, true);
  assert.equal(e.publicAvailabilityPassed, false);
  assert.ok(
    e.checks.every(
      (x: any) =>
        x.elapsedMs === null && x.freshness === "held" && !x.available,
    ),
  );
  assert.equal(d.publicCalls(), 0);
  assert.equal(d.privateCalls(), 1);
  c.journal.close();
});

test("public monotonic age cannot be reset by fresh private evidence after wall rollback", async () => {
  let mono = 0,
    attempts = 0;
  const c = setup({
    monotonic: () => mono,
    source: async () => {
      if (++attempts === 1) throw Error("fixture unavailable");
      return { exitCode: 0, output: encode(report()) };
    },
  });
  await c.collector.read(signal(), "occurrence");
  c.advance(60000);
  mono = 360000;
  const e = (await c.collector.read(signal(), "occurrence")).evidence as any;
  assert.equal(e.acer.available, true);
  assert.equal(e.publicAvailabilityPassed, false);
  assert.ok(e.checks.every((x: any) => x.elapsedMs === 360000 && !x.available));
  assert.equal(c.publicCalls(), 2);
  assert.equal(c.privateCalls(), 2);
  c.journal.close();
});

for (const age of [300000, 300001])
  test(`public age bound is inclusive at ${age}ms`, async () => {
    const c = setup();
    await c.collector.read(signal(), "occurrence");
    c.advance(age);
    const e = (await c.collector.read(signal(), "occurrence")).evidence as any;
    assert.equal(e.publicAvailabilityPassed, age === 300000);
    assert.equal(c.publicCalls(), 2);
    c.journal.close();
  });

test("observed clock uncertainty permanently holds settled public evidence", async () => {
  let mono = 0;
  const c = setup({ monotonic: () => mono });
  await c.collector.read(signal(), "occurrence");
  mono = NaN;
  const uncertain = await c.collector.read(signal(), "occurrence");
  assert.equal((uncertain.evidence as any).publicAvailabilityPassed, false);
  mono = 0;
  const recovered = await c.collector.read(signal(), "occurrence");
  assert.equal((recovered.evidence as any).publicAvailabilityPassed, false);
  assert.equal(c.publicCalls(), 2);
  assert.equal(c.privateCalls(), 1);
  c.journal.close();
});
