import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChatOperationJournal,
  createChatMonitorCollector,
  chatPublicChecks,
  type ChatAuthority,
  type ChatSourceTransport,
} from "../modules/workflows/recurring-chat-source.js";
const revision = "a".repeat(64),
  signal = () => new AbortController().signal;
const good = () =>
  new Response(
    JSON.stringify({
      readiness: { syncReady: true, gateReady: false, releaseReady: false },
    }),
    { headers: { "content-type": "application/json" } },
  );
function setup(
  opts: {
    authority?: ChatAuthority;
    transport?: ChatSourceTransport;
    journal?: ChatOperationJournal;
    enabled?: boolean;
    revision?: string;
  } = {},
) {
  let calls = 0,
    at = 100000;
  const journal = opts.journal ?? new ChatOperationJournal(":memory:");
  const options = {
    enabled: true,
    workflowId: "fixture-chat",
    revision,
    journal,
    authority: async () => "authorized" as const,
    transport: async () => {
      calls++;
      return good();
    },
    now: () => at,
    ...opts,
  };
  return {
    journal,
    collector: createChatMonitorCollector(options),
    options,
    calls: () => calls,
    advance: () => {
      at += 30000;
    },
  };
}
test("disabled and unresolved interfaces never request", async () => {
  assert.equal(
    (await createChatMonitorCollector().read(signal(), "occurrence")).state,
    "held",
  );
  const c = setup({ enabled: false });
  await c.collector.read(signal(), "occurrence");
  assert.equal(c.calls(), 0);
  c.journal.close();
  assert.equal(
    (
      await createChatMonitorCollector({ enabled: true }).read(
        signal(),
        "occurrence",
      )
    ).state,
    "held",
  );
});
for (const state of ["unresolved", "revoked"] as const)
  test(`${state} authority denies dispatch`, async () => {
    const c = setup({ authority: async () => state });
    await c.collector.read(signal(), "occurrence");
    assert.equal(c.calls(), 0);
    c.journal.close();
  });
test("exact frozen scope; public success never accepts Acer", async () => {
  const seen: string[] = [];
  const c = setup({
    transport: async (check, s) => {
      seen.push(check.url);
      assert.ok(Object.isFrozen(check));
      assert.equal(check.method, "GET");
      assert.equal(check.redirect, "error");
      assert.equal(check.credentials, "omit");
      assert.equal(check.timeoutMs, 15000);
      assert.ok(!s.aborted);
      return good();
    },
  });
  const r = await c.collector.read(signal(), "occurrence");
  const e = r.evidence as any;
  assert.deepEqual(
    seen,
    chatPublicChecks.map((c) => c.url),
  );
  assert.equal(e.publicAvailabilityPassed, true);
  assert.equal(e.checks[0].gateReady, false);
  assert.equal(e.monitoringAccepted, false);
  assert.equal(e.acer, "unresolved");
  assert.equal(r.state, "held");
  assert.equal(r.objectiveComplete, false);
  c.journal.close();
});
test("cached results recheck authority and retain original time", async () => {
  let active = true;
  const c = setup({
    authority: async () => (active ? "authorized" : "revoked"),
  });
  await c.collector.read(signal(), "occurrence");
  c.advance();
  const cached = await c.collector.read(signal(), "occurrence");
  assert.equal(c.calls(), 2);
  assert.equal((cached.evidence as any).checks[0].observedAt, 100000);
  active = false;
  assert.equal(
    ((await c.collector.read(signal(), "occurrence")).evidence as any).reason,
    "authority_held",
  );
  assert.equal(c.calls(), 2);
  c.journal.close();
});
test("revocation after reservation leaves pending without replay", async () => {
  let active = true,
    n = 0;
  const c = setup({
    authority: async () => (active && ++n === 1 ? "authorized" : "revoked"),
  });
  await c.collector.read(signal(), "occurrence");
  assert.equal(c.calls(), 0);
  c.options.authority = async () => "authorized";
  assert.equal(
    ((await c.collector.read(signal(), "occurrence")).evidence as any).reason,
    "uncertain_attempt",
  );
  assert.equal(c.calls(), 0);
  c.journal.close();
});
test("revocation during response prevents settlement", async () => {
  let active = true;
  const c = setup({
    authority: async () => (active ? "authorized" : "revoked"),
    transport: async () => {
      active = false;
      return good();
    },
  });
  assert.equal(
    ((await c.collector.read(signal(), "occurrence")).evidence as any).reason,
    "authority_held",
  );
  active = true;
  assert.equal(
    ((await c.collector.read(signal(), "occurrence")).evidence as any).reason,
    "uncertain_attempt",
  );
  c.journal.close();
});
test("retry waits 30s and caps at two across SQLite reopen", async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "chat-journal-")),
    path = join(dir, "test.db");
  let calls = 0;
  try {
    const c = setup({
      journal: new ChatOperationJournal(path),
      transport: async () => {
        calls++;
        return new Response("", { status: 503 });
      },
    });
    await c.collector.read(signal(), "occurrence");
    assert.equal(calls, 2);
    await c.collector.read(signal(), "occurrence");
    assert.equal(calls, 2);
    c.advance();
    await c.collector.read(signal(), "occurrence");
    assert.equal(calls, 4);
    c.journal.close();
    const d = setup({
      journal: new ChatOperationJournal(path),
      transport: async () => {
        calls++;
        return good();
      },
    });
    await d.collector.read(signal(), "occurrence");
    assert.equal(calls, 4);
    d.journal.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("same operation cannot change revision", async () => {
  const c = setup();
  await c.collector.read(signal(), "occurrence");
  c.options.revision = "b".repeat(64);
  assert.equal(
    ((await c.collector.read(signal(), "occurrence")).evidence as any).reason,
    "source_or_journal_held",
  );
  assert.equal(c.calls(), 2);
  c.journal.close();
});
for (const [name, response] of [
  [
    "oversize",
    () =>
      new Response(" ".repeat(16385), {
        headers: { "content-type": "application/json" },
      }),
  ],
  [
    "malformed",
    () =>
      new Response("{", { headers: { "content-type": "application/json" } }),
  ],
  ["wrong content type", () => new Response("{}")],
  [
    "redirected",
    () => {
      const r = good();
      Object.defineProperty(r, "redirected", { value: true });
      return r;
    },
  ],
] as const)
  test(name, async () => {
    const c = setup({ transport: async () => response() });
    assert.equal(
      ((await c.collector.read(signal(), "occurrence")).evidence as any)
        .publicAvailabilityPassed,
      false,
    );
    c.journal.close();
  });
test("Mail body never read", async () => {
  const c = setup({
    transport: async (check) =>
      check.id === "chat_public"
        ? good()
        : ({
            status: 200,
            redirected: false,
            body: {
              getReader() {
                throw Error("forbidden");
              },
              async cancel() {},
            },
          } as unknown as Response),
  });
  assert.equal(
    ((await c.collector.read(signal(), "occurrence")).evidence as any)
      .publicAvailabilityPassed,
    true,
  );
  c.journal.close();
});
test("abort interrupts a noncooperating transport", async () => {
  const controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const c = setup({
    transport: async () => {
      entered();
      return new Promise<Response>(() => {});
    },
  });
  const result = c.collector.read(controller.signal, "occurrence");
  await started;
  controller.abort();
  assert.equal((await result).state, "held");
  c.journal.close();
});
test("pending reservation survives actual reopen", () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "chat-pending-")),
    path = join(dir, "test.db"),
    op = "c".repeat(64);
  try {
    let j = new ChatOperationJournal(path);
    j.reserve(op, revision, "chat_public", 100000);
    j.close();
    j = new ChatOperationJournal(path);
    assert.equal(j.load(op, revision, "chat_public")?.state, "pending");
    assert.throws(() => j.reserve(op, revision, "chat_public", 200000));
    j.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("authority gets exact workflow, revision, operation and fixed scope", async () => {
  const c = setup({
    authority: async (context) => {
      assert.equal(context.workflowId, "fixture-chat");
      assert.equal(context.revision, revision);
      assert.equal(context.operationId, "occurrence");
      assert.ok(chatPublicChecks.some((c) => c === context.check));
      return "authorized";
    },
  });
  await c.collector.read(signal(), "occurrence");
  c.journal.close();
});
test("journal reservation failure prevents transport", async () => {
  const c = setup();
  c.options.journal.reserve = () => {
    throw Error("full");
  };
  await c.collector.read(signal(), "occurrence");
  assert.equal(c.calls(), 0);
  c.journal.close();
});

test("sync readiness and boolean flags are required", async () => {
  for (const readiness of [
    { syncReady: false, gateReady: true, releaseReady: true },
    { syncReady: true, gateReady: "true", releaseReady: true },
    { syncReady: true, gateReady: true },
  ]) {
    const c = setup({
      transport: async () =>
        new Response(JSON.stringify({ readiness }), {
          headers: { "content-type": "application/json" },
        }),
    });
    assert.equal(
      ((await c.collector.read(signal(), "occurrence")).evidence as any)
        .publicAvailabilityPassed,
      false,
    );
    c.journal.close();
  }
});
test("noncooperating transport hits 15-second per-check deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const c = setup({ transport: async () => new Promise<Response>(() => {}) });
  const result = c.collector.read(signal(), "occurrence");
  for (let n = 0; n < 6; n++) {
    for (let k = 0; k < 12; k++) await Promise.resolve();
    t.mock.timers.tick(15000);
  }
  assert.equal(
    ((await result).evidence as any).publicAvailabilityPassed,
    false,
  );
  c.journal.close();
});
