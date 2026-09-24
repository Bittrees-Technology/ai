import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
import {
  consumePrivateIncomingReplay as consume,
  privateIncomingReplayLimit,
} from "../modules/remote/private-incoming-replay.js";
import {
  privateReplayIdentity,
  type PrivateReplayIdentity,
} from "../modules/remote/private-replay.js";
import { privateEnvelopeSuite } from "../modules/remote/private-envelope.js";

const owner = { userId: "synthetic", tenantId: "personal" };
// This fixture tests storage after authentication, not the cryptographic boundary.
// Real authenticated re-encryption is covered in private-replay.test.ts.
async function identity(
  type: PrivateReplayIdentity["type"] = "conversation.message",
) {
  return privateReplayIdentity(
    {
      header: {
        version: 1,
        suite: privateEnvelopeSuite,
        ownerId: randomUUID(),
        senderId: randomUUID(),
        recipientId: randomUUID(),
        senderKeyEpoch: 1,
        recipientKeyEpoch: 1,
        messageId: randomUUID(),
        operationId: randomUUID(),
        sequence: 1,
        issuedAt: 1000,
        expiresAt: 2000,
      },
      enc: "A".repeat(87),
      ciphertext: "A".repeat(64),
    },
    type,
  );
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "private-incoming-replay-")),
    path = join(dir, "tasks.db"),
    vault = new Vault(randomBytes(32)),
    store = new Store(path, vault);
  return {
    dir,
    path,
    vault,
    store,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const outcome = () => ({ collection: "messages", id: randomUUID() });

test("shared replay entries require a transaction and reject cross-family ID/sequence collisions and changed outcomes", async () => {
  const f = fixture(),
    a = await identity(),
    result = outcome();
  const accept = (candidate: unknown, target = result) =>
    f.store.db
      .transaction(() => consume(f.store, f.vault, owner, candidate, target))
      .immediate();
  try {
    assert.throws(
      () => consume(f.store, f.vault, owner, a, result),
      /STORAGE_UNAVAILABLE/,
    );
    assert.equal(accept(a), "new");
    assert.equal(accept(a), "duplicate");
    assert.throws(() => accept(a, outcome()), /CONFLICT/);
    for (const key of ["operation", "message", "sequence"] as const) {
      const changed = { ...(await identity("task.submit")), [key]: a[key] };
      assert.throws(() => accept(changed), /CONFLICT/);
    }
    const two = await identity();
    assert.equal(accept(two), "new");
    assert.throws(() => accept({ ...a, message: two.message }), /CONFLICT/);
    assert.equal(f.store.exportPrivateIncomingReplay(owner).length, 2);
    assert.equal(
      f.store.exportPrivateIncomingReplay({ ...owner, tenantId: "other" })
        .length,
      0,
    );
  } finally {
    f.close();
  }
});

test("a rejected replay or later failed authority check rolls back the existing Inbox append and replay record together", async () => {
  const f = fixture(),
    a = await identity();
  try {
    f.store.createInbox(owner, {
      id: "personal",
      tenantId: owner.tenantId,
      ownerId: owner.userId,
      ownerType: "user",
      memberUserIds: [owner.userId],
    });
    const append = (key: string) =>
      f.store.appendMessage(
        owner,
        {
          conversationId: "thread",
          recipientInboxId: "personal",
          content: "synthetic private text",
          type: "query",
        },
        key,
      );
    let id = "";
    f.store.db
      .transaction(() => {
        id = append("first").id;
        consume(f.store, f.vault, owner, a, { collection: "messages", id });
      })
      .immediate();
    assert.throws(
      () =>
        f.store.db
          .transaction(() => {
            const changed = append("changed");
            consume(
              f.store,
              f.vault,
              owner,
              { ...a, envelope: "0".repeat(64) },
              { collection: "messages", id: changed.id },
            );
          })
          .immediate(),
      /CONFLICT/,
    );
    const fresh = await identity();
    assert.throws(
      () =>
        f.store.db
          .transaction(() => {
            const next = append("source-revoked");
            consume(f.store, f.vault, owner, fresh, {
              collection: "messages",
              id: next.id,
            });
            throw Error("CURRENT_SOURCE_DENIED");
          })
          .immediate(),
      /CURRENT_SOURCE_DENIED/,
    );
    assert.equal(f.store.exportMessages(owner).length, 1);
    assert.deepEqual(f.store.exportPrivateIncomingReplay(owner), [
      { identity: a, outcome: { collection: "messages", id } },
    ]);
  } finally {
    f.close();
  }
});

test("independent store handles retain the exact outcome across restart; backup preserves replay denial and owner deletion removes only that owner", async () => {
  const f = fixture(),
    a = await identity(),
    result = outcome(),
    other = { ...owner, userId: "other" };
  let second: Store | undefined, restored: Store | undefined;
  try {
    f.store.db
      .transaction(() => {
        consume(f.store, f.vault, owner, a, result);
        consume(f.store, f.vault, other, a, result);
      })
      .immediate();
    second = new Store(f.path, f.vault);
    assert.equal(
      second.db
        .transaction(() => consume(second!, f.vault, owner, a, result))
        .immediate(),
      "duplicate",
    );
    second.close();
    second = undefined;
    await encryptedBackup(f.store, f.vault, join(f.dir, "snapshot.aib"));
    await restoreBackup(
      join(f.dir, "snapshot.aib"),
      f.vault,
      join(f.dir, "restored.db"),
    );
    restored = new Store(join(f.dir, "restored.db"), f.vault);
    assert.deepEqual(
      restored.exportPrivateIncomingReplay(owner),
      f.store.exportPrivateIncomingReplay(owner),
    );
    assert.throws(
      () =>
        restored!.db
          .transaction(() =>
            consume(
              restored!,
              f.vault,
              owner,
              { ...a, envelope: "0".repeat(64) },
              result,
            ),
          )
          .immediate(),
      /CONFLICT/,
    );
    f.store.deleteAll(owner);
    assert.deepEqual(f.store.exportPrivateIncomingReplay(owner), []);
    assert.equal(f.store.exportPrivateIncomingReplay(other).length, 1);
  } finally {
    restored?.close();
    second?.close();
    f.close();
  }
});

test("corrupt, reassigned and mismatched encrypted records never admit a replacement message", async () => {
  const f = fixture(),
    a = await identity(),
    result = outcome();
  const accept = () =>
    f.store.db
      .transaction(() => consume(f.store, f.vault, owner, a, result))
      .immediate();
  try {
    accept();
    const row = f.store.db
      .prepare("SELECT payload FROM private_incoming_replay")
      .get() as { payload: Buffer };
    assert.equal(row.payload.includes(Buffer.from(result.id)), false);
    assert.equal(row.payload.includes(Buffer.from(a.type)), false);
    f.store.db
      .prepare("UPDATE private_incoming_replay SET payload=?")
      .run(Buffer.from("broken"));
    assert.throws(accept, /STORAGE_UNAVAILABLE/);
    f.store.db
      .prepare("UPDATE private_incoming_replay SET payload=?,message_hash=?")
      .run(row.payload, "0".repeat(64));
    assert.throws(accept, /STORAGE_UNAVAILABLE/);
    f.store.db
      .prepare("UPDATE private_incoming_replay SET message_hash=?,user_id=?")
      .run(a.message, "other");
    assert.throws(
      () => f.store.exportPrivateIncomingReplay({ ...owner, userId: "other" }),
      /STORAGE_UNAVAILABLE/,
    );
  } finally {
    f.close();
  }
});

test("capacity never evicts retained replay evidence and still permits an exact original retry", async () => {
  const f = fixture(),
    a = await identity(),
    result = outcome();
  try {
    f.store.db
      .transaction(() => {
        consume(f.store, f.vault, owner, a, result);
        const insert = f.store.db.prepare(
          "INSERT INTO private_incoming_replay VALUES(?,?,?,?,?,?)",
        );
        for (let i = 1; i < privateIncomingReplayLimit; i++) {
          const h = i.toString(16).padStart(64, "0");
          insert.run(
            owner.userId,
            owner.tenantId,
            h,
            h,
            h,
            Buffer.from("capacity fixture"),
          );
        }
      })
      .immediate();
    const fresh = await identity();
    assert.throws(
      () =>
        f.store.db
          .transaction(() => consume(f.store, f.vault, owner, fresh, outcome()))
          .immediate(),
      /CAPACITY/,
    );
    assert.equal(
      f.store.db
        .transaction(() => consume(f.store, f.vault, owner, a, result))
        .immediate(),
      "duplicate",
    );
    assert.equal(
      (
        f.store.db
          .prepare("SELECT count(*) AS n FROM private_incoming_replay")
          .get() as { n: number }
      ).n,
      privateIncomingReplayLimit,
    );
  } finally {
    f.close();
  }
});

test("actual Mac task admission shares replay state and rolls back a cross-family collision without creating work", async () => {
  const { privateEndpoints } = await import("./helpers/private-endpoints.js");
  const f = await privateEndpoints();
  try {
    const task = await f.submit();
    const prior = await privateReplayIdentity(
      task.envelope,
      "peer.key.challenge",
    );
    f.b.store.db
      .transaction(() =>
        consume(f.b.store, f.b.vault, f.b.owner, prior, {
          collection: "private_peer_checks",
          id: randomUUID(),
        }),
      )
      .immediate();
    await assert.rejects(f.b.controls.receiveTask(task.envelope), /CONFLICT/);
    assert.equal(f.b.store.export(f.b.owner).length, 0);
    assert.equal(f.b.store.exportPrivateTaskReceipts(f.b.owner).length, 0);
    const fresh = await f.submit("Independent task");
    const first = await f.b.controls.receiveTask(fresh.envelope);
    const again = await f.b.controls.receiveTask(fresh.envelope);
    assert.deepEqual(again, first);
    assert.equal(f.b.store.export(f.b.owner).length, 1);
    assert.equal(f.b.store.exportPrivateIncomingReplay(f.b.owner).length, 2);
  } finally {
    f.close();
  }
});
