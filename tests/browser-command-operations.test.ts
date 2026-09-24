import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BrowserCommandJournal } from "../apps/remote-web/command-history-operations.js";
import {
  BrowserCommandHistory,
  type CommandHistory,
} from "../modules/remote/browser-command-history.js";
const epoch = Date.parse("2026-09-24T09:00:00Z");
function fixture() {
  let now = epoch,
    allow = true,
    readFault = false,
    reserveFault = false;
  const ownerId = randomUUID(),
    command = {
      id: randomUUID(),
      deviceId: randomUUID(),
      taskId: randomUUID(),
      command: "pause" as const,
      expectedRevision: 2,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 300000).toISOString(),
    };
  let state: CommandHistory = { version: 1, ownerId, revision: 0, entries: [] };
  const events: string[] = [];
  const check = () => {
    if (!allow) throw Error("DENIED");
  };
  // Fault injection at persistence/network boundaries, independent of the actual
  // IndexedDB tests. Each operation records when its side effect became possible.
  const history = {
    async read() {
      events.push("read");
      if (readFault) throw Error("STORAGE_UNAVAILABLE");
      return structuredClone(state);
    },
    async reserve(_owner: string, revision: number, value: typeof command) {
      events.push("reserve");
      if (reserveFault) throw Error("STORAGE_UNAVAILABLE");
      assert.equal(revision, state.revision);
      if (!state.entries.length)
        state = {
          ...state,
          revision: state.revision + 1,
          entries: [{ command: value, savedAt: now, observation: null }],
        };
      return structuredClone(state);
    },
    async observe(_owner: string, revision: number, id: string, value: any) {
      events.push("observe");
      assert.equal(revision, state.revision);
      assert.equal(id, command.id);
      state = {
        ...state,
        revision: state.revision + 1,
        entries: state.entries.map((e) => ({
          ...e,
          observation: { at: now, value },
        })),
      };
      return structuredClone(state);
    },
  } as unknown as BrowserCommandHistory;
  return {
    ownerId,
    command,
    history,
    events,
    check,
    state: () => state,
    time: () => now,
    expire: () => (now += 300001),
    deny: () => (allow = false),
    failRead: () => (readFault = true),
    failReserve: () => (reserveFault = true),
  };
}
test("command dispatch never occurs when durable reserve fails and lost HTTP reply retains only original uncertain intent", async () => {
  for (const fail of ["failRead", "failReserve"] as const) {
    const f = fixture();
    f[fail]();
    const j = new BrowserCommandJournal(
      f.history,
      async () => {
        assert.fail("must not dispatch");
      },
      f.time,
    );
    await assert.rejects(
      j.submit(f.ownerId, f.command, f.check),
      /STORAGE_UNAVAILABLE/,
    );
  }
  const f = fixture(),
    j = new BrowserCommandJournal(
      f.history,
      async (path) => {
        f.events.push(path);
        throw Error("UNAVAILABLE");
      },
      f.time,
    );
  await assert.rejects(j.submit(f.ownerId, f.command, f.check), /UNAVAILABLE/);
  assert.deepEqual(f.events, ["read", "reserve", "/browser/commands"]);
  assert.deepEqual(f.state().entries[0]?.command, f.command);
  assert.equal(f.state().entries[0]?.observation, null);
});
test("duplicate submission outcome comes from original receipt, never a fabricated pending state", async () => {
  const f = fixture(),
    receipt = {
      command: f.command,
      state: "acknowledged",
      receipt: {
        id: f.command.id,
        deviceId: f.command.deviceId,
        outcome: "applied",
        completedAt: new Date(epoch).toISOString(),
      },
    };
  const j = new BrowserCommandJournal(
    f.history,
    async (path, body) => {
      f.events.push(path);
      if (path === "/browser/commands") {
        assert.deepEqual(body, { command: f.command, confirmed: true });
        return { duplicate: true, command: f.command };
      }
      assert.deepEqual(body, { id: f.command.id });
      return receipt;
    },
    f.time,
  );
  const saved = await j.submit(f.ownerId, f.command, f.check);
  assert.deepEqual(saved.entries[0]?.observation?.value, receipt);
  const count = f.events.length;
  await assert.rejects(j.submit(f.ownerId, f.command, f.check), /CONFLICT/);
  assert.equal(f.events.length, count + 1);
});
test("scope loss after HTTP dispatch prevents receipt storage and expiry after reserve prevents dispatch", async () => {
  const f = fixture(),
    j = new BrowserCommandJournal(
      f.history,
      async () => {
        f.deny();
        return {};
      },
      f.time,
    );
  await assert.rejects(j.submit(f.ownerId, f.command, f.check), /DENIED/);
  assert.equal(f.state().entries[0]?.observation, null);
  const g = fixture(),
    reserve = g.history.reserve.bind(g.history);
  g.history.reserve = async (...args) => {
    const v = await reserve(...args);
    g.expire();
    return v;
  };
  await assert.rejects(
    new BrowserCommandJournal(
      g.history,
      async () => assert.fail("expired dispatch"),
      g.time,
    ).submit(g.ownerId, g.command, g.check),
  );
});
test("receipt inspection does not resend and stale deletion revision fails before network", async () => {
  const f = fixture();
  await f.history.reserve(f.ownerId, 0, f.command, f.check);
  const j = new BrowserCommandJournal(
    f.history,
    async (path) => {
      assert.equal(path, "/browser/commands/receipt");
      return { command: f.command, state: "pending", receipt: null };
    },
    f.time,
  );
  await assert.rejects(
    j.inspect(f.ownerId, 0, f.command.id, f.check),
    /CONFLICT/,
  );
  await j.inspect(f.ownerId, 1, f.command.id, f.check);
  assert.equal(f.state().entries[0]?.observation?.value.state, "pending");
});
