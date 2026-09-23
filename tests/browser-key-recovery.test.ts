import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createBrowserKeyMaterial,
  openBrowserKeyRecovery,
} from "../modules/remote/browser-key-recovery.js";
import {
  sealPrivateEnvelope,
  openPrivateEnvelope,
  privateEnvelopeSuite,
} from "../modules/remote/private-envelope.js";
const key = () =>
  crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
const identity = () => ({
  localOwner: "synthetic",
  binding: {
    ownerId: randomUUID(),
    deviceId: randomUUID(),
    credentialEpoch: 1,
    expiresAt: Date.now() + 60000,
  },
  keyId: randomUUID(),
  keyEpoch: 1,
});
test("User-held recovery key reopens identical endpoint material without exporting runtime private handles", async () => {
  const recoveryKey = await key(),
    id = identity(),
    made = await createBrowserKeyMaterial(id, recoveryKey),
    reopened = await openBrowserKeyRecovery(
      structuredClone(made.recovery),
      recoveryKey,
    );
  assert.deepEqual(reopened.identity, id);
  assert.equal(reopened.publicKey, made.publicKey);
  assert.equal(reopened.pair.privateKey.extractable, false);
  await assert.rejects(
    crypto.subtle.exportKey("pkcs8", reopened.pair.privateKey),
  );
  assert.deepEqual(Object.keys(made.recovery).sort(), [
    "ciphertext",
    "format",
    "iv",
  ]);
  assert.ok(!JSON.stringify(made.recovery).includes(id.localOwner));
  const peer = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    ),
    now = Date.now(),
    header = {
      version: 1 as const,
      suite: privateEnvelopeSuite,
      ownerId: id.binding.ownerId,
      senderId: randomUUID(),
      recipientId: id.binding.deviceId,
      senderKeyEpoch: 1,
      recipientKeyEpoch: 1,
      messageId: randomUUID(),
      operationId: randomUUID(),
      sequence: 1,
      issuedAt: now,
      expiresAt: now + 30000,
    };
  const wire = await sealPrivateEnvelope(
    header,
    new TextEncoder().encode("synthetic recoverable result"),
    { senderKey: peer, recipientPublicKey: made.pair.publicKey },
    () => now,
  );
  assert.equal(
    new TextDecoder().decode(
      (
        await openPrivateEnvelope(
          wire,
          header,
          { recipientKey: reopened.pair, senderPublicKey: peer.publicKey },
          () => now,
        )
      ).plaintext,
    ),
    "synthetic recoverable result",
  );
});
test("Wrong recovery key, tampering, extra fields, noncanonical bytes and oversized input fail without partial material", async () => {
  const k = await key(),
    made = await createBrowserKeyMaterial(identity(), k);
  await assert.rejects(
    openBrowserKeyRecovery(made.recovery, await key()),
    /BROWSER_KEY_RECOVERY_FAILED/,
  );
  for (const kit of [
    {
      ...made.recovery,
      ciphertext:
        (made.recovery.ciphertext[0] === "A" ? "B" : "A") +
        made.recovery.ciphertext.slice(1),
    },
    { ...made.recovery, iv: "A".repeat(16) },
    { ...made.recovery, ciphertext: made.recovery.ciphertext + "=" },
    { ...made.recovery, ciphertext: "A".repeat(4097) },
    { ...made.recovery, privateKey: "forged" },
    { ...made.recovery, format: "another-format" },
  ])
    await assert.rejects(
      openBrowserKeyRecovery(kit, k),
      /^Error: BROWSER_KEY_RECOVERY_FAILED$/,
    );
});
test("Recovery creation rejects wrong algorithms, exportable wrapping keys and invalid authority; fresh keys use distinct random material", async () => {
  const id = identity(),
    k = await key(),
    a = await createBrowserKeyMaterial(id, k),
    b = await createBrowserKeyMaterial(id, k);
  assert.notEqual(a.publicKey, b.publicKey);
  assert.notEqual(a.recovery.iv, b.recovery.iv);
  assert.notEqual(a.recovery.ciphertext, b.recovery.ciphertext);
  for (const bad of [
    await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]),
    await crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, false, [
      "encrypt",
      "decrypt",
    ]),
    await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
    ]),
  ])
    await assert.rejects(
      createBrowserKeyMaterial(id, bad),
      /BROWSER_KEY_RECOVERY_FAILED/,
    );
  await assert.rejects(
    createBrowserKeyMaterial({ ...id, grant: true }, k),
    /BROWSER_KEY_RECOVERY_FAILED/,
  );
});
