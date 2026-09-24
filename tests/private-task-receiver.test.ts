import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
import { PrivatePeerEnrollment } from "../modules/remote/private-peers.js";
import {
  PrivateTaskReceiver,
  type PrivateTaskAuthority,
} from "../modules/remote/private-task-receiver.js";
import {
  privateEnvelopeSuite,
  sealPrivateEnvelope,
  type PrivateHeader,
} from "../modules/remote/private-envelope.js";
import { LocalWorker } from "../apps/companion/worker.js";
const owner = { userId: "alice", tenantId: "personal" },
  other = { userId: "bob", tenantId: "personal" };
const profile = {
  id: "local",
  runtime: "ollama",
  model: "synthetic",
  contextTokens: 4096,
  maxOutputTokens: 1024,
  temperature: 0.2,
} as const;
const pair = () =>
  crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
const input = {
  version: 1,
  type: "task.submit",
  kind: "query",
  prompt: "PRIVATE_SYNTHETIC_PROMPT",
};
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "private-task-")),
    path = join(dir, "tasks.db"),
    vault = new Vault(randomBytes(32));
  let now = 1800000000000;
  const clock = () => now,
    store = new Store(path, vault, clock);
  store.addProfile(owner, profile);
  const binding = {
      ownerId: randomUUID(),
      deviceId: randomUUID(),
      credentialEpoch: 1,
      expiresAt: now + 3600000,
    },
    sender = await pair(),
    recipient = await pair(),
    peerId = randomUUID();
  let current: typeof binding | null = binding;
  const getBinding = () => current;
  const registry = new PrivatePeerEnrollment(
    store,
    vault,
    owner,
    getBinding,
    clock,
  );
  const review = await registry.prepare({
    version: 1,
    ownerId: binding.ownerId,
    recipientId: binding.deviceId,
    peerId,
    keyEpoch: 1,
    publicKey: Buffer.from(
      await crypto.subtle.exportKey("raw", sender.publicKey),
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
  let permission: PrivateTaskAuthority | null = {
    binding,
    peerId,
    recipientKeyEpoch: 1,
    permissionRevision: 1,
    modelProfileId: profile.id,
    tasksEnabled: true,
    recipientKey: recipient,
  };
  const getPermission = () => permission;
  const receiver = (target = store, scope = owner, provider = getPermission) =>
    new PrivateTaskReceiver(target, vault, scope, getBinding, provider, clock);
  const header = (): PrivateHeader => ({
    version: 1,
    suite: privateEnvelopeSuite,
    ownerId: binding.ownerId,
    senderId: peerId,
    recipientId: binding.deviceId,
    senderKeyEpoch: 1,
    recipientKeyEpoch: 1,
    messageId: randomUUID(),
    operationId: randomUUID(),
    sequence: 1,
    issuedAt: now,
    expiresAt: now + 300000,
  });
  const seal = (h = header(), payload: unknown = input, key = sender) =>
    sealPrivateEnvelope(
      h,
      new TextEncoder().encode(JSON.stringify(payload)),
      { senderKey: key, recipientPublicKey: recipient.publicKey },
      clock,
    );
  return {
    dir,
    path,
    vault,
    store,
    registry,
    binding,
    peerId,
    sender,
    recipient,
    clock,
    receiver,
    header,
    seal,
    getPermission,
    getBinding,
    setPermission: (p: PrivateTaskAuthority | null) => {
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
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("Private task admission persists one receipt and one guarded local task through duplicate races, worker completion and restart", async () => {
  const f = await fixture();
  let reopened: Store | undefined;
  try {
    const envelope = await f.seal(),
      receiver = f.receiver();
    const [first, duplicate] = await Promise.all([
      receiver.accept(envelope),
      receiver.accept(envelope),
    ]);
    assert.deepEqual(first, duplicate);
    assert.equal(f.store.list(owner).length, 1);
    const task = f.store.get(owner, first.taskId);
    assert.equal(task.input.prompt, input.prompt);
    assert.equal(task.input.modelProfileId, "local");
    assert.deepEqual(task.input.sourceRefs, []);
    assert.equal(task.input.memoryIds, undefined);
    assert.deepEqual(f.store.exportPrivateTaskReceipts(owner), [first]);
    assert.deepEqual(f.store.exportPrivateTaskReceipts(other), []);
    const row = f.store.db
      .prepare("SELECT * FROM private_task_receipts")
      .get() as any;
    assert.equal(JSON.stringify(row).includes(input.prompt), false);
    assert.equal(row.payload.includes(Buffer.from(f.peerId)), false);
    let generations = 0;
    const worker = new LocalWorker(
      f.store,
      owner,
      {
        pin: async () => ({ profile, digest: "a".repeat(64) }),
        generate: async () => {
          generations++;
          return "synthetic result";
        },
      },
      (id) => f.store.profile(owner, id),
    );
    assert.equal(await worker.runOnce(), true);
    assert.equal(await worker.runOnce(), false);
    assert.equal(generations, 1);
    assert.equal(f.store.get(owner, first.taskId).status, "completed");
    f.store.close();
    reopened = new Store(f.path, f.vault, f.clock);
    assert.deepEqual(await f.receiver(reopened).accept(envelope), first);
    assert.equal(reopened.list(owner).length, 1);
  } finally {
    reopened?.close();
    f.close();
  }
});

test("Conflicting operation, message, sequence and freshly encrypted retry cannot create another task", async () => {
  const f = await fixture();
  try {
    const receiver = f.receiver(),
      h = f.header(),
      original = await f.seal(h);
    await receiver.accept(original);
    for (const change of [
      {},
      { operationId: randomUUID() },
      { messageId: randomUUID() },
      { sequence: 2 },
      { operationId: randomUUID(), messageId: randomUUID() },
    ])
      await assert.rejects(
        receiver.accept(await f.seal({ ...h, ...change })),
        /CONFLICT/,
      );
    // Different sequence values may arrive out of order; every identity is retained.
    await receiver.accept(await f.seal({ ...f.header(), sequence: 10 }));
    await receiver.accept(await f.seal({ ...f.header(), sequence: 3 }));
    assert.equal(f.store.list(owner).length, 3);
  } finally {
    f.close();
  }
});

test("Receipt write failure rolls back the task, conversation, event and idempotency reservation", async () => {
  const f = await fixture();
  try {
    const e = await f.seal(),
      r = f.receiver();
    f.store.db.exec(
      "CREATE TRIGGER fail_private_receipt BEFORE INSERT ON private_task_receipts BEGIN SELECT RAISE(ABORT,'synthetic-failure'); END",
    );
    await assert.rejects(r.accept(e), /DENIED/);
    for (const table of [
      "tasks",
      "conversations",
      "events",
      "idempotency",
      "private_task_receipts",
    ])
      assert.equal(
        (
          f.store.db
            .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
            .get() as any
        ).count,
        0,
      );
    f.store.db.exec("DROP TRIGGER fail_private_receipt");
    await r.accept(e);
    assert.equal(f.store.list(owner).length, 1);
  } finally {
    f.close();
  }
});

test("Current per-peer consent, pairing, pin and key must survive asynchronous decryption", async () => {
  const f = await fixture();
  try {
    const e = await f.seal(),
      permission = f.getPermission()!;
    f.setPermission(null);
    await assert.rejects(f.receiver().accept(e), /DENIED/);
    f.setPermission(permission);
    await assert.rejects(f.receiver(f.store, other).accept(e), /DENIED/);
    f.setBinding({ ...f.binding, ownerId: randomUUID() });
    await assert.rejects(f.receiver().accept(e), /DENIED/);
    f.setBinding(f.binding);
    for (const mutation of [
      () => f.setPermission(null),
      () => f.setPermission({ ...permission, permissionRevision: 2 }),
      () => f.setPermission({ ...permission, recipientKeyEpoch: 2 }),
      () => f.setBinding(null),
      () => f.advance(300001),
    ]) {
      let calls = 0;
      const r = f.receiver(f.store, owner, () => {
        if (++calls === 2) mutation();
        return f.getPermission();
      });
      await assert.rejects(r.accept(e), /DENIED/);
      f.setPermission(permission);
      f.setBinding(f.binding);
    }
    assert.equal(f.store.list(owner).length, 0);
  } finally {
    f.close();
  }
});

test("Revoking a pin after crypto but before the final commit fences acceptance", async () => {
  const f = await fixture();
  try {
    const e = await f.seal();
    let calls = 0;
    const r = f.receiver(f.store, owner, () => {
      if (++calls === 2)
        f.registry.revoke({
          peerId: f.peerId,
          expectedRevision: f.registry.list().revision,
          confirmed: true,
        });
      return f.getPermission();
    });
    await assert.rejects(r.accept(e), /DENIED/);
    assert.equal(f.store.list(owner).length, 0);
  } finally {
    f.close();
  }
});

test("Wrong sender, altered routes and forbidden inner authority fail without receipts", async () => {
  const f = await fixture();
  try {
    const r = f.receiver(),
      h = f.header();
    await assert.rejects(
      r.accept(await f.seal(h, input, await pair())),
      /DENIED/,
    );
    for (const change of [
      { ownerId: randomUUID() },
      { recipientId: randomUUID() },
      { senderKeyEpoch: 2 },
      { recipientKeyEpoch: 2 },
    ])
      await assert.rejects(
        r.accept(await f.seal({ ...h, ...change })),
        /DENIED/,
      );
    for (const payload of [
      { ...input, sourceRefs: [] },
      { ...input, memoryIds: [] },
      { ...input, modelProfileId: "other" },
      { ...input, conversationId: "existing" },
      { ...input, authority: { userId: "admin" } },
      { ...input, type: "action.approve" },
      { ...input, prompt: "" },
    ])
      await assert.rejects(r.accept(await f.seal(h, payload)), /DENIED/);
    const e = await f.seal();
    e.header.sequence++;
    await assert.rejects(r.accept(e), /DENIED/);
    assert.equal(f.store.list(owner).length, 0);
    assert.deepEqual(f.store.exportPrivateTaskReceipts(owner), []);
  } finally {
    f.close();
  }
});

test("Two database connections atomically reconcile the same authenticated operation", async () => {
  const f = await fixture(),
    second = new Store(f.path, f.vault, f.clock);
  try {
    const e = await f.seal(),
      [a, b] = await Promise.all([
        f.receiver().accept(e),
        f.receiver(second).accept(e),
      ]);
    assert.deepEqual(a, b);
    assert.equal(second.list(owner).length, 1);
    assert.equal(second.exportPrivateTaskReceipts(owner).length, 1);
  } finally {
    second.close();
    f.close();
  }
});

test("Supported restore retains receipts but locks admission; deletion removes receipts and prevents old identity reuse", async () => {
  const f = await fixture();
  let restored: Store | undefined;
  try {
    const e = await f.seal(),
      receipt = await f.receiver().accept(e),
      backup = join(f.dir, "backup.aib"),
      path = join(f.dir, "restored.db");
    await encryptedBackup(f.store, f.vault, backup);
    await restoreBackup(backup, f.vault, path);
    restored = new Store(path, f.vault, f.clock);
    assert.deepEqual(restored.exportPrivateTaskReceipts(owner), [receipt]);
    await assert.rejects(f.receiver(restored).accept(e), /DENIED/);
    const registry = new PrivatePeerEnrollment(
      restored,
      f.vault,
      owner,
      f.getBinding,
      f.clock,
    );
    assert.throws(
      () =>
        registry.reset({
          expectedRevision: restored!.exportPrivatePeerTrust(owner).revision,
          confirmed: true,
        }),
      /REPAIR_REQUIRED/,
    );
    f.store.deleteAll(owner);
    assert.deepEqual(f.store.exportPrivateTaskReceipts(owner), []);
    assert.equal(f.store.list(owner).length, 0);
    await assert.rejects(f.receiver().accept(e), /DENIED/);
  } finally {
    restored?.close();
    f.close();
  }
});

test("Pending input is snapshotted and bounded concurrent work cannot bypass the receipt capacity", async () => {
  const f = await fixture();
  try {
    const e = await f.seal(),
      r = f.receiver(),
      running = r.accept(e);
    e.header.operationId = randomUUID();
    e.ciphertext = "bad";
    const original = await running;
    assert.notEqual(original.header.operationId, e.header.operationId);
    const valid = await f.seal({ ...f.header(), sequence: 2 });
    const pending = Array.from({ length: 4 }, () => r.accept(valid));
    await assert.rejects(r.accept(valid), /CAPACITY/);
    await Promise.all(pending);
    const seed = f.store.db
      .prepare("SELECT * FROM private_task_receipts LIMIT 1")
      .get() as any;
    const insert = f.store.db.prepare(
      "INSERT INTO private_task_receipts VALUES(?,?,?,?,?,?,?)",
    );
    f.store.db.transaction(() => {
      for (let i = 2; i < 1024; i++)
        insert.run(
          owner.userId,
          owner.tenantId,
          `capacity-op-${i}`,
          `capacity-msg-${i}`,
          `capacity-seq-${i}`,
          seed.envelope_hash,
          seed.payload,
        );
    })();
    await assert.rejects(
      r.accept(await f.seal({ ...f.header(), sequence: 3 })),
      /CAPACITY/,
    );
    assert.equal(f.store.list(owner).length, 2);
    assert.equal((await r.accept(valid)).status, "accepted");
  } finally {
    f.close();
  }
});

test("Schema13 migration preserves existing tasks and owner-bound receipt ciphertext cannot be copied", async () => {
  const f = await fixture();
  let migrated: Store | undefined;
  try {
    const receipt = await f.receiver().accept(await f.seal()),
      row = f.store.db
        .prepare("SELECT * FROM private_task_receipts")
        .get() as any;
    f.store.db
      .prepare("INSERT INTO private_task_receipts VALUES(?,?,?,?,?,?,?)")
      .run(
        other.userId,
        other.tenantId,
        row.operation_hash,
        row.message_hash,
        row.sequence_hash,
        row.envelope_hash,
        row.payload,
      );
    assert.throws(() => f.store.exportPrivateTaskReceipts(other));
    f.store.db.exec("DROP TABLE private_task_receipts; PRAGMA user_version=13");
    f.store.close();
    migrated = new Store(f.path, f.vault, f.clock);
    assert.equal(migrated.db.pragma("user_version", { simple: true }), 31);
    assert.equal(
      migrated.get(owner, receipt.taskId).input.prompt,
      input.prompt,
    );
    assert.deepEqual(migrated.exportPrivateTaskReceipts(owner), []);
  } finally {
    migrated?.close();
    f.close();
  }
});

test("Local authenticated export and confirmed deletion include receipts; no remote submission route is exposed", async () => {
  const f = await fixture(),
    { createServer } = await import("node:http"),
    { localApi } = await import("../apps/companion/http.js"),
    server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port,
    token = "private-receipt-test".repeat(4);
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
    const receipt = await f.receiver().accept(await f.seal()),
      response = await call("/v1/export");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(((await response.json()) as any).privateTaskReceipts, [
      receipt,
    ]);
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/v1/export`)).status,
      401,
    );
    assert.equal((await call("/v1/remote/private-tasks", "POST")).status, 404);
    assert.equal((await call("/v1/data", "DELETE")).status, 400);
    assert.equal(f.store.exportPrivateTaskReceipts(owner).length, 1);
    assert.equal((await call("/v1/data", "DELETE", true)).status, 204);
    assert.deepEqual(
      ((await (await call("/v1/export")).json()) as any).privateTaskReceipts,
      [],
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    f.close();
  }
});

test("Conflicting concurrent ciphertext has one winner and post-rotation operation reuse remains denied", async () => {
  const f = await fixture(),
    second = new Store(f.path, f.vault, f.clock);
  try {
    const h = f.header(),
      a = await f.seal(h),
      b = await f.seal(h, { ...input, prompt: "different" });
    const outcomes = await Promise.allSettled([
      f.receiver().accept(a),
      f.receiver(second).accept(b),
    ]);
    assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(
      outcomes.filter(
        (x) => x.status === "rejected" && /CONFLICT/.test(x.reason.message),
      ).length,
      1,
    );
    const key = await pair();
    const review = await f.registry.prepare({
      version: 1,
      ownerId: f.binding.ownerId,
      recipientId: f.binding.deviceId,
      peerId: f.peerId,
      keyEpoch: 2,
      publicKey: Buffer.from(
        await crypto.subtle.exportKey("raw", key.publicKey),
      ).toString("base64url"),
      nonce: randomUUID(),
      issuedAt: f.clock(),
      expiresAt: f.clock() + 300000,
    });
    f.registry.approve({
      reviewId: review.reviewId,
      expectedRevision: review.expectedRevision,
      comparedFingerprint: review.fingerprint,
      confirmed: true,
    });
    await assert.rejects(f.receiver().accept(a), /DENIED/);
    await assert.rejects(
      f
        .receiver()
        .accept(
          await f.seal(
            { ...h, senderKeyEpoch: 2, messageId: randomUUID() },
            input,
            key,
          ),
        ),
      /CONFLICT/,
    );
    assert.equal(f.store.list(owner).length, 1);
  } finally {
    second.close();
    f.close();
  }
});

test("Crossing admission expiry during the transaction rolls back the task; expired duplicates never requeue", async (t) => {
  const f = await fixture();
  try {
    const e = await f.seal(),
      create = f.store.create.bind(f.store);
    const mock = t.mock.method(
      f.store,
      "create",
      (...args: Parameters<Store["create"]>) => {
        const task = create(...args);
        f.advance(300001);
        return task;
      },
    );
    await assert.rejects(f.receiver().accept(e), /DENIED/);
    assert.equal(f.store.list(owner).length, 0);
    assert.deepEqual(f.store.exportPrivateTaskReceipts(owner), []);
    mock.mock.restore();
    const fresh = await f.seal(),
      receipt = await f.receiver().accept(fresh);
    f.advance(300001);
    await assert.rejects(f.receiver().accept(fresh), /DENIED/);
    assert.deepEqual(f.store.exportPrivateTaskReceipts(owner), [receipt]);
    assert.equal(f.store.list(owner).length, 1);
  } finally {
    f.close();
  }
});
