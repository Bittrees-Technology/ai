import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { conversationTaskAccess } from "../apps/companion/conversation-access.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { MemoryStore } from "../modules/memory/store.js";
import { SourceTasks } from "../modules/connectors/source-tasks.js";
import { CrmConnector } from "../modules/connectors/crm.js";
import { AutoNoteConnector } from "../modules/connectors/autonote.js";
import { MailConnector } from "../modules/connectors/mail.js";

const owner = { userId: "synthetic", tenantId: "personal" };
function fixture() {
  let now = Date.now(),
    monotonic = 100;
  const vault = new Vault(randomBytes(32)),
    store = new Store(":memory:", vault, () => now);
  const memory = new MemoryStore(":memory:", vault, async () => true);
  const task = store.create(
    owner,
    {
      conversationId: "thread",
      kind: "query",
      prompt: "Synthetic",
      modelProfileId: "synthetic",
    },
    "task",
  );
  const access = conversationTaskAccess(
    store,
    owner,
    new SourceTasks(),
    memory,
    () => now,
    () => monotonic,
  );
  return {
    store,
    memory,
    task,
    access,
    advance: (wall: number, mono: number) => {
      now += wall;
      monotonic += mono;
    },
    close: () => {
      store.close();
      memory.close();
    },
  };
}
test("conversation access expires on either clock and rejects backward time", async () => {
  for (const times of [
    [10000, 0],
    [0, 10000],
    [-1, 0],
    [0, -1],
  ]) {
    const f = fixture();
    try {
      const check = await f.access(f.task.id);
      check();
      f.advance(times[0]!, times[1]!);
      assert.throws(check, /SOURCE_DENIED/);
    } finally {
      f.close();
    }
  }
});
test("conversation access binds owner and refuses source reads under a write lock", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      conversationTaskAccess(
        f.store,
        { ...owner, userId: "other" },
        new SourceTasks(),
      )(f.task.id),
      /NOT_FOUND/,
    );
    let pending: ReturnType<typeof f.access> | undefined;
    f.store.db
      .transaction(() => {
        pending = f.access(f.task.id);
      })
      .immediate();
    await assert.rejects(pending!, /SOURCE_DENIED/);
    const check = await f.access(f.task.id);
    f.store.deleteAll(owner);
    assert.throws(check, /NOT_FOUND/);
  } finally {
    f.close();
  }
});
test("conversation access detects task-input and memory changes before commit", async () => {
  for (const change of ["input", "memory"] as const) {
    const f = fixture();
    try {
      const check = await f.access(f.task.id);
      if (change === "input") {
        f.store.addProfile(owner, {
          id: "second",
          runtime: "ollama",
          model: "synthetic",
          contextTokens: 4096,
          maxOutputTokens: 256,
          temperature: 0,
        });
        f.store.switchModel(owner, f.task.id, "second", f.task.revision);
      } else {
        await f.memory.add(owner, {
          type: "fact",
          text: "Synthetic memory",
          origin: "user",
          sources: [
            {
              app: "local",
              tenantId: owner.tenantId,
              resourceId: f.task.id,
              revision: "1",
            },
          ],
        });
      }
      assert.throws(check, /SOURCE_DENIED/);
    } finally {
      f.close();
    }
  }
});
test("all source connectors fence completed mutation attempts, without treating a boundary as authorization", async () => {
  for (const Connector of [CrmConnector, AutoNoteConnector, MailConnector]) {
    const connector = new Connector(
      "synthetic",
      {
        getSecret: async () => undefined,
        setSecret: async () => {},
        deleteCredential: async () => true,
      },
      async () => {
        throw Error("Unexpected network");
      },
    );
    const check = connector.captureReadBoundary();
    await connector.begin();
    assert.throws(check, /SOURCE_DENIED/);
    // A new local fence alone still cannot validate an absent source grant.
    const current = connector.captureReadBoundary();
    current();
    await connector.forgetLocal();
    assert.throws(current, /SOURCE_DENIED/);
  }
});
