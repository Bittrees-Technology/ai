import { PrivatePeerChecks } from "../modules/remote/private-peer-checks.js";
import { peerCheckResponse } from "./helpers/peer-check-response.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
import { PrivateTaskConsent } from "../modules/remote/private-task-consent.js";
import { PrivateKeyLifecycle } from "../modules/remote/private-key-lifecycle.js";
import { PrivatePeerEnrollment } from "../modules/remote/private-peers.js";
import { PrivateTaskReceiver } from "../modules/remote/private-task-receiver.js";
import { PrivateTaskResponses } from "../modules/remote/private-task-responses.js";
import { PrivateTaskOutbox } from "../modules/remote/private-task-outbox.js";
import {
  sealPrivateEnvelope,
  openPrivateEnvelope,
  privateEnvelopeSuite,
} from "../modules/remote/private-envelope.js";
import { LocalWorker } from "../apps/companion/worker.js";
import { localApi } from "../apps/companion/http.js";
const owner = { userId: "synthetic", tenantId: "personal" };
const profile = {
  id: "local",
  runtime: "ollama",
  model: "synthetic",
  contextTokens: 4096,
  maxOutputTokens: 512,
  temperature: 0.2,
} as const;
class Slot {
  value?: Uint8Array;
  beforeRead?: () => Promise<void>;
  async getSecret() {
    await this.beforeRead?.();
    return this.value?.slice();
  }
  async addSecretIfAbsent(v: Uint8Array) {
    if (this.value) return false;
    this.value = Uint8Array.from(v);
    return true;
  }
  async deleteCredential() {
    this.value = undefined;
    return true;
  }
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "private-consent-")),
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
  };
  let live: typeof binding | null = binding;
  const current = () => live,
    slots = new Map<string, { key: Slot; attempt: Slot; deleted: Slot }>();
  const entries = (id: string) => {
    if (!slots.has(id))
      slots.set(id, {
        key: new Slot(),
        attempt: new Slot(),
        deleted: new Slot(),
      });
    return slots.get(id)!;
  };
  const build = (s = store, scope = owner) => {
    const keys = new PrivateKeyLifecycle(
        s,
        vault,
        scope,
        current,
        entries,
        undefined,
        clock,
      ),
      peers = new PrivatePeerEnrollment(s, vault, scope, current, clock);
    return {
      keys,
      peers,
      consent: new PrivateTaskConsent(
        s,
        vault,
        scope,
        current,
        keys,
        peers,
        clock,
      ),
    };
  };
  const { keys, peers, consent } = build();
  const reserved = keys.begin({ expectedRevision: 0, confirmed: true });
  await keys.provision({
    keyId: reserved.keyId,
    expectedRevision: reserved.revision,
    confirmed: true,
  });
  const sender = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    ),
    peerId = randomUUID();
  const review = await peers.prepare({
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
  peers.approve({
    reviewId: review.reviewId,
    expectedRevision: review.expectedRevision,
    comparedFingerprint: review.fingerprint,
    confirmed: true,
  });
  const checks = new PrivatePeerChecks(
    store,
    vault,
    owner,
    current,
    keys,
    peers,
    clock,
  );
  const check = await checks.begin({
    peerId,
    expectedKeyRevision: keys.list().revision,
    expectedPeerRevision: peers.list().revision,
    confirmed: true,
  });
  const challenge = checks.delivery({ id: check.id, confirmed: true });
  const response = await peerCheckResponse(
    challenge,
    sender,
    (await keys.resolve()).pair.publicKey,
    clock,
  );
  await checks.complete({ envelope: response, confirmed: true });
  const choices = {
    peerId,
    peerKeyEpoch: 1,
    receiveTasks: true,
    sendTasks: false,
    sendReceipts: false,
    sendResults: false,
    modelProfileId: profile.id,
    expiresAt: now + 600000,
  };
  const prepare = (overrides = {}, c = consent) =>
    c.prepare({
      expectedRevision: c.list().revision,
      choices: { ...choices, ...overrides },
    });
  const approve = (r: Awaited<ReturnType<typeof prepare>>, c = consent) =>
    c.approve({
      reviewId: r.id,
      expectedRevision: r.revision,
      confirmed: true,
      acknowledged: true,
    });
  let sequence = 0;
  const envelope = async () => {
    const local = await keys.resolve();
    const header = {
      version: 1 as const,
      suite: privateEnvelopeSuite,
      ownerId: binding.ownerId,
      senderId: peerId,
      recipientId: binding.deviceId,
      senderKeyEpoch: 1,
      recipientKeyEpoch: local.proof.keyEpoch,
      messageId: randomUUID(),
      operationId: randomUUID(),
      sequence: ++sequence,
      issuedAt: now,
      expiresAt: now + 300000,
    };
    return sealPrivateEnvelope(
      header,
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          type: "task.submit",
          kind: "query",
          prompt: "SYNTHETIC_PRIVATE_TASK",
        }),
      ),
      { senderKey: sender, recipientPublicKey: local.pair.publicKey },
      clock,
    );
  };
  return {
    dir,
    path,
    store,
    vault,
    clock,
    binding,
    current,
    keys,
    peers,
    consent,
    peerId,
    sender,
    entries,
    slots,
    build,
    choices,
    prepare,
    approve,
    envelope,
    setBinding: (b: typeof live) => {
      live = b;
    },
    time: (value: number) => {
      now = value;
    },
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("Private task consent requires explicit one-use choices and binds the original keys/model rather than a mutated preview", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.consent.resolve(f.peerId), /DENIED/);
    await assert.rejects(f.prepare({ sendResults: true }), /DENIED/);
    await assert.rejects(f.prepare({ receiveTasks: false }), /DENIED/);
    await assert.rejects(f.prepare({ expiresAt: 1800090000000 }), /DENIED/);
    await assert.rejects(f.prepare({ modelProfileId: "missing" }));
    const denied = await f.prepare();
    assert.throws(
      () =>
        f.consent.approve({
          reviewId: denied.id,
          expectedRevision: denied.revision,
          confirmed: true,
          acknowledged: false,
        }),
      /DENIED/,
    );
    assert.throws(() => f.approve(denied), /DENIED/);
    const r = await f.prepare();
    r.grant.choices.sendResults = true;
    r.grant.choices.modelProfileId = "substituted";
    r.grant.local.binding.ownerId = randomUUID();
    const saved = f.approve(r);
    assert.equal(saved.grant.choices.sendResults, false);
    assert.equal(saved.grant.choices.modelProfileId, "local");
    assert.throws(() => f.approve(r), /DENIED/);
    const providers = await f.consent.resolve(f.peerId);
    assert.ok(providers.receive(f.peerId));
    assert.equal(providers.send(f.peerId), null);
    assert.equal(providers.respond(f.peerId), null);
    assert.equal(providers.receive(randomUUID()), null);
    assert.equal(
      providers.receive(f.peerId)!.recipientKey.privateKey,
      providers.receive(f.peerId)!.recipientKey.privateKey,
    );
    const view = providers.receive(f.peerId)!;
    view.binding.ownerId = randomUUID();
    assert.equal(
      providers.receive(f.peerId)!.binding.ownerId,
      f.binding.ownerId,
    );
  } finally {
    f.close();
  }
});
test("Persisted consent drives actual HPKE task admission and separately allowed receipts/results", async () => {
  const f = await fixture();
  try {
    f.approve(await f.prepare({ sendReceipts: true, sendResults: true }));
    const providers = await f.consent.resolve(f.peerId),
      receiver = new PrivateTaskReceiver(
        f.store,
        f.vault,
        owner,
        f.current,
        providers.receive,
        f.clock,
      );
    const wire = await f.envelope(),
      receipt = await receiver.accept(wire);
    assert.deepEqual(await receiver.accept(wire), receipt);
    assert.equal(
      receipt.permissionRevision,
      f.consent.list().grants[0]!.revision,
    );
    const task = f.store.get(owner, receipt.taskId);
    assert.deepEqual(task.input.sourceRefs, []);
    assert.equal(task.input.memoryIds, undefined);
    assert.equal(task.input.modelProfileId, "local");
    const responses = new PrivateTaskResponses(
      f.store,
      f.vault,
      owner,
      f.current,
      providers.respond,
      f.clock,
    );
    const accepted = await responses.prepare({
      operationId: wire.header.operationId,
      peerId: f.peerId,
      kind: "accepted",
      confirmed: true,
    });
    const acceptance = accepted.value.envelope!,
      local = await f.keys.resolve();
    const read = await openPrivateEnvelope(
      acceptance,
      acceptance.header,
      { recipientKey: f.sender, senderPublicKey: local.pair.publicKey },
      f.clock,
    );
    assert.equal(
      JSON.parse(new TextDecoder().decode(read.plaintext)).type,
      "task.accepted",
    );
    const worker = new LocalWorker(
      f.store,
      owner,
      {
        pin: async () => ({ profile, digest: "a".repeat(64) }),
        generate: async () => "synthetic unreviewed result",
      },
      (id) => f.store.profile(owner, id),
    );
    await worker.runOnce();
    const result = await responses.prepare({
      operationId: wire.header.operationId,
      peerId: f.peerId,
      kind: "result",
      confirmed: true,
    });
    assert.equal(result.value.content.type, "task.result");
    const ciphertext = result.value.envelope!;
    const opened = await openPrivateEnvelope(
      ciphertext,
      ciphertext.header,
      { recipientKey: f.sender, senderPublicKey: local.pair.publicKey },
      f.clock,
    );
    assert.equal(
      JSON.parse(new TextDecoder().decode(opened.plaintext)).task.output,
      "synthetic unreviewed result",
    );
    f.setBinding(null);
    f.consent.revoke({
      peerId: f.peerId,
      expectedRevision: f.consent.list().revision,
      confirmed: true,
    });
    f.setBinding(f.binding);
    assert.equal(providers.receive(f.peerId), null);
    assert.equal(providers.respond(f.peerId), null);
    await assert.rejects(receiver.accept(wire), /DENIED/);
    assert.throws(() => responses.delivery(result.id), /DENIED/);
    assert.equal(f.store.get(owner, receipt.taskId).status, "completed");
  } finally {
    f.close();
  }
});
test("Receipts, results and outgoing submissions remain separate, and replacement consent cannot release older results", async () => {
  const f = await fixture();
  try {
    f.approve(await f.prepare());
    const original = await f.consent.resolve(f.peerId);
    const wire = await f.envelope(),
      receiver = new PrivateTaskReceiver(
        f.store,
        f.vault,
        owner,
        f.current,
        original.receive,
        f.clock,
      );
    await receiver.accept(wire);
    let responses = new PrivateTaskResponses(
      f.store,
      f.vault,
      owner,
      f.current,
      original.respond,
      f.clock,
    );
    await assert.rejects(
      responses.prepare({
        operationId: wire.header.operationId,
        peerId: f.peerId,
        kind: "accepted",
        confirmed: true,
      }),
      /DENIED/,
    );
    f.approve(await f.prepare({ sendReceipts: true }));
    const newer = await f.consent.resolve(f.peerId);
    assert.equal(original.receive(f.peerId), null);
    responses = new PrivateTaskResponses(
      f.store,
      f.vault,
      owner,
      f.current,
      newer.respond,
      f.clock,
    );
    await assert.rejects(
      responses.prepare({
        operationId: wire.header.operationId,
        peerId: f.peerId,
        kind: "accepted",
        confirmed: true,
      }),
      /DENIED/,
    );
    const second = await f.envelope();
    await new PrivateTaskReceiver(
      f.store,
      f.vault,
      owner,
      f.current,
      newer.receive,
      f.clock,
    ).accept(second);
    assert.equal(
      (
        await responses.prepare({
          operationId: second.header.operationId,
          peerId: f.peerId,
          kind: "accepted",
          confirmed: true,
        })
      ).kind,
      "accepted",
    );
    await assert.rejects(
      responses.prepare({
        operationId: second.header.operationId,
        peerId: f.peerId,
        kind: "result",
        confirmed: true,
      }),
      /DENIED/,
    );
    f.approve(
      await f.prepare({
        receiveTasks: false,
        sendTasks: true,
        modelProfileId: null,
      }),
    );
    const sending = await f.consent.resolve(f.peerId);
    assert.equal(sending.receive(f.peerId), null);
    assert.equal(sending.respond(f.peerId), null);
    const outbox = new PrivateTaskOutbox(
      f.store,
      f.vault,
      owner,
      f.current,
      sending.send,
      f.clock,
    );
    const item = await outbox.enqueue({
      clientRequestId: randomUUID(),
      peerId: f.peerId,
      peerKeyEpoch: 1,
      expectedPeerRevision: f.peers.list().revision,
      content: {
        version: 1,
        type: "task.submit",
        kind: "draft",
        prompt: "synthetic outbound",
      },
      confirmed: true,
    });
    assert.equal(item.value.state, "pending");
  } finally {
    f.close();
  }
});
test("Live providers and prepared consent fail after identity, key, peer, model or lease changes", async () => {
  const f = await fixture();
  try {
    f.approve(await f.prepare());
    const providers = await f.consent.resolve(f.peerId);
    f.setBinding({ ...f.binding, credentialEpoch: 2 });
    assert.equal(providers.receive(f.peerId), null);
    f.setBinding(f.binding);
    f.time(f.choices.expiresAt);
    assert.equal(providers.receive(f.peerId), null);
    f.time(1800000000000);
    const r = await f.prepare();
    f.time(r.expiresAt);
    assert.throws(() => f.approve(r), /DENIED/);
    f.time(1800000000000);
    const altered = f.vault.seal(
      { ...profile, temperature: 0.8 },
      "profile:personal:synthetic:local",
    );
    f.store.db.prepare("UPDATE model_profiles SET payload=?").run(altered);
    assert.equal(providers.receive(f.peerId), null);
    f.store.db
      .prepare("UPDATE model_profiles SET payload=?")
      .run(f.vault.seal(profile, "profile:personal:synthetic:local"));
    const pending = await f.prepare();
    f.peers.revoke({
      peerId: f.peerId,
      expectedRevision: f.peers.list().revision,
      confirmed: true,
    });
    assert.throws(() => f.approve(pending), /DENIED/);
    assert.equal(providers.receive(f.peerId), null);
  } finally {
    f.close();
  }
});
test("Consent publication and cryptographic use reject cross-connection stale changes and selected-key revocation", async () => {
  const f = await fixture(),
    second = new Store(f.path, f.vault, f.clock);
  try {
    const another = f.build(second),
      r = await f.prepare();
    f.approve(await f.prepare({}, another.consent), another.consent);
    assert.throws(() => f.approve(r), /CONFLICT/);
    const providers = await f.consent.resolve(f.peerId),
      wire = await f.envelope();
    const receiver = new PrivateTaskReceiver(
      f.store,
      f.vault,
      owner,
      f.current,
      providers.receive,
      f.clock,
    );
    const pending = receiver.accept(wire);
    another.consent.revoke({
      peerId: f.peerId,
      expectedRevision: another.consent.list().revision,
      confirmed: true,
    });
    await assert.rejects(pending, /DENIED/);
    assert.equal(f.store.list(owner).length, 0);
    const review = await f.prepare(),
      state = another.keys.list();
    another.keys.revoke({
      keyId: state.slots[0]!.id,
      expectedRevision: state.revision,
      confirmed: true,
    });
    assert.throws(() => f.approve(review), /DENIED/);
  } finally {
    second.close();
    f.close();
  }
});
test("Consent survives restart encrypted per owner; backup restore locks it and all-data deletion clears content with a revision fence", async () => {
  const f = await fixture();
  let reopened: Store | undefined, restored: Store | undefined;
  try {
    f.approve(await f.prepare());
    const row = f.store.db
      .prepare("SELECT * FROM private_task_consents")
      .get() as any;
    assert.equal(row.payload.includes(Buffer.from(f.peerId)), false);
    assert.equal(row.payload.includes(Buffer.from(f.binding.ownerId)), false);
    const other = { ...owner, userId: "other" };
    assert.equal(f.store.exportPrivateTaskConsent(other).grants.length, 0);
    f.store.db
      .prepare("INSERT INTO private_task_consents VALUES(?,?,?,?,?)")
      .run(other.userId, other.tenantId, row.revision, 0, row.payload);
    assert.throws(
      () => f.store.exportPrivateTaskConsent(other),
      /STORAGE_UNAVAILABLE/,
    );
    f.store.db
      .prepare("DELETE FROM private_task_consents WHERE user_id=?")
      .run(other.userId);
    reopened = new Store(f.path, f.vault, f.clock);
    assert.ok(
      (await f.build(reopened).consent.resolve(f.peerId)).receive(f.peerId),
    );
    const backup = join(f.dir, "tasks.aib"),
      restoredPath = join(f.dir, "restored.db");
    await encryptedBackup(f.store, f.vault, backup);
    await restoreBackup(backup, f.vault, restoredPath);
    restored = new Store(restoredPath, f.vault, f.clock);
    assert.equal(restored.exportPrivateTaskConsent(owner).needsReview, true);
    await assert.rejects(f.build(restored).consent.resolve(f.peerId), /DENIED/);
    await assert.rejects(f.prepare({}, f.build(restored).consent));
    const review = await f.prepare();
    f.store.deleteAll(owner);
    const cleared = f.consent.list();
    assert.equal(cleared.grants.length, 0);
    assert.equal(cleared.needsReview, true);
    assert.ok(cleared.revision > review.revision);
    assert.throws(() => f.approve(review), /CONFLICT/);
    assert.equal(
      (
        f.store.db
          .prepare("SELECT payload FROM private_task_consents WHERE user_id=?")
          .get(owner.userId) as any
      ).payload,
      null,
    );
  } finally {
    reopened?.close();
    restored?.close();
    f.close();
  }
});
test("Schema17 migration preserves tasks without granting consent; authenticated content export includes saved decisions", async () => {
  const f = await fixture(),
    server = createServer();
  let migrated: Store | undefined;
  try {
    const task = f.store.create(
      owner,
      {
        conversationId: "test",
        kind: "query",
        prompt: "preserve",
        modelProfileId: "local",
      },
      randomUUID(),
    );
    f.store.db.exec("DROP TABLE private_task_consents; PRAGMA user_version=17");
    migrated = new Store(f.path, f.vault, f.clock);
    assert.equal(migrated.db.pragma("user_version", { simple: true }), 22);
    assert.equal(migrated.get(owner, task.id).input.prompt, "preserve");
    assert.deepEqual(migrated.exportPrivateTaskConsent(owner), {
      revision: 0,
      needsReview: false,
      grants: [],
    });
    f.approve(await f.prepare());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port,
      token = randomBytes(32).toString("hex");
    server.on("request", localApi({ store: f.store, owner, token, port }));
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/v1/export`)).status,
      401,
    );
    const res = await fetch(`http://127.0.0.1:${port}/v1/export`, {
      headers: { Authorization: "Bearer " + token },
    });
    assert.equal(res.status, 200);
    assert.equal(
      (await res.json()).privateTaskConsent.grants[0].choices.peerId,
      f.peerId,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    migrated?.close();
    f.close();
  }
});

test("Hidden or invalidated pending consent cannot publish after native key resolution; malformed choices grant nothing", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.consent.prepare({
        expectedRevision: 0,
        choices: { ...f.choices, sourceAccess: true },
      }),
      /DENIED/,
    );
    await assert.rejects(
      f.prepare({
        receiveTasks: false,
        sendTasks: false,
        modelProfileId: null,
      }),
      /DENIED/,
    );
    let release!: () => void, started!: () => void;
    const entered = new Promise<void>((r) => {
        started = r;
      }),
      held = new Promise<void>((r) => {
        release = r;
      });
    const native = [...f.slots.values()][0]!.key;
    native.beforeRead = async () => {
      started();
      await held;
    };
    const pending = f.prepare();
    await entered;
    f.consent.invalidate();
    release();
    await assert.rejects(pending, /CONFLICT/);
    native.beforeRead = undefined;
    assert.equal(f.consent.list().grants.length, 0);
    const r = await f.prepare();
    f.setBinding(null);
    assert.throws(() => f.approve(r), /DENIED/);
    f.setBinding(f.binding);
    f.approve(await f.prepare());
    f.store.db
      .prepare("UPDATE private_task_consents SET revision=?")
      .run(Number.MAX_SAFE_INTEGER);
    await assert.rejects(f.prepare(), /CAPACITY/);
  } finally {
    f.close();
  }
});
