import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
import { PrivatePeerEnrollment } from "../modules/remote/private-peers.js";
import {
  PrivateTaskOutbox,
  type PrivateSendAuthority,
} from "../modules/remote/private-task-outbox.js";
import { PrivateTaskReceiver } from "../modules/remote/private-task-receiver.js";
import {
  sealPrivateEnvelope,
  type PrivateHeader,
} from "../modules/remote/private-envelope.js";
import type { PrivateTaskReceipt } from "../modules/remote/private-task-receipts.js";
const owner = { userId: "alice", tenantId: "personal" },
  other = { userId: "bob", tenantId: "personal" };
const pair = () =>
  crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
async function fixture(bindingLifetime = 3600000) {
  const dir = mkdtempSync(join(tmpdir(), "private-outbox-")),
    vault = new Vault(randomBytes(32)),
    targetVault = new Vault(randomBytes(32)),
    path = join(dir, "sender.db");
  let now = 1800000000000;
  const clock = () => now,
    store = new Store(path, vault, clock),
    target = new Store(join(dir, "target.db"), targetVault, clock);
  target.addProfile(owner, {
    id: "local",
    runtime: "ollama",
    model: "synthetic",
    contextTokens: 4096,
    maxOutputTokens: 1024,
    temperature: 0.2,
  });
  const remoteOwner = randomUUID(),
    binding = {
      ownerId: remoteOwner,
      deviceId: randomUUID(),
      credentialEpoch: 1,
      expiresAt: now + bindingLifetime,
    },
    targetBinding = { ...binding, deviceId: randomUUID() },
    sender = await pair(),
    recipient = await pair();
  let current: typeof binding | null = binding;
  const getBinding = () => current,
    peers = new PrivatePeerEnrollment(store, vault, owner, getBinding, clock),
    targetPeers = new PrivatePeerEnrollment(
      target,
      targetVault,
      owner,
      () => targetBinding,
      clock,
    );
  async function approve(
    registry: PrivatePeerEnrollment,
    local: typeof binding,
    peerId: string,
    key: CryptoKeyPair,
  ) {
    const review = await registry.prepare({
      version: 1,
      ownerId: remoteOwner,
      recipientId: local.deviceId,
      peerId,
      keyEpoch: 1,
      publicKey: Buffer.from(
        await crypto.subtle.exportKey("raw", key.publicKey),
      ).toString("base64url"),
      nonce: randomUUID(),
      issuedAt: now,
      expiresAt: now + 300000,
    });
    registry.approve({
      reviewId: review.reviewId,
      expectedRevision: review.expectedRevision,
      comparedFingerprint: review.fingerprint,
      confirmed: true,
    });
  }
  await approve(peers, binding, targetBinding.deviceId, recipient);
  await approve(targetPeers, targetBinding, binding.deviceId, sender);
  let permission: PrivateSendAuthority | null = {
    binding,
    peerId: targetBinding.deviceId,
    senderKeyEpoch: 1,
    permissionRevision: 1,
    sendingEnabled: true,
    senderKey: sender,
  };
  const getPermission = () => permission;
  const outbox = (db = store, scope = owner, provider = getPermission) =>
    new PrivateTaskOutbox(db, vault, scope, getBinding, provider, clock);
  const receiver = new PrivateTaskReceiver(
    target,
    targetVault,
    owner,
    () => targetBinding,
    () => ({
      binding: targetBinding,
      peerId: binding.deviceId,
      recipientKeyEpoch: 1,
      permissionRevision: 1,
      tasksEnabled: true,
      modelProfileId: "local",
      recipientKey: recipient,
    }),
    clock,
  );
  const request = () => ({
    clientRequestId: randomUUID(),
    peerId: targetBinding.deviceId,
    peerKeyEpoch: 1,
    expectedPeerRevision: peers.list().revision,
    content: {
      version: 1,
      type: "task.submit",
      kind: "query",
      prompt: "PRIVATE_OUTBOX_PROMPT",
    },
    confirmed: true,
  });
  const ack = (
    receipt: PrivateTaskReceipt,
    change: Partial<PrivateHeader> = {},
    key = recipient,
  ) =>
    sealPrivateEnvelope(
      {
        ...receipt.header,
        senderId: targetBinding.deviceId,
        recipientId: binding.deviceId,
        senderKeyEpoch: 1,
        recipientKeyEpoch: 1,
        messageId: randomUUID(),
        issuedAt: now,
        expiresAt: now + 300000,
        ...change,
      },
      new TextEncoder().encode(
        JSON.stringify({ version: 1, type: "task.accepted", receipt }),
      ),
      { senderKey: key, recipientPublicKey: sender.publicKey },
      clock,
    );
  return {
    dir,
    path,
    vault,
    store,
    target,
    targetVault,
    binding,
    targetBinding,
    peers,
    targetPeers,
    sender,
    recipient,
    clock,
    outbox,
    receiver,
    request,
    ack,
    getPermission,
    getBinding,
    setPermission: (p: PrivateSendAuthority | null) => {
      permission = p;
    },
    setBinding: (b: typeof binding | null) => {
      current = b;
    },
    advance: (n: number) => {
      now += n;
    },
    close: () => {
      store.close();
      target.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("Durable outbox retries identical ciphertext after restart and reconciles actual receiver acceptance", async () => {
  const f = await fixture();
  let reopened: Store | undefined;
  try {
    const request = f.request(),
      outbox = f.outbox(),
      entry = await outbox.enqueue(request),
      wire = outbox.delivery(entry.id);
    assert.equal(entry.value.state, "pending");
    assert.notEqual(wire.header.operationId, request.clientRequestId);
    const first = await f.receiver.accept(wire);
    assert.equal(f.target.list(owner).length, 1);
    f.store.close();
    reopened = new Store(f.path, f.vault, f.clock);
    const resumed = f.outbox(reopened),
      retry = resumed.delivery(entry.id);
    assert.deepEqual(retry, wire);
    assert.deepEqual(await f.receiver.accept(retry), first);
    assert.equal(f.target.list(owner).length, 1);
    const accepted = await resumed.acceptReceipt(await f.ack(first));
    assert.equal(accepted.value.state, "accepted");
    assert.deepEqual(accepted.value.receipt, first);
    assert.equal(accepted.value.attempts, 2);
    assert.equal(
      (await resumed.acceptReceipt(await f.ack(first))).revision,
      accepted.revision,
    );
    assert.throws(() => resumed.delivery(entry.id), /DENIED/);
    assert.equal((await resumed.enqueue(request)).id, entry.id);
    assert.equal(reopened.exportPrivateTaskOutbox(owner).length, 1);
  } finally {
    reopened?.close();
    f.close();
  }
});

test("Concurrent creation has one durable envelope and allocates distinct channel sequences across connections", async () => {
  const f = await fixture(),
    second = new Store(f.path, f.vault, f.clock);
  try {
    const request = f.request(),
      a = f.outbox(),
      b = f.outbox(second),
      [x, y] = await Promise.all([a.enqueue(request), b.enqueue(request)]);
    assert.equal(x.id, y.id);
    assert.deepEqual(a.delivery(x.id), b.delivery(y.id));
    assert.equal(f.store.exportPrivateTaskOutbox(owner).length, 1);
    const [next, last] = await Promise.all([
      a.enqueue(f.request()),
      b.enqueue(f.request()),
    ]);
    assert.deepEqual(
      [
        x.value.header.sequence,
        next.value.header.sequence,
        last.value.header.sequence,
      ].sort(),
      [1, 2, 3],
    );
    await assert.rejects(
      a.enqueue({
        ...request,
        content: { ...request.content, prompt: "changed" },
      }),
      /CONFLICT/,
    );
  } finally {
    second.close();
    f.close();
  }
});

test("Interrupted preparation resumes while failed publication never exposes uncommitted ciphertext", async () => {
  const f = await fixture();
  try {
    const request = f.request(),
      a = f.outbox();
    f.store.db.exec(
      "CREATE TRIGGER fail_publish BEFORE UPDATE ON private_task_outbox BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    );
    await assert.rejects(a.enqueue(request), /DENIED/);
    const pending = f.store.exportPrivateTaskOutbox(owner)[0]!;
    assert.equal(pending.value.state, "preparing");
    assert.equal(pending.value.envelope, null);
    assert.throws(() => a.delivery(pending.id), /DENIED/);
    f.store.db.exec("DROP TRIGGER fail_publish");
    const ready = await f.outbox().resume(pending.id);
    assert.equal(ready.value.state, "pending");
    assert.equal((await a.enqueue(request)).id, pending.id);
    assert.deepEqual(a.delivery(pending.id), ready.value.envelope);
  } finally {
    f.close();
  }
});

test("Failed reservation rolls back sequence allocation and content; stale review and missing confirmation fail", async () => {
  const f = await fixture();
  try {
    const a = f.outbox(),
      request = f.request();
    await assert.rejects(a.enqueue({ ...request, confirmed: false }), /DENIED/);
    await assert.rejects(
      a.enqueue({ ...request, expectedPeerRevision: 2 }),
      /CONFLICT/,
    );
    f.store.db.exec(
      "CREATE TRIGGER fail_reserve BEFORE INSERT ON private_task_outbox BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    );
    await assert.rejects(a.enqueue(request), /DENIED/);
    assert.equal(f.store.exportPrivateTaskOutbox(owner).length, 0);
    assert.equal(
      (
        f.store.db
          .prepare("SELECT COUNT(*) AS n FROM private_send_channels")
          .get() as any
      ).n,
      0,
    );
    f.store.db.exec("DROP TRIGGER fail_reserve");
    assert.equal((await a.enqueue(request)).value.header.sequence, 1);
  } finally {
    f.close();
  }
});

test("Consent loss, key changes and revocation prevent publication after asynchronous sealing", async () => {
  const f = await fixture();
  try {
    const original = f.getPermission()!;
    let calls = 0;
    // enqueue checks twice, prepare checks once, then checks again after sealing.
    const a = f.outbox(f.store, owner, () => {
      if (++calls === 4) f.setPermission(null);
      return f.getPermission();
    });
    await assert.rejects(a.enqueue(f.request()), /DENIED/);
    const entry = f.store.exportPrivateTaskOutbox(owner)[0]!;
    assert.equal(entry.value.envelope, null);
    f.setPermission(original);
    await f.outbox().resume(entry.id);
    f.setPermission({ ...original, permissionRevision: 2 });
    assert.throws(() => f.outbox().delivery(entry.id), /DENIED/);
    f.setPermission(original);
    f.setBinding(null);
    assert.throws(() => f.outbox().delivery(entry.id), /DENIED/);
    f.setBinding(f.binding);
    f.peers.revoke({
      peerId: f.targetBinding.deviceId,
      expectedRevision: f.peers.list().revision,
      confirmed: true,
    });
    assert.throws(() => f.outbox().delivery(entry.id), /DENIED/);
  } finally {
    f.close();
  }
});

test("Stopping local retries is revision guarded and a late encrypted receipt still records actual acceptance", async () => {
  const f = await fixture();
  try {
    const a = f.outbox(),
      entry = await a.enqueue(f.request()),
      wire = a.delivery(entry.id),
      receipt = await f.receiver.accept(wire);
    assert.throws(
      () =>
        a.stop({
          id: entry.id,
          expectedRevision: entry.revision,
          confirmed: true,
        }),
      /CONFLICT/,
    );
    f.setPermission(null);
    const stopped = a.stop({
      id: entry.id,
      expectedRevision: a.get(entry.id).revision,
      confirmed: true,
    });
    assert.equal(stopped.value.state, "stopped");
    assert.throws(() => a.delivery(entry.id), /DENIED/);
    f.setPermission({
      binding: f.binding,
      peerId: f.targetBinding.deviceId,
      senderKeyEpoch: 1,
      permissionRevision: 1,
      sendingEnabled: true,
      senderKey: f.sender,
    });
    const accepted = await a.acceptReceipt(await f.ack(receipt));
    assert.equal(accepted.value.state, "accepted");
    assert.equal(f.target.get(owner, receipt.taskId).status, "queued");
    assert.throws(() => a.delivery(entry.id), /DENIED/);
  } finally {
    f.close();
  }
});

test("Unauthenticated, wrong-route, mismatched and conflicting receipts cannot claim acceptance", async () => {
  const f = await fixture();
  try {
    const a = f.outbox(),
      entry = await a.enqueue(f.request()),
      receipt = await f.receiver.accept(a.delivery(entry.id));
    await assert.rejects(a.acceptReceipt(receipt), /DENIED/);
    await assert.rejects(
      a.acceptReceipt(await f.ack(receipt, {}, await pair())),
      /DENIED/,
    );
    for (const change of [
      { operationId: randomUUID() },
      { senderId: randomUUID() },
      { recipientKeyEpoch: 2 },
    ])
      await assert.rejects(
        a.acceptReceipt(await f.ack(receipt, change)),
        /DENIED/,
      );
    for (const altered of [
      { ...receipt, header: { ...receipt.header, sequence: 999 } },
      { ...receipt, acceptedAt: receipt.header.expiresAt },
    ])
      await assert.rejects(a.acceptReceipt(await f.ack(altered)), /DENIED/);
    assert.equal(a.get(entry.id).value.state, "pending");
    await a.acceptReceipt(await f.ack(receipt));
    await assert.rejects(
      a.acceptReceipt(await f.ack({ ...receipt, id: randomUUID() })),
      /CONFLICT/,
    );
  } finally {
    f.close();
  }
});

test("Expired outgoing requests are never resealed or retried, but fresh authenticated receipts can reconcile earlier acceptance", async () => {
  const f = await fixture(172800000);
  try {
    const a = f.outbox(),
      entry = await a.enqueue(f.request()),
      receipt = await f.receiver.accept(a.delivery(entry.id));
    f.advance(86400001);
    assert.throws(() => a.delivery(entry.id), /DENIED/);
    assert.deepEqual(a.get(entry.id).value.envelope, entry.value.envelope);
    assert.equal(
      (await a.acceptReceipt(await f.ack(receipt))).value.state,
      "accepted",
    );
  } finally {
    f.close();
  }
});

test("Backup restore locks pending deliveries; deletion removes outbox, channels and plaintext history", async () => {
  const f = await fixture();
  let restored: Store | undefined;
  try {
    const a = f.outbox(),
      entry = await a.enqueue(f.request()),
      backup = join(f.dir, "backup.aib"),
      path = join(f.dir, "restored.db");
    await encryptedBackup(f.store, f.vault, backup);
    await restoreBackup(backup, f.vault, path);
    restored = new Store(path, f.vault, f.clock);
    assert.equal(f.outbox(restored).get(entry.id).locked, true);
    assert.throws(() => f.outbox(restored).delivery(entry.id), /DENIED/);
    await assert.rejects(f.outbox(restored).resume(entry.id), /DENIED/);
    const retry = f.request();
    f.store.deleteAll(owner);
    assert.deepEqual(f.store.exportPrivateTaskOutbox(owner), []);
    assert.equal(
      (
        f.store.db
          .prepare("SELECT COUNT(*) AS n FROM private_send_channels")
          .get() as any
      ).n,
      0,
    );
    await assert.rejects(a.enqueue(retry), /DENIED/);
  } finally {
    restored?.close();
    f.close();
  }
});

test("Outbox history is encrypted and owner-bound, and capacity stops new work without dropping earlier envelopes", async () => {
  const f = await fixture();
  try {
    const a = f.outbox(),
      request = f.request(),
      entry = await a.enqueue(request),
      row = f.store.db
        .prepare("SELECT * FROM private_task_outbox")
        .get() as any;
    assert.equal(
      row.payload.includes(Buffer.from(request.content.prompt)),
      false,
    );
    assert.equal(
      row.payload.includes(Buffer.from(f.targetBinding.deviceId)),
      false,
    );
    assert.deepEqual(f.store.exportPrivateTaskOutbox(other), []);
    f.store.db
      .prepare("INSERT INTO private_task_outbox VALUES(?,?,?,?,?,?,?,?)")
      .run(
        other.userId,
        other.tenantId,
        row.id,
        row.client_hash,
        row.operation_hash,
        row.revision,
        row.locked,
        row.payload,
      );
    assert.throws(
      () => f.store.exportPrivateTaskOutbox(other),
      /STORAGE_UNAVAILABLE/,
    );
    assert.throws(
      () => f.outbox(f.store, other).delivery(entry.id),
      /STORAGE_UNAVAILABLE/,
    );
    f.store.db.transaction(() => {
      for (let i = 1; i < 256; i++)
        f.store.db
          .prepare("INSERT INTO private_task_outbox VALUES(?,?,?,?,?,?,?,?)")
          .run(
            owner.userId,
            owner.tenantId,
            randomUUID(),
            `cap-client-${i}`,
            `cap-op-${i}`,
            1,
            0,
            row.payload,
          );
    })();
    await assert.rejects(a.enqueue(f.request()), /CAPACITY/);
    assert.deepEqual(a.delivery(entry.id), entry.value.envelope);
    assert.equal((await a.enqueue(request)).id, entry.id);
  } finally {
    f.close();
  }
});

test("Caller mutations and oversized or authority-bearing payloads cannot change the reviewed outgoing task", async () => {
  const f = await fixture();
  try {
    const a = f.outbox(),
      request = f.request(),
      running = a.enqueue(request);
    request.content.prompt = "MUTATED";
    const first = await running;
    assert.equal(first.value.content.prompt, "PRIVATE_OUTBOX_PROMPT");
    const before = f.store.exportPrivateTaskOutbox(owner).length;
    for (const content of [
      { ...request.content, sourceRefs: [] },
      { ...request.content, prompt: "\u0800".repeat(32000) },
      { ...request.content, modelProfileId: "cloud" },
    ])
      await assert.rejects(a.enqueue({ ...f.request(), content }), /DENIED/);
    assert.equal(f.store.exportPrivateTaskOutbox(owner).length, before);
    const pending = Array.from({ length: 4 }, () => a.enqueue(f.request()));
    await assert.rejects(a.enqueue(f.request()), /CAPACITY/);
    await Promise.all(pending);
  } finally {
    f.close();
  }
});

test("Schema14 migration preserves tasks and receipts while initializing an empty sender outbox", async () => {
  const f = await fixture();
  let migrated: Store | undefined;
  try {
    const a = f.outbox(),
      entry = await a.enqueue(f.request()),
      receipt = await f.receiver.accept(a.delivery(entry.id));
    f.target.db.exec(
      "DROP TABLE private_task_outbox; DROP TABLE private_send_channels; PRAGMA user_version=14",
    );
    f.target.close();
    migrated = new Store(join(f.dir, "target.db"), f.targetVault, f.clock);
    assert.equal(migrated.db.pragma("user_version", { simple: true }), 24);
    assert.deepEqual(migrated.exportPrivateTaskReceipts(owner), [receipt]);
    assert.equal(
      migrated.get(owner, receipt.taskId).input.prompt,
      entry.value.content.prompt,
    );
    assert.deepEqual(migrated.exportPrivateTaskOutbox(owner), []);
  } finally {
    migrated?.close();
    f.close();
  }
});

test("Authenticated local export and confirmed deletion manage outbox history without enabling a sending route", async () => {
  const f = await fixture(),
    { createServer } = await import("node:http"),
    { localApi } = await import("../apps/companion/http.js"),
    server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port,
    token = "private-outbox-test".repeat(4);
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
    const entry = await f.outbox().enqueue(f.request()),
      response = await call("/v1/export");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(((await response.json()) as any).privateTaskOutbox, [
      entry,
    ]);
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/v1/export`)).status,
      401,
    );
    assert.equal((await call("/v1/remote/private-outbox", "POST")).status, 404);
    assert.equal((await call("/v1/data", "DELETE")).status, 400);
    assert.equal(f.store.exportPrivateTaskOutbox(owner).length, 1);
    assert.equal((await call("/v1/data", "DELETE", true)).status, 204);
    assert.deepEqual(
      ((await (await call("/v1/export")).json()) as any).privateTaskOutbox,
      [],
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    f.close();
  }
});
