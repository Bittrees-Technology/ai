import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Vault } from "../modules/storage/vault.js";
import {
  RecurringWorkflows,
  type RecurringDefinition,
  type RecurringHost,
  type RecurringReceipt,
} from "../modules/workflows/recurring.js";
import {
  parseRecurringSchedule,
  recurringSlot,
} from "../modules/workflows/recurring-schedule.js";

const start = Date.parse("2026-10-18T09:00:00Z");
const definition = (
  change: Partial<RecurringDefinition> = {},
): RecurringDefinition => ({
  id: "test-workflow",
  name: "Recurring local monitor",
  instructions: "PRIVATE OWNER INSTRUCTIONS",
  executionBrief: "Check the approved source and wait when unchanged.",
  rrule: "FREQ=MINUTELY;INTERVAL=5",
  timezone: "Europe/Lisbon",
  anchor: start,
  sourceFingerprint: "a".repeat(64),
  originalState: "active",
  modelProfileId: randomUUID(),
  collect: { id: "inspect", capability: "test.read", arguments: {} },
  actions: [
    { id: "repair", capability: "test.write", arguments: { bounded: true } },
  ],
  mode: "monitor",
  additionalSpendingUSD: 0,
  ...change,
});
function setup(t: any, overrides: Partial<RecurringHost> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "bittrees-recurring-test-"));
  let now = start,
    executes = 0,
    decisions = 0;
  const calls: string[] = [];
  const receipt = (): RecurringReceipt => ({
    state: "confirmed",
    observedAt: now,
    fingerprint: "b".repeat(64),
    evidence: { state: "healthy" },
  });
  const host: RecurringHost = {
    admission: () => true,
    authorize: async (_d, operation) => {
      calls.push("authorize:" + operation.id);
    },
    sourcePaused: async () => true,
    execute: async (_d, operation) => {
      executes++;
      calls.push("execute:" + operation.id);
      return receipt();
    },
    decide: async () => {
      decisions++;
      return { decision: "wait", summary: "Nothing needs changing" };
    },
    ...overrides,
  };
  const path = join(directory, "state.db"),
    vault = new Vault(randomBytes(32));
  let engine = new RecurringWorkflows(path, vault, host, () => now);
  t.after(async () => {
    await engine.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get engine() {
      return engine;
    },
    host,
    calls,
    path,
    receipt,
    get executes() {
      return executes;
    },
    get decisions() {
      return decisions;
    },
    advance() {
      now += 300000;
    },
    async reopen() {
      await engine.close();
      engine = new RecurringWorkflows(path, vault, host, () => now);
    },
    async ready(d = definition()) {
      const state = engine.review([d])[0]!;
      engine.approve(d.id, state.revision, true);
      await engine.verify(d.id);
      await engine.enable(d.id, state.revision);
      now += 300000;
      return state;
    },
  };
}

test("daily civil slot runs once across Lisbon autumn DST", () => {
  const anchor = Date.parse("2026-10-18T00:00:00Z"),
    r = "FREQ=DAILY;BYHOUR=1;BYMINUTE=15;BYSECOND=0";
  assert.equal(
    recurringSlot(
      r,
      "Europe/Lisbon",
      anchor,
      Date.parse("2026-10-25T00:30:00Z"),
    ),
    "civil:2026-10-25",
  );
  assert.equal(
    recurringSlot(
      r,
      "Europe/Lisbon",
      anchor,
      Date.parse("2026-10-25T01:30:00Z"),
    ),
    "civil:2026-10-25",
  );
});
test("weekly schedules preserve weekday, timezone and interval", () => {
  const anchor = Date.parse("2026-10-18T08:00:00Z"),
    r = "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0;BYSECOND=0";
  assert.equal(
    recurringSlot(
      r,
      "Europe/Lisbon",
      anchor,
      Date.parse("2026-10-19T07:59:00Z"),
    ),
    null,
  );
  assert.equal(
    recurringSlot(
      r,
      "Europe/Lisbon",
      anchor,
      Date.parse("2026-10-19T08:00:00Z"),
    ),
    "civil:2026-10-19",
  );
  assert.equal(
    recurringSlot(
      r,
      "Europe/Lisbon",
      anchor,
      Date.parse("2026-10-20T08:00:00Z"),
    ),
    null,
  );
});
test("unknown, duplicate and invalid schedule fields are rejected", () => {
  for (const r of [
    "FREQ=DAILY;UNTIL=20270101",
    "FREQ=HOURLY;INTERVAL=0",
    "FREQ=DAILY;BYHOUR=24",
    "FREQ=WEEKLY;BYDAY=XX",
    "FREQ=DAILY;FREQ=HOURLY",
  ])
    assert.throws(() => parseRecurringSchedule(r));
});
test("elapsed schedules retain source anchor and coalesce missed periods", () => {
  assert.equal(
    recurringSlot(
      "FREQ=MINUTELY;INTERVAL=5",
      "Europe/Lisbon",
      start,
      start + 86400000,
    ),
    "elapsed:288",
  );
  assert.equal(
    recurringSlot(
      "FREQ=HOURLY;INTERVAL=1",
      "Europe/Lisbon",
      start,
      start + 3599999,
    ),
    "elapsed:0",
  );
});
test("import is inactive, encrypted and cannot run without exact approval", async (t) => {
  const s = setup(t);
  const state = s.engine.review([definition()])[0]!;
  await s.engine.tick();
  assert.equal(s.executes, 0);
  assert.equal(state.enabled, false);
  assert.throws(() => s.engine.approve(state.id, "wrong", true));
  await assert.rejects(s.engine.enable(state.id, state.revision));
  assert.equal(
    readFileSync(s.path).includes(Buffer.from("PRIVATE OWNER INSTRUCTIONS")),
    false,
  );
});
test("active source schedule prevents local cutover", async (t) => {
  const s = setup(t, { sourcePaused: async () => false });
  const d = definition();
  const state = s.engine.review([d])[0]!;
  s.engine.approve(d.id, state.revision, true);
  await s.engine.verify(d.id);
  await assert.rejects(s.engine.enable(d.id, state.revision), /Original/);
  assert.equal(s.engine.status()[0]!.enabled, false);
});
test("previously paused tasks remain paused", async (t) => {
  const s = setup(t);
  const d = definition({ originalState: "paused" });
  const state = s.engine.review([d])[0]!;
  s.engine.approve(d.id, state.revision, true);
  await s.engine.verify(d.id);
  await assert.rejects(s.engine.enable(d.id, state.revision));
});
test("one slot executes once across repeated ticks and process restart", async (t) => {
  const s = setup(t);
  await s.ready();
  const initial = s.executes;
  await Promise.all([s.engine.tick(), s.engine.tick()]);
  assert.equal(s.executes, initial + 1);
  await s.reopen();
  await s.engine.tick();
  assert.equal(s.executes, initial + 1);
  s.advance();
  await s.engine.tick();
  assert.equal(s.executes, initial + 2);
});
test("not-yet-due task cannot starve a later due task", async (t) => {
  const s = setup(t);
  const future = definition({
    id: "aaa-future",
    rrule: "FREQ=DAILY;BYHOUR=23",
  });
  const ready = definition({ id: "bbb-ready" });
  const states = s.engine.review([future, ready]);
  for (const state of states) {
    s.engine.approve(state.id, state.revision, true);
    await s.engine.verify(state.id);
    await s.engine.enable(state.id, state.revision);
  }
  s.advance();
  await s.engine.tick();
  assert.equal(
    s.engine.status().find((d) => d.id === "bbb-ready")?.status,
    "waiting",
  );
});
test("zero-cost or current source authority denial prevents execution", async (t) => {
  const s = setup(t);
  await s.ready();
  const before = s.executes;
  s.host.authorize = async () => {
    throw Error("Cost unverified");
  };
  await s.engine.tick();
  assert.equal(s.executes, before);
  assert.ok(s.engine.status()[0]!.exception);
});
test("model cannot invent an operation or expand its arguments", async (t) => {
  const s = setup(t, {
    decide: async () => ({
      decision: "act",
      actionId: "arbitrary-shell",
      summary: "Run unapproved code",
    }),
  });
  await s.ready();
  await s.engine.tick();
  assert.equal(s.calls.filter((c) => c === "execute:repair").length, 0);
  assert.equal(s.engine.status()[0]!.status, "needs-attention");
});
test("source is reauthorized immediately before a selected action", async (t) => {
  const s = setup(t, {
    decide: async () => ({
      decision: "act",
      actionId: "repair",
      summary: "Use the reviewed repair",
    }),
  });
  await s.ready();
  s.calls.length = 0;
  await s.engine.tick();
  assert.deepEqual(s.calls, [
    "authorize:inspect",
    "execute:inspect",
    "authorize:repair",
    "execute:repair",
  ]);
});
test("revocation during local reasoning fences the subsequent action", async (t) => {
  const s = setup(t);
  await s.ready();
  s.host.decide = async () => {
    s.engine.revoke("test-workflow");
    return { decision: "act", actionId: "repair", summary: "Late result" };
  };
  await s.engine.tick();
  assert.equal(s.calls.includes("execute:repair"), false);
  assert.equal(s.engine.status()[0]!.status, "revoked");
});
test("pause while enable is checking source cannot be undone by late continuation", async (t) => {
  const s = setup(t);
  const d = definition();
  const state = s.engine.review([d])[0]!;
  s.engine.approve(d.id, state.revision, true);
  await s.engine.verify(d.id);
  s.host.sourcePaused = async () => {
    s.engine.pause(d.id);
    return true;
  };
  await assert.rejects(s.engine.enable(d.id, state.revision));
  assert.equal(s.engine.status()[0]!.enabled, false);
});
test("uncertain mutation survives restart and is never blindly repeated", async (t) => {
  const s = setup(t, {
    decide: async () => ({
      decision: "act",
      actionId: "repair",
      summary: "Reviewed action",
    }),
  });
  await s.ready();
  let actions = 0;
  s.host.execute = async (_d, op) => {
    if (op.id === "repair") {
      actions++;
      throw Error("Reply lost after source accepted");
    }
    return s.receipt();
  };
  await s.engine.tick();
  assert.equal(s.engine.status()[0]!.uncertainAction, true);
  await s.reopen();
  s.advance();
  await s.engine.tick();
  assert.equal(actions, 1);
  assert.equal(s.engine.status()[0]!.uncertainAction, true);
});
test("same evidence deduplicates exception despite changing model wording", async (t) => {
  let count = 0;
  const s = setup(t, {
    decide: async () => ({
      decision: "escalate",
      summary: "Need help " + ++count,
    }),
  });
  await s.ready();
  await s.engine.tick();
  const first = s.engine.status()[0]!.exception!.id;
  s.advance();
  await s.engine.tick();
  assert.equal(s.engine.status()[0]!.exception!.id, first);
});
test("only source-confirmed finite objective may automatically complete", async (t) => {
  const s = setup(t);
  await s.ready(definition({ mode: "finite" }));
  s.host.execute = async () => ({ ...s.receipt(), objectiveComplete: true });
  await s.engine.tick();
  assert.equal(s.engine.status()[0]!.status, "completed");
  assert.equal(s.decisions, 0);
});
test("duplicate imports fail atomically and active definitions cannot be overwritten", async (t) => {
  const s = setup(t);
  const d = definition();
  assert.throws(() => s.engine.review([d, d]));
  assert.equal(s.engine.status().length, 0);
  await s.ready(d);
  assert.throws(() =>
    s.engine.review([{ ...d, instructions: "Changed scope" }]),
  );
});
