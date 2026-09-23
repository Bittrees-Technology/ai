import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  browserTaskBytes,
  prepareBrowserTask,
  readBrowserTaskPreparation,
  openBrowserTaskPreparation,
} from "../modules/remote/browser-task-preparation.js";
import {
  browserOutboxEntrySchema,
  type BrowserDeliveryContext,
} from "../modules/remote/browser-outbox-state.js";
import {
  privateEnvelopeLimit,
  privateEnvelopeSuite,
} from "../modules/remote/private-envelope.js";
const now = 1800000000000;
const payload = {
  version: 1,
  type: "task.submit",
  kind: "query",
  prompt: "SYNTHETIC_DURABLE_TASK",
};
function context(): BrowserDeliveryContext {
  return {
    binding: {
      ownerId: randomUUID(),
      deviceId: randomUUID(),
      credentialEpoch: 1,
      expiresAt: now + 3600000,
    },
    senderKeyEpoch: 1,
    peerId: randomUUID(),
    peerKeyEpoch: 1,
    peerRevision: 1,
    peerFingerprint: "a".repeat(64),
    permissionRevision: 1,
    permissionId: randomUUID(),
    sendingEnabled: true,
  };
}
async function prepared() {
  const c = context(),
    p = await prepareBrowserTask(
      randomUUID(),
      "b".repeat(64),
      c,
      payload,
      now,
      now + 60000,
    ),
    entry = browserOutboxEntrySchema.parse({
      id: p.id,
      scope: p.scope,
      revision: 1,
      context: c,
      header: {
        version: 1,
        suite: privateEnvelopeSuite,
        ownerId: c.binding.ownerId,
        senderId: c.binding.deviceId,
        recipientId: c.peerId,
        senderKeyEpoch: 1,
        recipientKeyEpoch: 1,
        messageId: randomUUID(),
        operationId: p.id,
        sequence: 1,
        issuedAt: now,
        expiresAt: p.expiresAt,
      },
      state: "reserved",
      envelope: null,
      attempts: 0,
      composed: true,
    });
  return { p, entry };
}
test("task byte limits include UTF-8 and JSON escaping before encryption", () => {
  const overhead = browserTaskBytes({ ...payload, prompt: "x" }).length - 1,
    count = Math.floor((privateEnvelopeLimit - overhead) / 3);
  assert.ok(
    browserTaskBytes({ ...payload, prompt: "界".repeat(count) }).length <=
      privateEnvelopeLimit,
  );
  assert.throws(
    () => browserTaskBytes({ ...payload, prompt: "界".repeat(count + 1) }),
    /CAPACITY/,
  );
  assert.throws(
    () => browserTaskBytes({ ...payload, prompt: "\0".repeat(12000) }),
    /CAPACITY/,
  );
  assert.ok(
    browserTaskBytes({ ...payload, prompt: "a".repeat(32000) }).length <
      privateEnvelopeLimit,
  );
});
test("durable preparation survives structured clone with a nonexportable key and no plaintext field", async () => {
  const { p, entry } = await prepared(),
    cloned = readBrowserTaskPreparation(structuredClone(p), entry);
  assert.equal((cloned.key as CryptoKey).extractable, false);
  await assert.rejects(crypto.subtle.exportKey("raw", cloned.key as CryptoKey));
  assert.doesNotMatch(JSON.stringify(cloned), /SYNTHETIC_DURABLE_TASK|prompt/);
  assert.deepEqual(await openBrowserTaskPreparation(cloned), payload);
});
test("preparation authentication binds routing, grant, operation and deadline", async () => {
  const { p } = await prepared();
  for (const changed of [
    { ...p, id: randomUUID() },
    { ...p, scope: "c".repeat(64) },
    { ...p, context: { ...p.context, permissionId: randomUUID() } },
    { ...p, expiresAt: p.expiresAt + 1 },
  ])
    await assert.rejects(openBrowserTaskPreparation(changed));
});
test("a preparation cannot attach to another entry or an exportable replacement key", async () => {
  const { p, entry } = await prepared();
  assert.throws(
    () => readBrowserTaskPreparation(p, { ...entry, id: randomUUID() }),
    /STORAGE_UNAVAILABLE/,
  );
  assert.throws(
    () =>
      readBrowserTaskPreparation(p, {
        ...entry,
        header: { ...entry.header, expiresAt: p.expiresAt + 1 },
      }),
    /STORAGE_UNAVAILABLE/,
  );
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  assert.throws(
    () => readBrowserTaskPreparation({ ...p, key }, entry),
    /STORAGE_UNAVAILABLE/,
  );
});
test("source and model selection cannot be smuggled into a composed source-free task", () => {
  for (const field of [
    "modelProfileId",
    "sources",
    "tools",
    "approval",
    "memory",
    "conversationId",
  ])
    assert.throws(
      () => browserTaskBytes({ ...payload, [field]: "unreviewed" }),
      /DENIED/,
    );
});
