import {
  PrivateTaskResponses,
  type PrivateResponseAuthority,
} from "../modules/remote/private-task-responses.js";
import { openPrivateEnvelope } from "../modules/remote/private-envelope.js";
import {
  privateResultPayloadSchema,
  privateAcceptedPayloadSchema,
} from "../modules/remote/private-task-contracts.js";
import { LocalWorker } from "../apps/companion/worker.js";
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
  const dir = mkdtempSync(join(tmpdir(), "private-responses-")),
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
  let responsePermission: PrivateResponseAuthority | null = {
    binding: targetBinding,
    peerId: binding.deviceId,
    senderKeyEpoch: 1,
    permissionRevision: 1,
    admissionRevision: 1,
    acceptanceEnabled: true,
    resultsEnabled: true,
    senderKey: recipient,
  };
  const responses = (
    db = target,
    scope = owner,
    provider = () => responsePermission,
  ) =>
    new PrivateTaskResponses(
      db,
      targetVault,
      scope,
      () => targetBinding,
      provider,
      clock,
    );
  const submit = async () => {
    const entry = await outbox().enqueue(request()),
      receipt = await receiver.accept(outbox().delivery(entry.id));
    return { entry, receipt };
  };
  const prepare = (
    receipt: PrivateTaskReceipt,
    kind: "accepted" | "result" = "accepted",
  ) => ({
    operationId: receipt.header.operationId,
    peerId: binding.deviceId,
    kind,
    confirmed: true,
  });
  const execute = async () => {
    const worker = new LocalWorker(
      target,
      owner,
      {
        pin: async () => ({
          profile: target.profile(owner, "local"),
          digest: "a".repeat(64),
        }),
        generate: async () => "PRIVATE_RESPONSE_ANSWER",
      },
      (id) => target.profile(owner, id),
    );
    return worker.runOnce();
  };
  const decode = async (wire: unknown) => {
    const envelope =
      wire as import("../modules/remote/private-envelope.js").PrivateEnvelope;
    const opened = await openPrivateEnvelope(
      envelope,
      envelope.header,
      { recipientKey: sender, senderPublicKey: recipient.publicKey },
      clock,
    );
    try {
      return JSON.parse(new TextDecoder().decode(opened.plaintext));
    } finally {
      opened.plaintext.fill(0);
    }
  };
  return {
    responses,
    submit,
    prepare,
    execute,
    decode,
    getResponsePermission: () => responsePermission,
    setResponsePermission: (p: PrivateResponseAuthority | null) => {
      responsePermission = p;
    },
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

test("Companion produces durable encrypted acceptance and terminal results from actual local execution", async () => {
  const f = await fixture();
  let reopened: Store | undefined;
  try {
    const { entry, receipt } = await f.submit(),
      responses = f.responses(),
      accepted = await responses.prepare(f.prepare(receipt));
    assert.equal(
      (await f.outbox().acceptReceipt(responses.delivery(accepted.id))).value
        .state,
      "accepted",
    );
    assert.deepEqual(
      privateAcceptedPayloadSchema.parse(
        await f.decode(accepted.value.envelope),
      ).receipt,
      receipt,
    );
    await assert.rejects(
      responses.prepare(f.prepare(receipt, "result")),
      /DENIED/,
    );
    assert.equal(await f.execute(), true);
    const result = await responses.prepare(f.prepare(receipt, "result")),
      wire = responses.delivery(result.id),
      decoded = privateResultPayloadSchema.parse(await f.decode(wire));
    assert.equal(decoded.task.output, "PRIVATE_RESPONSE_ANSWER");
    assert.equal(decoded.task.status, "completed");
    assert.equal(decoded.task.id, receipt.taskId);
    assert.equal("model" in decoded.task, false);
    assert.notEqual(
      result.value.header.messageId,
      accepted.value.header.messageId,
    );
    assert.equal(
      result.value.header.operationId,
      entry.value.header.operationId,
    );
    assert.equal(
      result.value.header.sequence,
      accepted.value.header.sequence + 1,
    );
    f.target.close();
    reopened = new Store(join(f.dir, "target.db"), f.targetVault, f.clock);
    const resumed = f.responses(reopened);
    assert.deepEqual(resumed.delivery(result.id), wire);
    assert.deepEqual(
      (await resumed.prepare(f.prepare(receipt, "result"))).value.envelope,
      wire,
    );
    assert.equal(reopened.exportPrivateTaskResponses(owner).length, 2);
  } finally {
    reopened?.close();
    f.close();
  }
});

test("Responses require local admission, exact recipient and separate result consent", async () => {
  const f = await fixture();
  try {
    const { receipt } = await f.submit(),
      p = f.getResponsePermission()!;
    f.setResponsePermission({ ...p, resultsEnabled: false });
    const a = f.responses();
    await a.prepare(f.prepare(receipt));
    await f.execute();
    await assert.rejects(a.prepare(f.prepare(receipt, "result")), /DENIED/);
    for (const input of [
      { ...f.prepare(receipt), confirmed: false },
      { ...f.prepare(receipt), content: { prompt: "injected" } },
      { ...f.prepare(receipt), operationId: randomUUID() },
      { ...f.prepare(receipt), peerId: randomUUID() },
    ])
      await assert.rejects(a.prepare(input), /DENIED/);
    await assert.rejects(
      f.responses(f.target, other).prepare(f.prepare(receipt)),
      /DENIED/,
    );
    f.setResponsePermission({ ...p, admissionRevision: 2 });
    await assert.rejects(a.prepare(f.prepare(receipt)), /DENIED/);
    f.setResponsePermission(p);
    assert.equal(
      (await a.prepare(f.prepare(receipt, "result"))).value.state,
      "pending",
    );
  } finally {
    f.close();
  }
});

test("Response consent, peer revocation, task changes and key changes fence publication and retries", async () => {
  const f = await fixture();
  try {
    const { receipt } = await f.submit(),
      p = f.getResponsePermission()!,
      a = f.responses();
    await f.execute();
    const result = await a.prepare(f.prepare(receipt, "result"));
    f.setResponsePermission(null);
    assert.throws(() => a.delivery(result.id), /DENIED/);
    f.setResponsePermission({ ...p, permissionRevision: 2 });
    assert.throws(() => a.delivery(result.id), /DENIED/);
    f.setResponsePermission(p);
    f.target.db
      .prepare("UPDATE tasks SET revision=revision+1 WHERE id=?")
      .run(receipt.taskId);
    assert.throws(() => a.delivery(result.id), /DENIED/);
    const stopped = a.stop({
      id: result.id,
      expectedRevision: result.revision,
      confirmed: true,
    });
    assert.equal(stopped.value.state, "stopped");
    const next = await f.submit();
    let reads = 0;
    const swapped = await pair();
    const changing = f.responses(f.target, owner, () =>
      ++reads >= 4 ? { ...p, senderKey: swapped } : p,
    );
    await assert.rejects(changing.prepare(f.prepare(next.receipt)), /DENIED/);
    assert.equal(
      f.target
        .exportPrivateTaskResponses(owner)
        .find(
          (x) => x.value.header.operationId === next.receipt.header.operationId,
        )?.value.envelope,
      null,
    );
    const pending = await a.prepare(f.prepare(next.receipt));
    f.targetPeers.revoke({
      peerId: f.binding.deviceId,
      expectedRevision: f.targetPeers.list().revision,
      confirmed: true,
    });
    assert.throws(() => a.delivery(pending.id), /DENIED/);
  } finally {
    f.close();
  }
});

test("Failed response publication resumes original reservation; failed reservation rolls back channel sequence", async () => {
  const f = await fixture();
  try {
    const { receipt } = await f.submit(),
      a = f.responses();
    f.target.db.exec(
      "CREATE TRIGGER fail_response_reserve BEFORE INSERT ON private_task_responses BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    );
    await assert.rejects(a.prepare(f.prepare(receipt)), /DENIED/);
    assert.equal(f.target.exportPrivateTaskResponses(owner).length, 0);
    assert.equal(
      (
        f.target.db
          .prepare("SELECT COUNT(*) AS n FROM private_send_channels")
          .get() as { n: number }
      ).n,
      0,
    );
    f.target.db.exec(
      "DROP TRIGGER fail_response_reserve; CREATE TRIGGER fail_response_publish BEFORE UPDATE ON private_task_responses BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    );
    await assert.rejects(a.prepare(f.prepare(receipt)), /DENIED/);
    const reserved = f.target.exportPrivateTaskResponses(owner)[0]!;
    assert.equal(reserved.value.state, "preparing");
    assert.equal(reserved.value.header.sequence, 1);
    f.target.db.exec("DROP TRIGGER fail_response_publish");
    const resumed = await a.resume(reserved.id);
    assert.equal(resumed.value.state, "pending");
    assert.deepEqual(resumed.value.header, reserved.value.header);
    assert.equal((await a.prepare(f.prepare(receipt))).id, reserved.id);
  } finally {
    f.close();
  }
});

test("Concurrent connections deduplicate responses and share directed sequences with outgoing tasks", async () => {
  const f = await fixture(),
    second = new Store(join(f.dir, "target.db"), f.targetVault, f.clock);
  try {
    const { receipt } = await f.submit();
    const [a, b] = await Promise.all([
      f.responses().prepare(f.prepare(receipt)),
      f.responses(second).prepare(f.prepare(receipt)),
    ]);
    assert.equal(a.id, b.id);
    assert.deepEqual(a.value.envelope, b.value.envelope);
    const reverse = new PrivateTaskOutbox(
      f.target,
      f.targetVault,
      owner,
      () => f.targetBinding,
      () => ({
        binding: f.targetBinding,
        peerId: f.binding.deviceId,
        senderKeyEpoch: 1,
        permissionRevision: 1,
        sendingEnabled: true,
        senderKey: f.recipient,
      }),
      f.clock,
    );
    const outgoing = await reverse.enqueue({
      ...f.request(),
      peerId: f.binding.deviceId,
      expectedPeerRevision: f.targetPeers.list().revision,
    });
    assert.equal(outgoing.value.header.sequence, a.value.header.sequence + 1);
    await f.execute();
    const result = await f.responses().prepare(f.prepare(receipt, "result"));
    assert.equal(
      result.value.header.sequence,
      outgoing.value.header.sequence + 1,
    );
  } finally {
    second.close();
    f.close();
  }
});

test("Failed and cancelled results carry terminal status without raw errors or invented text", async () => {
  const f = await fixture();
  try {
    const one = await f.submit(),
      claim = f.target.claim(owner, "test")!;
    f.target.fail(
      owner,
      claim.task.id,
      claim.workerId,
      claim.generation,
      false,
      "invalid_model_output",
    );
    const failed = await f
      .responses()
      .prepare(f.prepare(one.receipt, "result"));
    assert.equal(failed.value.content.type, "task.result");
    const result = privateResultPayloadSchema.parse(
      await f.decode(failed.value.envelope),
    );
    assert.equal(result.task.status, "failed");
    assert.equal(result.task.output, null);
    const two = await f.submit();
    const task = f.target.get(owner, two.receipt.taskId);
    f.target.command(owner, task.id, {
      command: "cancel",
      expectedRevision: task.revision,
    });
    const cancelled = await f
      .responses()
      .prepare(f.prepare(two.receipt, "result"));
    assert.equal(
      privateResultPayloadSchema.parse(await f.decode(cancelled.value.envelope))
        .task.status,
      "cancelled",
    );
  } finally {
    f.close();
  }
});

test("Response output excludes source and memory projections and rejects oversized encoded results without truncation", async () => {
  const f = await fixture();
  try {
    const { receipt } = await f.submit();
    await f.execute();
    const task = f.target.get(owner, receipt.taskId),
      original = task.result as object;
    for (const value of [
      { ...original, source: { private: "hidden" } },
      { ...original, memories: [{ id: "hidden" }] },
      { ...original, text: "\u0800".repeat(24000) },
    ]) {
      f.target.db
        .prepare("UPDATE tasks SET result=? WHERE id=?")
        .run(f.targetVault.seal(value, "result:" + task.id), task.id);
      await assert.rejects(
        f.responses().prepare(f.prepare(receipt, "result")),
        /DENIED|CAPACITY/,
      );
      assert.equal(f.target.exportPrivateTaskResponses(owner).length, 0);
    }
    f.target.db
      .prepare("UPDATE tasks SET result=? WHERE id=?")
      .run(f.targetVault.seal(original, "result:" + task.id), task.id);
    for (const input of [
      { ...task.input, memoryIds: ["hidden-memory"] },
      { ...task.input, dependencies: [randomUUID()] },
      {
        ...task.input,
        sourceRefs: [
          {
            app: "crm",
            tenantId: "private",
            resourceId: "hidden",
            revision: "1",
          },
        ],
      },
    ]) {
      f.target.db
        .prepare("UPDATE tasks SET input=? WHERE id=?")
        .run(f.targetVault.seal(input, "task:" + task.id), task.id);
      await assert.rejects(
        f.responses().prepare(f.prepare(receipt, "result")),
        /DENIED/,
      );
    }
    f.target.db
      .prepare("UPDATE tasks SET input=? WHERE id=?")
      .run(f.targetVault.seal(task.input, "task:" + task.id), task.id);
    assert.equal(
      (await f.responses().prepare(f.prepare(receipt, "result"))).value.state,
      "pending",
    );
  } finally {
    f.close();
  }
});

test("Stopped or expired response envelopes are not resealed or silently renewed", async () => {
  const f = await fixture();
  try {
    const { receipt } = await f.submit(),
      a = f.responses(),
      entry = await a.prepare(f.prepare(receipt));
    const stopped = a.stop({
      id: entry.id,
      expectedRevision: entry.revision,
      confirmed: true,
    });
    assert.throws(() => a.delivery(entry.id), /DENIED/);
    assert.equal((await a.prepare(f.prepare(receipt))).value.state, "stopped");
    assert.deepEqual(
      (await a.resume(entry.id)).value.envelope,
      entry.value.envelope,
    );
    assert.throws(
      () =>
        a.stop({
          id: entry.id,
          expectedRevision: entry.revision,
          confirmed: true,
        }),
      /CONFLICT/,
    );
    f.advance(3600000);
    await assert.rejects(a.resume(stopped.id), /DENIED/);
    assert.throws(() => a.delivery(entry.id), /DENIED/);
  } finally {
    f.close();
  }
});

test("Response ciphertext is owner encrypted, exported, deleted and independently locked after backup restore", async () => {
  const f = await fixture();
  let restored: Store | undefined;
  try {
    const { receipt } = await f.submit();
    await f.execute();
    const a = f.responses(),
      entry = await a.prepare(f.prepare(receipt, "result"));
    const raw = f.target.db
      .prepare("SELECT payload FROM private_task_responses WHERE id=?")
      .get(entry.id) as { payload: Buffer };
    assert.equal(
      raw.payload.includes(Buffer.from("PRIVATE_RESPONSE_ANSWER")),
      false,
    );
    assert.throws(() => f.responses(f.target, other).get(entry.id), /DENIED/);
    assert.deepEqual(f.target.exportPrivateTaskResponses(owner), [entry]);
    const backup = join(f.dir, "responses.aib"),
      path = join(f.dir, "restored.db");
    await encryptedBackup(f.target, f.targetVault, backup);
    await restoreBackup(backup, f.targetVault, path);
    restored = new Store(path, f.targetVault, f.clock);
    assert.equal(f.responses(restored).get(entry.id).locked, true);
    // Even if peer rows are independently unlocked, restored response ciphertext stays locked.
    restored.db.prepare("UPDATE private_peer_states SET locked=0").run();
    assert.throws(() => f.responses(restored).delivery(entry.id), /DENIED/);
    f.target.deleteAll(owner);
    assert.deepEqual(f.target.exportPrivateTaskResponses(owner), []);
    assert.throws(() => a.delivery(entry.id), /DENIED/);
  } finally {
    restored?.close();
    f.close();
  }
});

test("Schema15 migration preserves accepted tasks and receipts and starts an empty response outbox", async () => {
  const f = await fixture();
  let migrated: Store | undefined;
  try {
    const { receipt } = await f.submit();
    f.target.db.exec(
      "DROP TABLE private_task_responses; PRAGMA user_version=15",
    );
    f.target.close();
    migrated = new Store(join(f.dir, "target.db"), f.targetVault, f.clock);
    assert.equal(migrated.db.pragma("user_version", { simple: true }), 29);
    assert.deepEqual(migrated.exportPrivateTaskReceipts(owner), [receipt]);
    assert.equal(
      migrated.get(owner, receipt.taskId).input.prompt,
      "PRIVATE_OUTBOX_PROMPT",
    );
    assert.deepEqual(migrated.exportPrivateTaskResponses(owner), []);
  } finally {
    migrated?.close();
    f.close();
  }
});

test("Response capacity and concurrent crypto bounds preserve existing entries", async () => {
  const f = await fixture();
  try {
    const { receipt } = await f.submit(),
      a = f.responses();
    const pending = Array.from({ length: 4 }, () =>
      a.prepare(f.prepare(receipt)),
    );
    await assert.rejects(a.prepare(f.prepare(receipt)), /CAPACITY/);
    await Promise.all(pending);
    const original = f.target.exportPrivateTaskResponses(owner)[0]!;
    const row = f.target.db
      .prepare("SELECT * FROM private_task_responses WHERE id=?")
      .get(original.id) as any;
    f.target.db.transaction(() => {
      for (let i = 0; i < 511; i++)
        f.target.db
          .prepare("INSERT INTO private_task_responses VALUES(?,?,?,?,?,?,?,?)")
          .run(
            owner.userId,
            owner.tenantId,
            randomUUID(),
            "synthetic-capacity-" + i,
            "accepted",
            1,
            0,
            row.payload,
          );
    })();
    const next = await f.submit();
    await assert.rejects(a.prepare(f.prepare(next.receipt)), /CAPACITY/);
    assert.deepEqual(a.delivery(original.id), original.value.envelope);
    assert.equal(
      (
        f.target.db
          .prepare("SELECT COUNT(*) AS count FROM private_task_responses")
          .get() as { count: number }
      ).count,
      512,
    );
  } finally {
    f.close();
  }
});

test("Local authenticated export and confirmed deletion include responses without enabling a live response route", async () => {
  const f = await fixture(),
    { createServer } = await import("node:http"),
    { localApi } = await import("../apps/companion/http.js"),
    server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port,
    token = "synthetic-response-token".repeat(3);
  server.on("request", localApi({ store: f.target, owner, port, token }));
  const call = (path: string, method = "GET", confirmed = false) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        ...(confirmed ? { "X-Confirm-Delete": "all-local-task-data" } : {}),
      },
    });
  try {
    const { receipt } = await f.submit(),
      entry = await f.responses().prepare(f.prepare(receipt));
    const response = await call("/v1/export");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(((await response.json()) as any).privateTaskResponses, [
      entry,
    ]);
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/v1/export`)).status,
      401,
    );
    assert.equal(
      (await call("/v1/remote/private-responses", "POST")).status,
      404,
    );
    assert.equal((await call("/v1/data", "DELETE")).status, 400);
    assert.equal(f.target.exportPrivateTaskResponses(owner).length, 1);
    assert.equal((await call("/v1/data", "DELETE", true)).status, 204);
    assert.deepEqual(
      ((await (await call("/v1/export")).json()) as any).privateTaskResponses,
      [],
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    f.close();
  }
});
