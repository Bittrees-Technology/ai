import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PrivateEndpointKeys,
  type PrivateKeyAuthority,
} from "../modules/remote/private-endpoint-keys.js";
import { privateKeyAccount } from "../apps/companion/private-key-entry.js";
import { PrivatePeerEnrollment } from "../modules/remote/private-peers.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import {
  sealPrivateEnvelope,
  openPrivateEnvelope,
  privateEnvelopeSuite,
} from "../modules/remote/private-envelope.js";
class Slot {
  value?: Uint8Array;
  beforeRead?: () => Promise<void>;
  beforeAdd?: () => Promise<void>;
  afterAdd?: () => Promise<void>;
  deleteFails = false;
  async getSecret() {
    await this.beforeRead?.();
    return this.value ? Uint8Array.from(this.value) : undefined;
  }
  async addSecretIfAbsent(value: Uint8Array) {
    await this.beforeAdd?.();
    if (this.value) return false;
    this.value = Uint8Array.from(value);
    await this.afterAdd?.();
    return true;
  }
  async deleteCredential() {
    if (this.deleteFails) throw Error("SENSITIVE_NATIVE_ERROR");
    const exists = !!this.value;
    this.value = undefined;
    return exists;
  }
}
function fixture() {
  let now = 1800000000000;
  let authority: PrivateKeyAuthority | null = {
    localOwner: "local-alice",
    binding: {
      ownerId: randomUUID(),
      deviceId: randomUUID(),
      credentialEpoch: 1,
      expiresAt: now + 3600000,
    },
    keyId: randomUUID(),
    keyEpoch: 1,
    creationAllowed: true,
  };
  const slots = new Map<string, { key: Slot; attempt: Slot; deleted: Slot }>();
  const entries = (id: string) => {
    let value = slots.get(id);
    if (!value) {
      value = { key: new Slot(), attempt: new Slot(), deleted: new Slot() };
      slots.set(id, value);
    }
    return value;
  };
  const current = () => authority;
  const manager = () =>
    new PrivateEndpointKeys("local-alice", entries, current, () => now);
  return {
    manager,
    current,
    entries,
    slots,
    set: (v: PrivateKeyAuthority | null) => {
      authority = v;
    },
    advance: () => {
      now += 3600000;
    },
    now: () => now,
    request: () => ({
      keyId: authority!.keyId,
      keyEpoch: authority!.keyEpoch,
      confirmed: true,
    }),
    slot: () => entries(authority!.keyId),
  };
}
test("Mac endpoint keys require explicit fresh creation, survive manager reopen and expose stable nonextractable private handles", async () => {
  const f = fixture(),
    keys = f.manager();
  await assert.rejects(keys.resolve(), /CONFLICT/);
  await assert.rejects(
    keys.create({ ...f.request(), confirmed: false }),
    /DENIED/,
  );
  assert.equal(f.slot().attempt.value, undefined);
  f.set({ ...f.current()!, creationAllowed: false });
  await assert.rejects(keys.create(f.request()), /DENIED/);
  f.set({ ...f.current()!, creationAllowed: true });
  const created = await keys.create(f.request());
  assert.deepEqual(Object.keys(created).sort(), [
    "keyEpoch",
    "keyId",
    "publicKey",
  ]);
  const first = await keys.resolve(),
    second = await keys.resolve();
  assert.equal(first.pair.privateKey, second.pair.privateKey);
  assert.equal(first.pair.publicKey, second.pair.publicKey);
  const substitute = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  first.pair.privateKey = substitute.privateKey;
  assert.equal((await keys.resolve()).pair.privateKey, second.pair.privateKey);
  assert.equal(second.pair.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey("pkcs8", second.pair.privateKey));
  f.set({ ...f.current()!, creationAllowed: false });
  assert.deepEqual(await f.manager().create(f.request()), created);
  assert.equal((await f.manager().resolve()).publicKey, created.publicKey);
});
test("Persistent Mac keys generate reviewed public invitations and interoperate with actual HPKE after reopen", async () => {
  const f = fixture(),
    keys = f.manager(),
    b = f.current()!.binding;
  await keys.create(f.request());
  const recipient = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    ),
    recipientId = randomUUID();
  const review = await keys.invitation({ recipientId, confirmed: true });
  assert.equal(review.invitation.peerId, b.deviceId);
  assert.equal(review.invitation.ownerId, b.ownerId);
  assert.equal(
    review.invitation.expiresAt - review.invitation.issuedAt,
    300000,
  );
  assert.equal(JSON.stringify(review).includes("privateKey"), false);
  const dir = mkdtempSync(join(tmpdir(), "endpoint-key-test-")),
    vault = new Vault(randomBytes(32)),
    store = new Store(join(dir, "tasks.db"), vault);
  try {
    const registry = new PrivatePeerEnrollment(
      store,
      vault,
      { userId: "other", tenantId: "synthetic" },
      () => ({ ...b, deviceId: recipientId }),
      f.now,
    );
    const pending = await registry.prepare(review.invitation);
    assert.equal(pending.fingerprint, review.fingerprint);
    registry.approve({
      reviewId: pending.reviewId,
      expectedRevision: pending.expectedRevision,
      comparedFingerprint: review.fingerprint,
      confirmed: true,
    });
    const pin = await registry.resolve(b.deviceId, 1);
    const header = {
      version: 1,
      suite: privateEnvelopeSuite,
      ownerId: b.ownerId,
      senderId: b.deviceId,
      recipientId,
      senderKeyEpoch: 1,
      recipientKeyEpoch: 1,
      messageId: randomUUID(),
      operationId: randomUUID(),
      sequence: 1,
      issuedAt: f.now(),
      expiresAt: f.now() + 60000,
    };
    const wire = await sealPrivateEnvelope(
      header,
      new TextEncoder().encode("synthetic private task"),
      {
        senderKey: (await f.manager().resolve()).pair,
        recipientPublicKey: recipient.publicKey,
      },
      f.now,
    );
    const opened = await openPrivateEnvelope(
      wire,
      header,
      { recipientKey: recipient, senderPublicKey: pin.publicKey },
      f.now,
    );
    assert.equal(
      new TextDecoder().decode(opened.plaintext),
      "synthetic private task",
    );
    opened.plaintext.fill(0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("Interrupted creation never replaces missing keys; unconfirmed successful native adds reopen as the same key", async () => {
  const f = fixture(),
    keys = f.manager();
  f.slot().key.afterAdd = async () => {
    throw Error("SENSITIVE_NATIVE_ERROR");
  };
  await assert.rejects(
    keys.create(f.request()),
    /^Error: STORAGE_UNAVAILABLE$/,
  );
  const original = f.slot().key.value!.slice();
  f.slot().key.afterAdd = undefined;
  const recovered = await f.manager().create(f.request());
  assert.equal((await keys.resolve()).publicKey, recovered.publicKey);
  assert.deepEqual(f.slot().key.value, original);
  f.slot().key.value = undefined;
  await assert.rejects(f.manager().create(f.request()), /CREATION_INCOMPLETE/);
  assert.equal(f.slot().key.value, undefined);
  const other = fixture();
  other.slot().attempt.afterAdd = async () => {
    throw Error("lost marker acknowledgement");
  };
  await assert.rejects(
    other.manager().create(other.request()),
    /STORAGE_UNAVAILABLE/,
  );
  other.slot().attempt.afterAdd = undefined;
  await assert.rejects(
    other.manager().create(other.request()),
    /CREATION_INCOMPLETE/,
  );
  assert.equal(other.slot().key.value, undefined);
});
test("Concurrent creators cannot overwrite a key, and revoked authority during creation cannot publish a usable key", async () => {
  const f = fixture();
  const outcomes = await Promise.allSettled([
    f.manager().create(f.request()),
    f.manager().create(f.request()),
  ]);
  assert.ok(outcomes.some((x) => x.status === "fulfilled"));
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  const original = f.slot().key.value!.slice();
  await f.manager().create(f.request());
  assert.deepEqual(f.slot().key.value, original);
  const g = fixture(),
    id = g.current()!.keyId;
  g.slot().attempt.afterAdd = async () => {
    g.set(null);
  };
  await assert.rejects(g.manager().create(g.request()), /DENIED/);
  assert.equal(g.entries(id).key.value, undefined);
});
test("Current account, credential, expiry, local owner and stored public/private correspondence fence key access", async () => {
  const f = fixture(),
    keys = f.manager();
  await keys.create(f.request());
  const a = f.current()!,
    original = f.slot().key.value!.slice();
  for (const binding of [
    { ...a.binding, ownerId: randomUUID() },
    { ...a.binding, deviceId: randomUUID() },
    { ...a.binding, credentialEpoch: 2 },
    { ...a.binding, expiresAt: a.binding.expiresAt + 1 },
  ]) {
    f.set({ ...a, binding });
    await assert.rejects(keys.resolve(), /CONFLICT/);
  }
  f.set({ ...a, localOwner: "mallory" });
  await assert.rejects(keys.resolve(), /DENIED/);
  f.set(a);
  const second = fixture();
  await second.manager().create(second.request());
  const record = JSON.parse(Buffer.from(original).toString());
  record.publicKey = JSON.parse(
    Buffer.from(second.slot().key.value!).toString(),
  ).publicKey;
  f.slot().key.value = Buffer.from(JSON.stringify(record));
  await assert.rejects(keys.resolve(), /STORAGE_UNAVAILABLE/);
  f.slot().key.value = original;
  f.advance();
  await assert.rejects(keys.resolve(), /DENIED/);
});
test("Deletion locks the slot before native cleanup, survives reopen and denies a late competing creation", async () => {
  const f = fixture(),
    keys = f.manager();
  await keys.create(f.request());
  const id = f.current()!.keyId;
  f.slot().key.deleteFails = true;
  await assert.rejects(
    keys.remove({ keyId: id, confirmed: true }),
    /STORAGE_UNAVAILABLE/,
  );
  await assert.rejects(f.manager().resolve(), /DELETED/);
  await assert.rejects(f.manager().create(f.request()), /DELETED/);
  assert.ok(f.slot().key.value);
  assert.ok(f.slot().deleted.value);
  f.slot().key.deleteFails = false;
  f.set(null);
  assert.deepEqual(await keys.remove({ keyId: id, confirmed: true }), {
    deletedLocally: true,
    remoteRevocationConfirmed: false,
  });
  assert.equal(f.entries(id).key.value, undefined);
  assert.ok(f.entries(id).attempt.value);
  assert.ok(f.entries(id).deleted.value);
  const g = fixture(),
    creator = g.manager(),
    deleter = g.manager();
  g.slot().key.beforeAdd = async () => {
    await deleter.remove({ keyId: g.current()!.keyId, confirmed: true });
  };
  await assert.rejects(creator.create(g.request()), /DELETED/);
  assert.equal(g.slot().key.value, undefined);
  await assert.rejects(g.manager().resolve(), /DELETED/);
});
test("Late scope loss and deletion during stored-key reads suppress returned handles and invitation output", async () => {
  const f = fixture(),
    keys = f.manager();
  await keys.create(f.request());
  const a = f.current()!,
    slot = f.slot();
  let reads = 0;
  slot.key.beforeRead = async () => {
    if (++reads === 2) f.set(null);
  };
  await assert.rejects(keys.resolve(), /DENIED/);
  slot.key.beforeRead = undefined;
  f.set(a);
  reads = 0;
  slot.deleted.beforeRead = async () => {
    if (++reads === 2)
      slot.deleted.value = Buffer.from('{"version":1,"deleted":true}');
  };
  await assert.rejects(
    keys.invitation({ recipientId: randomUUID(), confirmed: true }),
    /DELETED/,
  );
});
test("Native slot names isolate local owners/profiles and malformed native data never becomes a replacement key", async () => {
  const id = randomUUID(),
    first = privateKeyAccount("personal", "alice", id);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, privateKeyAccount("personal", "bob", id));
  assert.notEqual(first, privateKeyAccount("test", "alice", id));
  assert.throws(() => privateKeyAccount("../bad", "alice", id));
  const f = fixture();
  f.slot().key.value = Buffer.from("invalid secret");
  await assert.rejects(f.manager().create(f.request()), /CONFLICT/);
  assert.equal(Buffer.from(f.slot().key.value!).toString(), "invalid secret");
  f.slot().attempt.beforeRead = async () => {
    throw Error("SENSITIVE_NATIVE_ERROR");
  };
  await assert.rejects(f.manager().resolve(), /^Error: STORAGE_UNAVAILABLE$/);
});

test("Host invalidation cancels late key resolution even if the same identity returns, while concurrent calls are bounded", async () => {
  const f = fixture(),
    keys = f.manager();
  await keys.create(f.request());
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.slot().key.beforeRead = async () => {
    entered();
    await gate;
  };
  const pending = keys.resolve();
  await waiting;
  await assert.rejects(keys.resolve(), /BUSY/);
  keys.invalidate();
  release();
  await assert.rejects(pending, /CONFLICT/);
  f.slot().key.beforeRead = undefined;
  assert.equal((await keys.resolve()).keyId, f.current()!.keyId);
});
