import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
import { PrivatePeerEnrollment } from "../modules/remote/private-peers.js";
import {
  inspectPrivateInvitation,
  type PrivateBinding,
  type PrivateInvitation,
} from "../modules/remote/private-peer-contracts.js";
import {
  sealPrivateEnvelope,
  openPrivateEnvelope,
  privateEnvelopeSuite,
} from "../modules/remote/private-envelope.js";
const owner = { userId: "alice", tenantId: "personal" };
const pair = () =>
  crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "private-peers-")),
    vault = new Vault(randomBytes(32)),
    path = join(dir, "tasks.db"),
    store = new Store(path, vault);
  let now = 1800000000000,
    binding: PrivateBinding | null = {
      ownerId: randomUUID(),
      deviceId: randomUUID(),
      credentialEpoch: 1,
      expiresAt: now + 3600000,
    };
  const current = () => binding,
    clock = () => now;
  const registry = new PrivatePeerEnrollment(
    store,
    vault,
    owner,
    current,
    clock,
  );
  return {
    dir,
    vault,
    path,
    store,
    registry,
    current,
    clock,
    setBinding: (v: PrivateBinding | null) => {
      binding = v;
    },
    advance: (n: number) => {
      now += n;
    },
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function invitation(
  f: ReturnType<typeof fixture>,
  key: CryptoKeyPair | undefined = undefined,
  peerId = randomUUID(),
  keyEpoch = 1,
) {
  key ??= await pair();
  return {
    key,
    value: {
      version: 1 as const,
      ownerId: f.current()!.ownerId,
      recipientId: f.current()!.deviceId,
      peerId,
      keyEpoch,
      publicKey: Buffer.from(
        await crypto.subtle.exportKey("raw", key.publicKey),
      ).toString("base64url"),
      nonce: randomUUID(),
      issuedAt: f.clock(),
      expiresAt: f.clock() + 300000,
    },
  };
}
function confirmation(
  r: Awaited<ReturnType<PrivatePeerEnrollment["prepare"]>>,
) {
  return {
    reviewId: r.reviewId,
    expectedRevision: r.expectedRevision,
    comparedFingerprint: r.fingerprint,
    confirmed: true as const,
  };
}
async function approve(
  f: ReturnType<typeof fixture>,
  value: PrivateInvitation,
) {
  return f.registry.approve(confirmation(await f.registry.prepare(value)));
}

test("Private peer enrollment requires exact one-use fingerprint review and resolves a real authenticated envelope", async () => {
  const f = fixture();
  try {
    const peer = await invitation(f),
      local = await pair();
    const review = await f.registry.prepare(peer.value);
    const i = peer.value;
    assert.equal(
      review.fingerprint,
      createHash("sha256")
        .update(
          JSON.stringify([
            "org.bittrees.ai/private-peer-review/v1",
            i.version,
            i.ownerId,
            i.recipientId,
            i.peerId,
            i.keyEpoch,
            i.publicKey,
            i.nonce,
            i.issuedAt,
            i.expiresAt,
          ]),
        )
        .digest("hex"),
    );
    await assert.rejects(f.registry.resolve(i.peerId, 1), /DENIED/);
    assert.throws(
      () =>
        f.registry.approve({
          ...confirmation(review),
          comparedFingerprint: "0".repeat(64),
        }),
      /DENIED/,
    );
    assert.throws(() => f.registry.approve(confirmation(review)), /DENIED/);
    const second = await f.registry.prepare(i),
      good = confirmation(second);
    second.invitation.publicKey = "changed returned review";
    assert.throws(
      () => f.registry.approve({ ...good, confirmed: false }),
      /DENIED/,
    );
    const receipt = f.registry.approve(good);
    assert.equal(receipt.revision, 1);
    const resolved = await f.registry.resolve(i.peerId, 1);
    assert.equal(f.registry.validate(resolved.proof), true);
    const h = {
      version: 1 as const,
      suite: privateEnvelopeSuite,
      ownerId: i.ownerId,
      senderId: i.peerId,
      recipientId: i.recipientId,
      senderKeyEpoch: 1,
      recipientKeyEpoch: 1,
      messageId: randomUUID(),
      operationId: randomUUID(),
      sequence: 1,
      issuedAt: f.clock(),
      expiresAt: f.clock() + 300000,
    };
    const envelope = await sealPrivateEnvelope(
      h,
      new TextEncoder().encode("private task"),
      { senderKey: peer.key, recipientPublicKey: local.publicKey },
      f.clock,
    );
    assert.equal(
      new TextDecoder().decode(
        (
          await openPrivateEnvelope(
            envelope,
            h,
            { recipientKey: local, senderPublicKey: resolved.publicKey },
            f.clock,
          )
        ).plaintext,
      ),
      "private task",
    );
    const impostor = await pair();
    const forged = await sealPrivateEnvelope(
      h,
      new TextEncoder().encode("forged"),
      { senderKey: impostor, recipientPublicKey: local.publicKey },
      f.clock,
    );
    await assert.rejects(
      openPrivateEnvelope(
        forged,
        h,
        { recipientKey: local, senderPublicKey: resolved.publicKey },
        f.clock,
      ),
    );
    const data = f.store.exportPrivatePeerTrust(owner);
    assert.equal(data.state?.peers[0]?.publicKey, i.publicKey);
    assert.equal(
      f.store.exportPrivatePeerTrust({ ...owner, userId: "bob" }).state,
      null,
    );
    const row = f.store.db
      .prepare("SELECT payload FROM private_peer_states")
      .get() as { payload: Buffer };
    assert.equal(row.payload.includes(Buffer.from(i.publicKey)), false);
    assert.equal(row.payload.includes(Buffer.from(i.ownerId)), false);
  } finally {
    f.close();
  }
});

test("Private peer replacement rejects reused keys and non-increasing epochs; revocation works without a remote lease", async () => {
  const f = fixture();
  try {
    const a = await invitation(f);
    await approve(f, a.value);
    const proof = (await f.registry.resolve(a.value.peerId, 1)).proof;
    const b = await invitation(f, await pair(), a.value.peerId, 1);
    await assert.rejects(f.registry.prepare(b.value), /DENIED/);
    b.value.keyEpoch = 2;
    await approve(f, b.value);
    assert.equal(f.registry.validate(proof), false);
    await assert.rejects(f.registry.resolve(a.value.peerId, 1), /DENIED/);
    await assert.rejects(
      f.registry.prepare((await invitation(f, a.key, a.value.peerId, 3)).value),
      /DENIED/,
    );
    await assert.rejects(
      f.registry.prepare((await invitation(f, b.key, randomUUID(), 10)).value),
      /DENIED/,
    );
    const pending = f.registry.resolve(b.value.peerId, 2);
    f.registry.revoke({
      peerId: b.value.peerId,
      expectedRevision: f.registry.list().revision,
      confirmed: true,
    });
    await assert.rejects(pending, /CONFLICT/);
    await assert.rejects(f.registry.resolve(b.value.peerId, 2), /DENIED/);
    await assert.rejects(
      f.registry.prepare((await invitation(f, b.key, b.value.peerId, 3)).value),
      /DENIED/,
    );
    const old = f.current()!;
    f.setBinding({ ...old, credentialEpoch: 2 });
    assert.throws(() => f.registry.list(), /CONFLICT/);
    f.registry.reset({
      expectedRevision: f.store.exportPrivatePeerTrust(owner).revision,
      confirmed: true,
    });
    await assert.rejects(
      f.registry.prepare(
        (await invitation(f, await pair(), a.value.peerId, 2)).value,
      ),
      /DENIED/,
    );
    const c = await invitation(f, await pair(), a.value.peerId, 3);
    await approve(f, c.value);
    const revision = f.registry.list().revision;
    f.setBinding(null);
    f.registry.revoke({
      peerId: c.value.peerId,
      expectedRevision: revision,
      confirmed: true,
    });
    assert.equal(
      f.store.exportPrivatePeerTrust(owner).state?.peers[0]?.revoked,
      true,
    );
  } finally {
    f.close();
  }
});

test("Private peer reviews reject account changes, expired offers and mutations across asynchronous checks", async () => {
  const f = fixture();
  try {
    const peer = await invitation(f),
      original = f.current()!;
    for (const value of [
      { ...peer.value, ownerId: randomUUID() },
      { ...peer.value, recipientId: randomUUID() },
      { ...peer.value, publicKey: "a".repeat(87) },
      { ...peer.value, title: "PRIVATE_TITLE" },
      { ...peer.value, expiresAt: f.clock() + 300001 },
    ])
      await assert.rejects(f.registry.prepare(value), /DENIED/);
    const review = await f.registry.prepare(peer.value);
    f.setBinding({ ...original, credentialEpoch: 2 });
    assert.throws(() => f.registry.approve(confirmation(review)), /CONFLICT/);
    f.setBinding(original);
    const pending = f.registry.prepare(peer.value);
    f.setBinding(null);
    await assert.rejects(pending, /DENIED/);
    f.setBinding(original);
    const expiring = await f.registry.prepare(peer.value);
    f.advance(300001);
    assert.throws(() => f.registry.approve(confirmation(expiring)), /DENIED/);
    const fresh = await invitation(f),
      snapshot = { ...fresh.value },
      pendingReview = f.registry.prepare(fresh.value);
    fresh.value.peerId = randomUUID();
    assert.equal((await pendingReview).invitation.peerId, snapshot.peerId);
  } finally {
    f.close();
  }
});

test("Private peer changes are durable and stale reviews fail across two SQLite connections", async () => {
  const f = fixture(),
    secondStore = new Store(f.path, f.vault),
    second = new PrivatePeerEnrollment(
      secondStore,
      f.vault,
      owner,
      f.current,
      f.clock,
    );
  try {
    const a = await invitation(f),
      b = await invitation(f);
    const firstReview = await f.registry.prepare(a.value),
      secondReview = await second.prepare(b.value);
    second.approve(confirmation(secondReview));
    assert.throws(
      () => f.registry.approve(confirmation(firstReview)),
      /CONFLICT/,
    );
    const restarted = new PrivatePeerEnrollment(
      f.store,
      f.vault,
      owner,
      f.current,
      f.clock,
    );
    assert.ok(await restarted.resolve(b.value.peerId, 1));
    assert.throws(() => restarted.approve(confirmation(firstReview)), /DENIED/);
    const proof = (await restarted.resolve(b.value.peerId, 1)).proof;
    second.revoke({
      peerId: b.value.peerId,
      expectedRevision: second.list().revision,
      confirmed: true,
    });
    assert.equal(restarted.validate(proof), false);
  } finally {
    secondStore.close();
    f.close();
  }
});

test("Actual encrypted restore locks peer trust until a fresh local device pairing; delete clears payload and blocks stale review", async () => {
  const f = fixture();
  let restored: Store | undefined;
  try {
    const a = await invitation(f);
    await approve(f, a.value);
    const pending = await f.registry.prepare((await invitation(f)).value);
    const backup = join(f.dir, "backup.aib"),
      restoredPath = join(f.dir, "restored.db");
    await encryptedBackup(f.store, f.vault, backup);
    await restoreBackup(backup, f.vault, restoredPath);
    restored = new Store(restoredPath, f.vault);
    const registry = new PrivatePeerEnrollment(
      restored,
      f.vault,
      owner,
      f.current,
      f.clock,
    );
    assert.equal(
      restored.exportPrivatePeerTrust(owner).needsFreshPairing,
      true,
    );
    await assert.rejects(
      registry.resolve(a.value.peerId, 1),
      /REPAIR_REQUIRED/,
    );
    const revision = restored.exportPrivatePeerTrust(owner).revision;
    f.setBinding({ ...f.current()!, credentialEpoch: 2 });
    assert.throws(
      () => registry.reset({ expectedRevision: revision, confirmed: true }),
      /REPAIR_REQUIRED/,
    );
    // Local revocation while locked must not unlock any restored permissions.
    registry.revoke({
      peerId: a.value.peerId,
      expectedRevision: revision,
      confirmed: true,
    });
    assert.equal(
      restored.exportPrivatePeerTrust(owner).needsFreshPairing,
      true,
    );
    f.setBinding({ ...f.current()!, deviceId: randomUUID() });
    registry.reset({ expectedRevision: revision + 1, confirmed: true });
    assert.deepEqual(registry.list().peers, []);
    await assert.rejects(
      registry.prepare((await invitation(f, a.key, a.value.peerId, 2)).value),
      /DENIED/,
    );
    f.store.deleteAll(owner);
    const deleted = f.store.exportPrivatePeerTrust(owner);
    assert.equal(deleted.state, null);
    assert.equal(deleted.needsFreshPairing, true);
    assert.throws(() => f.registry.approve(confirmation(pending)));
    // The reset comparison uses the original local device anchor, not raw exported peer metadata.
    assert.equal(JSON.stringify(deleted).includes(a.value.publicKey), false);
    assert.equal(JSON.stringify(deleted).includes(a.value.ownerId), false);
  } finally {
    restored?.close();
    f.close();
  }
});

test("Private peer review and enrollment capacity are bounded, and migration preserves existing task data", async () => {
  const f = fixture();
  try {
    const task = f.store.create(
      owner,
      {
        conversationId: "existing",
        kind: "query",
        prompt: "retained",
        modelProfileId: "p",
      },
      "seed",
    );
    f.store.db.exec("DROP TABLE private_peer_states; PRAGMA user_version=12");
    const migrated = new Store(f.path, f.vault);
    try {
      assert.equal(migrated.db.pragma("user_version", { simple: true }), 32);
      assert.equal(migrated.get(owner, task.id).input.prompt, "retained");
    } finally {
      migrated.close();
    }
    const peer = await invitation(f);
    for (let i = 0; i < 4; i++) await f.registry.prepare(peer.value);
    await assert.rejects(f.registry.prepare(peer.value), /CAPACITY/);
    f.advance(300001);
    const fresh = await invitation(f);
    await approve(f, fresh.value);
    for (let i = 1; i < 20; i++) await approve(f, (await invitation(f)).value);
    await assert.rejects(
      f.registry.prepare((await invitation(f)).value),
      /CAPACITY/,
    );
    const inspect = await inspectPrivateInvitation(
      fresh.value,
      fresh.value.issuedAt,
    );
    assert.equal(inspect.fingerprint.length, 64);
  } finally {
    f.close();
  }
});

test("Local HTTP export includes only owner peer trust; confirmed deletion clears keys and prevents stale reapproval", async () => {
  const f = fixture();
  const { createServer } = await import("node:http"),
    { localApi } = await import("../apps/companion/http.js");
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port,
    token = "local-test-token".repeat(4);
  server.on("request", localApi({ store: f.store, owner, port, token }));
  const call = (path: string, method = "GET", confirmed = false) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        ...(confirmed ? { "X-Confirm-Delete": "all-local-task-data" } : {}),
      },
    });
  try {
    const peer = await invitation(f);
    await approve(f, peer.value);
    const pending = await f.registry.prepare((await invitation(f)).value);
    const exported = await call("/v1/export");
    assert.equal(exported.headers.get("cache-control"), "no-store");
    assert.equal(
      ((await exported.json()) as any).privatePeerTrust.state.peers[0]
        .publicKey,
      peer.value.publicKey,
    );
    assert.equal((await call("/v1/remote/private-peers")).status, 404);
    assert.equal((await call("/v1/data", "DELETE")).status, 400);
    assert.ok(await f.registry.resolve(peer.value.peerId, 1));
    assert.equal((await call("/v1/data", "DELETE", true)).status, 204);
    const after = ((await (await call("/v1/export")).json()) as any)
      .privatePeerTrust;
    assert.equal(after.state, null);
    assert.equal(after.needsFreshPairing, true);
    assert.throws(
      () => f.registry.approve(confirmation(pending)),
      /REPAIR_REQUIRED/,
    );
    assert.throws(
      () =>
        f.registry.reset({ expectedRevision: after.revision, confirmed: true }),
      /REPAIR_REQUIRED/,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    f.close();
  }
});

test("Encrypted peer rows cannot be copied between local owners", async () => {
  const f = fixture();
  try {
    await approve(f, (await invitation(f)).value);
    const row = f.store.db
      .prepare("SELECT * FROM private_peer_states")
      .get() as any;
    f.store.db
      .prepare("INSERT INTO private_peer_states VALUES(?,?,?,?,?,?)")
      .run(
        "bob",
        owner.tenantId,
        row.revision,
        row.anchor,
        row.locked,
        row.payload,
      );
    assert.throws(
      () => f.store.exportPrivatePeerTrust({ ...owner, userId: "bob" }),
      /STORAGE_UNAVAILABLE/,
    );
    assert.equal(f.store.exportPrivatePeerTrust(owner).state?.peers.length, 1);
  } finally {
    f.close();
  }
});
