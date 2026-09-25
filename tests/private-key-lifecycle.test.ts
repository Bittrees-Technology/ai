import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
import { PrivateKeyLifecycle } from "../modules/remote/private-key-lifecycle.js";
import { PrivatePeerEnrollment } from "../modules/remote/private-peers.js";
import { PrivateTaskReceiver } from "../modules/remote/private-task-receiver.js";
import {
  sealPrivateEnvelope,
  privateEnvelopeSuite,
} from "../modules/remote/private-envelope.js";
import type { PrivateBinding } from "../modules/remote/private-peer-contracts.js";
import { localApi, type LocalApiOptions } from "../apps/companion/http.js";
const owner = { userId: "alice", tenantId: "personal" };
class Slot {
  value?: Uint8Array;
  beforeAdd?: () => Promise<void>;
  afterAdd?: () => Promise<void>;
  beforeRead?: () => Promise<void>;
  failDelete = false;
  async getSecret() {
    await this.beforeRead?.();
    return this.value ? Uint8Array.from(this.value) : undefined;
  }
  async addSecretIfAbsent(v: Uint8Array) {
    await this.beforeAdd?.();
    if (this.value) return false;
    this.value = Uint8Array.from(v);
    await this.afterAdd?.();
    return true;
  }
  async deleteCredential() {
    if (this.failDelete) throw Error("PRIVATE_NATIVE_FAILURE");
    const found = !!this.value;
    this.value = undefined;
    return found;
  }
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "key-lifecycle-")),
    path = join(dir, "tasks.db"),
    vault = new Vault(randomBytes(32));
  const stores: Store[] = [];
  const db = (p = path) => {
    const s = new Store(p, vault);
    stores.push(s);
    return s;
  };
  const store = db(),
    now = 1800000000000;
  let binding: PrivateBinding | null = {
      ownerId: randomUUID(),
      deviceId: randomUUID(),
      credentialEpoch: 1,
      expiresAt: now + 3600000,
    },
    fresh = false;
  const slots = new Map<string, { key: Slot; attempt: Slot; deleted: Slot }>();
  const entries = (id: string) => {
    let v = slots.get(id);
    if (!v) {
      v = { key: new Slot(), attempt: new Slot(), deleted: new Slot() };
      slots.set(id, v);
    }
    return v;
  };
  const lifecycle = (s = store, scope = owner) =>
    new PrivateKeyLifecycle(
      s,
      vault,
      scope,
      () => binding,
      entries,
      () => fresh,
      () => now,
    );
  const keys = lifecycle();
  return {
    dir,
    path,
    vault,
    store,
    db,
    entries,
    lifecycle,
    keys,
    now,
    current: () => binding,
    set: (v: PrivateBinding | null) => {
      binding = v;
    },
    fresh: (v: boolean) => {
      fresh = v;
    },
    close: () => {
      for (const s of stores) s.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function review(keys: PrivateKeyLifecycle) {
  return { expectedRevision: keys.list().revision, confirmed: true };
}
async function activate(keys: PrivateKeyLifecycle) {
  const reserved = keys.begin(review(keys));
  return keys.provision({
    keyId: reserved.keyId,
    expectedRevision: reserved.revision,
    confirmed: true,
  });
}
test("Key selection persists across independent store/provider reopen and requires reviewed monotonic replacement", async () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.keys.begin({ ...review(f.keys), confirmed: false }),
      /DENIED/,
    );
    const first = await activate(f.keys),
      proof = (await f.keys.resolve()).proof;
    const reopened = f.lifecycle(f.db());
    const key = await reopened.resolve();
    assert.equal(key.proof.publicKey, first.publicKey);
    assert.equal(key.pair.privateKey.extractable, false);
    const next = reopened.begin(review(reopened));
    assert.equal(next.keyEpoch, 2);
    assert.equal(f.keys.validate(proof), false);
    await assert.rejects(f.keys.resolve(), /DENIED/);
    await assert.rejects(
      f.keys.provision({
        keyId: first.keyId,
        expectedRevision: first.revision,
        confirmed: true,
      }),
      /CONFLICT/,
    );
    const second = await reopened.provision({
      keyId: next.keyId,
      expectedRevision: next.revision,
      confirmed: true,
    });
    assert.notEqual(second.publicKey, first.publicKey);
    assert.ok(f.entries(first.keyId).key.value);
    assert.equal(reopened.list().slots[0]!.state, "retired");
    const p = (await reopened.resolve()).proof;
    reopened.revoke({ keyId: second.keyId, ...review(reopened) });
    assert.equal(reopened.validate(p), false);
    assert.ok(f.entries(second.keyId).key.value);
  } finally {
    f.close();
  }
});
test("Interrupted provisioning resumes the original persisted slot, but a missing attempted key requires an explicit new slot", async () => {
  const f = fixture();
  try {
    const pending = f.keys.begin(review(f.keys));
    f.entries(pending.keyId).key.afterAdd = async () => {
      throw Error("lost acknowledgement");
    };
    await assert.rejects(
      f.keys.provision({
        keyId: pending.keyId,
        expectedRevision: pending.revision,
        confirmed: true,
      }),
      /STORAGE_UNAVAILABLE/,
    );
    assert.equal(f.keys.list().slots[0]!.state, "preparing");
    const bytes = f.entries(pending.keyId).key.value!.slice();
    f.entries(pending.keyId).key.afterAdd = undefined;
    const reopened = f.lifecycle(f.db());
    await reopened.provision({
      keyId: pending.keyId,
      expectedRevision: pending.revision,
      confirmed: true,
    });
    assert.deepEqual(f.entries(pending.keyId).key.value, bytes);
    assert.equal(
      reopened.validateReplayCoverage((await reopened.resolve()).proof),
      true,
    );
    const second = reopened.begin(review(reopened));
    f.entries(second.keyId).attempt.afterAdd = async () => {
      throw Error("marker acknowledgement lost");
    };
    await assert.rejects(
      reopened.provision({
        keyId: second.keyId,
        expectedRevision: second.revision,
        confirmed: true,
      }),
      /STORAGE_UNAVAILABLE/,
    );
    f.entries(second.keyId).attempt.afterAdd = undefined;
    await assert.rejects(
      reopened.provision({
        keyId: second.keyId,
        expectedRevision: second.revision,
        confirmed: true,
      }),
      /CREATION_INCOMPLETE/,
    );
    const third = await activate(reopened);
    assert.equal(third.keyEpoch, 3);
    assert.notEqual(third.keyId, second.keyId);
  } finally {
    f.close();
  }
});
test("Independent connection revocation during native provisioning and late key reads cannot publish active authority", async () => {
  const f = fixture();
  try {
    const pending = f.keys.begin(review(f.keys)),
      other = f.lifecycle(f.db());
    f.entries(pending.keyId).key.afterAdd = async () => {
      other.revoke({ keyId: pending.keyId, ...review(other) });
    };
    await assert.rejects(
      f.keys.provision({
        keyId: pending.keyId,
        expectedRevision: pending.revision,
        confirmed: true,
      }),
      /DENIED|CONFLICT/,
    );
    assert.equal(f.keys.list().slots[0]!.state, "retired");
    const active = await activate(f.keys);
    let calls = 0;
    f.entries(active.keyId).key.beforeRead = async () => {
      if (++calls === 2)
        other.revoke({ keyId: active.keyId, ...review(other) });
    };
    await assert.rejects(f.keys.resolve(), /DENIED|CONFLICT/);
    await assert.rejects(
      f.keys.invitation({ recipientId: randomUUID(), confirmed: true }),
      /DENIED/,
    );
  } finally {
    f.close();
  }
});
test("Deletion failure retains an encrypted cleanup journal that survives reopen and works without a remote lease", async () => {
  const f = fixture();
  try {
    const active = await activate(f.keys);
    f.entries(active.keyId).key.failDelete = true;
    await assert.rejects(
      f.keys.remove({ keyId: active.keyId, ...review(f.keys) }),
      /STORAGE_UNAVAILABLE/,
    );
    const state = f.keys.list();
    assert.equal(state.pendingKeyDeletionCount, 1);
    assert.equal(state.slots[0]!.state, "deleting");
    await assert.rejects(f.keys.resolve(), /DENIED/);
    assert.throws(() => f.keys.begin(review(f.keys)), /CONFLICT/);
    f.set(null);
    f.entries(active.keyId).key.failDelete = false;
    const reopened = f.lifecycle(f.db());
    await reopened.cleanupPending(review(reopened));
    assert.equal(reopened.list().pendingKeyDeletionCount, 0);
    assert.equal(reopened.list().slots[0]!.state, "deleted");
    assert.equal(f.entries(active.keyId).key.value, undefined);
    assert.ok(f.entries(active.keyId).deleted.value);
  } finally {
    f.close();
  }
});
test("Whole-data deletion locks authority, preserves only cleanup IDs and requires a different freshly registered device", async () => {
  const f = fixture();
  try {
    const active = await activate(f.keys),
      binding = f.current()!,
      oldProof = (await f.keys.resolve()).proof;
    f.store.deleteAll(owner);
    const exported = f.keys.list();
    assert.equal(exported.needsFreshPairing, true);
    assert.deepEqual(exported.slots, []);
    assert.equal(exported.pendingKeyDeletionCount, 1);
    assert.equal(f.keys.validate(oldProof), false);
    assert.ok(f.entries(active.keyId).key.value);
    assert.throws(() => f.keys.reset(review(f.keys)), /REPAIR_REQUIRED/);
    f.set({ ...binding, credentialEpoch: 2 });
    f.fresh(true);
    assert.throws(() => f.keys.reset(review(f.keys)), /REPAIR_REQUIRED/);
    f.set({ ...binding, deviceId: randomUUID() });
    assert.throws(() => f.keys.reset(review(f.keys)), /CONFLICT/);
    await f.keys.cleanupPending(review(f.keys));
    f.fresh(false);
    assert.throws(() => f.keys.reset(review(f.keys)), /REPAIR_REQUIRED/);
    f.fresh(true);
    f.keys.reset(review(f.keys));
    assert.equal((await activate(f.keys)).keyEpoch, 1);
    assert.equal(f.entries(active.keyId).key.value, undefined);
  } finally {
    f.close();
  }
});
test("Backup restore keeps key metadata but locks authority even when native keys are still available", async () => {
  const f = fixture();
  try {
    const first = await activate(f.keys),
      binding = f.current()!;
    const file = join(f.dir, "keys.aib"),
      target = join(f.dir, "restore.db");
    await encryptedBackup(f.store, f.vault, file);
    await restoreBackup(file, f.vault, target);
    const restored = f.lifecycle(f.db(target));
    assert.equal(restored.list().slots[0]!.id, first.keyId);
    assert.equal(restored.list().needsFreshPairing, true);
    assert.ok(f.entries(first.keyId).key.value);
    await assert.rejects(restored.resolve(), /DENIED/);
    assert.throws(() => restored.reset(review(restored)), /REPAIR_REQUIRED/);
    f.set({ ...binding, deviceId: randomUUID() });
    f.fresh(true);
    restored.reset(review(restored));
    const next = await activate(restored);
    assert.equal(next.keyEpoch, 2);
    assert.notEqual(next.publicKey, first.publicKey);
  } finally {
    f.close();
  }
});
test("Owner encryption and capacity preserve previous selections without silently pruning key history", async () => {
  const f = fixture();
  try {
    await activate(f.keys);
    const other = { userId: "mallory", tenantId: "personal" };
    assert.deepEqual(f.lifecycle(f.store, other).list().slots, []);
    f.store.db
      .prepare(
        "INSERT INTO private_key_lifecycle SELECT ?,tenant_id,revision,anchor,locked,payload FROM private_key_lifecycle WHERE user_id=?",
      )
      .run(other.userId, owner.userId);
    assert.throws(
      () => f.lifecycle(f.store, other).list(),
      /STORAGE_UNAVAILABLE/,
    );
    for (let n = 1; n < 20; n++) f.keys.begin(review(f.keys));
    const before = f.keys.list();
    assert.equal(before.slots.length, 20);
    assert.equal(before.slots.at(-1)!.keyEpoch, 20);
    assert.throws(() => f.keys.begin(review(f.keys)), /CAPACITY/);
    assert.deepEqual(f.keys.list(), before);
  } finally {
    f.close();
  }
});
test("A persisted selection supplies real task admission keys and revoked proof denies subsequent envelopes", async () => {
  const f = fixture();
  try {
    await activate(f.keys);
    const reopened = f.lifecycle(f.db()),
      selected = await reopened.resolve(),
      binding = f.current()!,
      browserId = randomUUID();
    const browser = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    const peers = new PrivatePeerEnrollment(
      f.store,
      f.vault,
      owner,
      f.current,
      () => f.now,
    );
    const r = await peers.prepare({
      version: 1,
      ownerId: binding.ownerId,
      recipientId: binding.deviceId,
      peerId: browserId,
      keyEpoch: 1,
      publicKey: Buffer.from(
        await crypto.subtle.exportKey("raw", browser.publicKey),
      ).toString("base64url"),
      nonce: randomUUID(),
      issuedAt: f.now,
      expiresAt: f.now + 300000,
    });
    peers.approve({
      reviewId: r.reviewId,
      expectedRevision: r.expectedRevision,
      comparedFingerprint: r.fingerprint,
      confirmed: true,
    });
    f.store.addProfile(owner, {
      id: "local",
      runtime: "ollama",
      model: "synthetic",
      contextTokens: 4096,
      maxOutputTokens: 1024,
      temperature: 0.2,
    });
    const receiver = new PrivateTaskReceiver(
      f.store,
      f.vault,
      owner,
      f.current,
      () =>
        reopened.validate(selected.proof)
          ? {
              binding,
              peerId: browserId,
              recipientKeyEpoch: selected.proof.keyEpoch,
              permissionRevision: 1,
              tasksEnabled: true,
              modelProfileId: "local",
              recipientKey: selected.pair,
            }
          : null,
      () => f.now,
    );
    const wire = () =>
      sealPrivateEnvelope(
        {
          version: 1,
          suite: privateEnvelopeSuite,
          ownerId: binding.ownerId,
          senderId: browserId,
          recipientId: binding.deviceId,
          senderKeyEpoch: 1,
          recipientKeyEpoch: selected.proof.keyEpoch,
          messageId: randomUUID(),
          operationId: randomUUID(),
          sequence: 1,
          issuedAt: f.now,
          expiresAt: f.now + 60000,
        },
        new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            type: "task.submit",
            kind: "query",
            prompt: "synthetic persisted-key task",
          }),
        ),
        { senderKey: browser, recipientPublicKey: selected.pair.publicKey },
        () => f.now,
      );
    const accepted = await receiver.accept(await wire());
    assert.equal(
      f.store.get(owner, accepted.taskId).input.prompt,
      "synthetic persisted-key task",
    );
    reopened.revoke({ keyId: selected.proof.keyId, ...review(reopened) });
    await assert.rejects(receiver.accept(await wire()), /DENIED/);
    assert.equal(f.store.list(owner).length, 1);
  } finally {
    f.close();
  }
});
test("Schema16 upgrade preserves tasks and the new schema records no key authority by default", () => {
  const f = fixture();
  try {
    const task = f.store.create(
      owner,
      {
        conversationId: "synthetic",
        kind: "query",
        prompt: "preserved",
        modelProfileId: "local",
      },
      randomUUID(),
    );
    f.store.db.exec("DROP TABLE private_key_lifecycle; PRAGMA user_version=16");
    const migrated = f.db();
    assert.equal(migrated.db.pragma("user_version", { simple: true }), 39);
    assert.equal(migrated.get(owner, task.id).input.prompt, "preserved");
    assert.deepEqual(f.lifecycle(migrated).list(), {
      revision: 0,
      needsFreshPairing: false,
      slots: [],
      pendingKeyDeletionCount: 0,
    });
  } finally {
    f.close();
  }
});
test("Authenticated data deletion requires native cleanup and never reports success while key cleanup remains", async () => {
  const f = fixture(),
    servers: ReturnType<typeof createServer>[] = [];
  try {
    const active = await activate(f.keys);
    f.store.create(
      owner,
      {
        conversationId: "synthetic",
        kind: "query",
        prompt: "retained until successful deletion",
        modelProfileId: "local",
      },
      randomUUID(),
    );
    async function api(cleanup?: () => Promise<void>) {
      const server = createServer();
      servers.push(server);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as AddressInfo).port,
        token = randomBytes(32).toString("hex");
      server.on(
        "request",
        localApi({
          store: f.store,
          owner,
          port,
          token,
          privateKeyCleanup: cleanup,
        }),
      );
      return {
        url: `http://127.0.0.1:${port}`,
        headers: {
          Authorization: "Bearer " + token,
          "X-Confirm-Delete": "all-local-task-data",
        },
      };
    }
    const missing = await api();
    assert.equal(
      (await fetch(missing.url + "/v1/data", { method: "DELETE" })).status,
      401,
    );
    assert.equal(
      (
        await fetch(missing.url + "/v1/data", {
          method: "DELETE",
          headers: missing.headers,
        })
      ).status,
      409,
    );
    assert.equal(f.store.list(owner).length, 1);
    const exported = await (
      await fetch(missing.url + "/v1/export", { headers: missing.headers })
    ).json();
    assert.equal(exported.privateEndpointKeys.slots[0].id, active.keyId);
    assert.equal(JSON.stringify(exported).includes("privateKey"), false);
    const wired = await api(async () => {
      await f.keys.clearAll({ confirmed: true });
    });
    f.entries(active.keyId).key.failDelete = true;
    const failure = await fetch(wired.url + "/v1/data", {
      method: "DELETE",
      headers: wired.headers,
    });
    assert.equal(failure.status, 503);
    assert.equal(
      JSON.stringify(await failure.json()).includes("PRIVATE_NATIVE_FAILURE"),
      false,
    );
    assert.equal(f.store.list(owner).length, 1);
    assert.equal(f.keys.list().pendingKeyDeletionCount, 1);
    f.entries(active.keyId).key.failDelete = false;
    assert.equal(
      (
        await fetch(wired.url + "/v1/data", {
          method: "DELETE",
          headers: wired.headers,
        })
      ).status,
      204,
    );
    assert.equal(f.store.list(owner).length, 0);
    assert.equal(f.keys.list().pendingKeyDeletionCount, 0);
    assert.equal(f.keys.list().needsFreshPairing, true);
    assert.equal(f.entries(active.keyId).key.value, undefined);
  } finally {
    for (const s of servers) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
    f.close();
  }
});

test("Database publication failure preserves the preparing slot and native key for an exact retry", async () => {
  const f = fixture();
  try {
    const pending = f.keys.begin(review(f.keys));
    f.store.db.exec(
      "CREATE TRIGGER fail_key_publication BEFORE UPDATE ON private_key_lifecycle BEGIN SELECT RAISE(ABORT,'synthetic publication failure'); END",
    );
    await assert.rejects(
      f.keys.provision({
        keyId: pending.keyId,
        expectedRevision: pending.revision,
        confirmed: true,
      }),
      /synthetic publication failure/,
    );
    const bytes = f.entries(pending.keyId).key.value!.slice();
    assert.equal(f.keys.list().slots[0]!.state, "preparing");
    assert.equal(f.keys.list().revision, pending.revision);
    f.store.db.exec("DROP TRIGGER fail_key_publication");
    await f.keys.provision({
      keyId: pending.keyId,
      expectedRevision: pending.revision,
      confirmed: true,
    });
    assert.deepEqual(f.entries(pending.keyId).key.value, bytes);
    const before = f.keys.list();
    f.store.db.exec(
      "CREATE TRIGGER fail_key_reservation BEFORE UPDATE ON private_key_lifecycle BEGIN SELECT RAISE(ABORT,'synthetic reservation failure'); END",
    );
    assert.throws(
      () => f.keys.begin(review(f.keys)),
      /synthetic reservation failure/,
    );
    assert.deepEqual(f.keys.list(), before);
  } finally {
    f.close();
  }
});

test("Data deletion rechecks newly selected keys after asynchronous remote journal cleanup", async () => {
  for (const existingKey of [false, true]) {
    const f = fixture(),
      server = createServer();
    try {
      if (existingKey) await activate(f.keys);
      f.store.create(
        owner,
        {
          conversationId: "synthetic",
          kind: "query",
          prompt: "keep on conflict",
          modelProfileId: "local",
        },
        randomUUID(),
      );
      const other = f.lifecycle(f.db());
      let intervene = true;
      let newId = "";
      const remote = {
        running: false,
        async clearTaskData(remove: () => void) {
          await Promise.resolve();
          if (intervene) {
            if (other.list().needsFreshPairing) {
              f.set({ ...f.current()!, deviceId: randomUUID() });
              f.fresh(true);
              other.reset(review(other));
            }
            newId = (await activate(other)).keyId;
          }
          remove();
        },
      } as unknown as LocalApiOptions["remote"];
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as AddressInfo).port,
        token = randomBytes(32).toString("hex");
      server.on(
        "request",
        localApi({
          store: f.store,
          owner,
          port,
          token,
          remote,
          privateKeyCleanup: async () => {
            await f.keys.clearAll({ confirmed: true });
          },
        }),
      );
      const remove = () =>
        fetch(`http://127.0.0.1:${port}/v1/data`, {
          method: "DELETE",
          headers: {
            Authorization: "Bearer " + token,
            "X-Confirm-Delete": "all-local-task-data",
          },
        });
      assert.equal((await remove()).status, 409);
      assert.equal(f.store.list(owner).length, 1);
      assert.equal(other.list().slots.at(-1)?.id, newId);
      assert.equal(other.list().slots.at(-1)?.state, "active");
      assert.ok(f.entries(newId).key.value);
      intervene = false;
      assert.equal((await remove()).status, 204);
      assert.equal(f.store.list(owner).length, 0);
      assert.equal(f.entries(newId).key.value, undefined);
      assert.equal(other.list().pendingKeyDeletionCount, 0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      f.close();
    }
  }
});

test("Replay coverage follows the exact active proof and cannot survive revocation, deletion, logout or owner changes", async () => {
  const f = fixture();
  try {
    const first = await activate(f.keys),
      selected = await f.keys.resolve();
    assert.equal(f.keys.validateReplayCoverage(selected.proof), true);
    const reopened = f.lifecycle(f.db());
    assert.equal(
      reopened.validateReplayCoverage((await reopened.resolve()).proof),
      true,
    );
    for (const proof of [
      { ...selected.proof, revision: selected.proof.revision + 1 },
      { ...selected.proof, keyId: randomUUID() },
      { ...selected.proof, keyEpoch: selected.proof.keyEpoch + 1 },
      { ...selected.proof, publicKey: "A".repeat(87) },
      {
        ...selected.proof,
        binding: { ...selected.proof.binding, deviceId: randomUUID() },
      },
    ])
      assert.equal(reopened.validateReplayCoverage(proof), false);
    assert.equal(
      f
        .lifecycle(f.db(), { ...owner, userId: "bob" })
        .validateReplayCoverage(selected.proof),
      false,
    );
    const binding = f.current();
    f.set(null);
    assert.equal(reopened.validateReplayCoverage(selected.proof), false);
    f.set(binding);
    reopened.revoke({ keyId: first.keyId, ...review(reopened) });
    assert.equal(reopened.validateReplayCoverage(selected.proof), false);
    const next = await activate(reopened),
      nextProof = (await reopened.resolve()).proof;
    assert.notEqual(next.publicKey, first.publicKey);
    assert.equal(reopened.validateReplayCoverage(nextProof), true);
    assert.ok(f.entries(first.keyId).key.value);
    await reopened.remove({ keyId: next.keyId, ...review(reopened) });
    assert.equal(reopened.validateReplayCoverage(nextProof), false);
  } finally {
    f.close();
  }
});

test("Resuming old generated material preserves the key without inventing replay history", async () => {
  const f = fixture();
  try {
    const pending = f.keys.begin(review(f.keys));
    f.entries(pending.keyId).key.afterAdd = async () => {
      throw Error("lost native reply");
    };
    const command = {
      keyId: pending.keyId,
      expectedRevision: pending.revision,
      confirmed: true,
    };
    await assert.rejects(f.keys.provision(command), /STORAGE_UNAVAILABLE/);
    f.entries(pending.keyId).key.afterAdd = undefined;
    const record = JSON.parse(
      Buffer.from(f.entries(pending.keyId).key.value!).toString("utf8"),
    );
    delete record.incomingReplayBoundary;
    const oldBytes = Buffer.from(JSON.stringify(record));
    f.entries(pending.keyId).key.value = oldBytes;
    const reopened = f.lifecycle(f.db());
    await reopened.provision(command);
    const selected = await reopened.resolve();
    assert.equal(reopened.validate(selected.proof), true);
    assert.equal(reopened.validateReplayCoverage(selected.proof), false);
    assert.equal(reopened.list().slots[0]!.incomingReplayBoundary, undefined);
    assert.deepEqual(f.entries(pending.keyId).key.value, oldBytes);
    const next = await activate(reopened);
    assert.notEqual(next.publicKey, selected.proof.publicKey);
    assert.equal(
      reopened.validateReplayCoverage((await reopened.resolve()).proof),
      true,
    );
    assert.deepEqual(f.entries(pending.keyId).key.value, oldBytes);
  } finally {
    f.close();
  }
});

test("Encrypted backup preserves provenance for history but restored and deleted stores cannot use it as authority", async () => {
  const f = fixture();
  try {
    await activate(f.keys);
    const selected = await f.keys.resolve(),
      snapshot = f.keys.list();
    const backup = join(f.dir, "coverage.aib"),
      path = join(f.dir, "restored.db");
    await encryptedBackup(f.store, f.vault, backup);
    await restoreBackup(backup, f.vault, path);
    const restored = f.db(path),
      keys = f.lifecycle(restored);
    assert.deepEqual(keys.list().slots, snapshot.slots);
    assert.equal(keys.list().needsFreshPairing, true);
    assert.equal(keys.validateReplayCoverage(selected.proof), false);
    await assert.rejects(keys.resolve(), /DENIED/);
    f.store.deleteAll(owner);
    assert.equal(f.keys.validateReplayCoverage(selected.proof), false);
    assert.equal(f.keys.list().slots.length, 0);
  } finally {
    f.close();
  }
});
