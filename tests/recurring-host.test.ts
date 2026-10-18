import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localRecurringHost } from "../modules/workflows/recurring-host.js";
import type { RecurringDefinition } from "../modules/workflows/recurring.js";
import type { Ollama } from "../modules/models/ollama.js";
test("local recurring host bounds source targets and retains model provenance without action authority", async () => {
  const d: RecurringDefinition = {
    id: "monitor",
    name: "Monitor",
    instructions: "Original instruction",
    executionBrief: "Check saved scope.",
    rrule: "FREQ=HOURLY",
    timezone: "Europe/Lisbon",
    anchor: Date.now(),
    sourceFingerprint: "a".repeat(64),
    originalState: "active",
    modelProfileId: randomUUID(),
    collect: {
      id: "local.test",
      capability: "local.test",
      arguments: { sourceAutomationId: "monitor" },
    },
    actions: [],
    mode: "monitor",
    additionalSpendingUSD: 0,
  };
  let read = 0,
    record: any,
    answer = { decision: "wait", summary: "Healthy" };
  const receipt = {
    state: "confirmed" as const,
    evidence: { healthy: true },
    fingerprint: "b".repeat(64),
    observedAt: Date.now(),
  };
  const host = localRecurringHost({
    collectors: new Map([
      [
        "local.test",
        {
          capability: "local.test",
          read: async () => {
            read++;
            return receipt;
          },
        },
      ],
    ]),
    automationRoot: "/nonexistent",
    runtime: {
      pin: async () => ({
        profile: { model: "local" },
        digest: "c".repeat(64),
      }),
      generate: async () => JSON.stringify(answer),
    } as unknown as Ollama,
    profile: () => ({}),
    turn: async (_s, fn) => fn(),
    admission: () => true,
    cutoverReady: () => false,
    recordDecision: (_id, e) => {
      record = e;
    },
  });
  const signal = new AbortController().signal;
  await host.authorize(d, d.collect, signal);
  await host.execute(d, d.collect, "operation", signal);
  assert.equal(read, 1);
  await assert.rejects(
    host.authorize(
      d,
      {
        ...d.collect,
        arguments: {
          sourceAutomationId: "monitor",
          url: "https://remote.example",
        },
      },
      signal,
    ),
  );
  await assert.rejects(
    host.authorize(d, { ...d.collect, id: "arbitrary.command" }, signal),
  );
  assert.equal(await host.sourcePaused(d), false);
  assert.deepEqual(await host.decide(d, receipt, signal), answer);
  assert.equal(record.modelDigest, "c".repeat(64));
  assert.equal(record.sourceFingerprint, receipt.fingerprint);
  assert.match(record.inputHash, /^[a-f0-9]{64}$/);
  answer = { decision: "act", summary: "Run something" };
  await assert.rejects(host.decide(d, receipt, signal));
});
