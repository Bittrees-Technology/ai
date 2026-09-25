import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { browserResumeGrantSchema } from "../modules/remote/browser-resume-consent.js";
import { privateEnvelopeSuite } from "../modules/remote/private-envelope.js";
import {
  browserResumeDeliveryValueSchema,
  sealBrowserResumeDeliveryRow,
  openBrowserResumeDeliveryRow,
  type BrowserResumeDeliveryValue,
} from "../modules/remote/browser-resume-delivery-state.js";
function fixture() {
  const now = Date.now(),
    peerId = randomUUID();
  const local = {
    revision: 1,
    keyId: randomUUID(),
    keyEpoch: 1,
    binding: {
      ownerId: randomUUID(),
      deviceId: randomUUID(),
      credentialEpoch: 1,
      expiresAt: now + 600000,
    },
    publicKey: "A".repeat(87),
  };
  const offer = {
    version: 1,
    type: "task.resume.offer",
    permissionId: randomUUID(),
    taskId: randomUUID(),
    taskRevision: 3,
    modelDigest: "a".repeat(64),
    issuedAt: now - 1000,
    expiresAt: now + 300000,
  };
  const grant = browserResumeGrantSchema.parse({
    id: randomUUID(),
    revision: 1,
    approvedAt: now - 500,
    revoked: false,
    choices: {
      peerId,
      peerKeyEpoch: 1,
      permissionId: offer.permissionId,
      taskId: offer.taskId,
      taskRevision: offer.taskRevision,
      modelDigest: offer.modelDigest,
      expiresAt: now + 240000,
    },
    offer,
    offerReplay: {
      version: 1,
      type: "task.resume.offer",
      operation: "b".repeat(64),
      message: "c".repeat(64),
      sequence: "d".repeat(64),
      envelope: "e".repeat(64),
    },
    local,
    peer: {
      revision: 1,
      key: local,
      peerId,
      keyEpoch: 1,
      fingerprint: "f".repeat(64),
    },
  });
  const header = {
    version: 1,
    suite: privateEnvelopeSuite,
    ownerId: local.binding.ownerId,
    senderId: local.binding.deviceId,
    recipientId: peerId,
    senderKeyEpoch: 1,
    recipientKeyEpoch: 1,
    messageId: randomUUID(),
    operationId: randomUUID(),
    sequence: 1,
    issuedAt: now,
    expiresAt: now + 60000,
  };
  const value = browserResumeDeliveryValueSchema.parse({
    state: "preparing",
    stopped: false,
    grant,
    request: {
      version: 1,
      type: "task.resume",
      command: {
        version: 1,
        id: header.operationId,
        deviceId: peerId,
        permissionId: offer.permissionId,
        taskId: offer.taskId,
        expectedRevision: offer.taskRevision,
        command: "resume",
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(header.expiresAt).toISOString(),
      },
    },
    header,
    envelope: null,
    receipt: null,
    receiptEnvelope: null,
    requestHash: "1".repeat(64),
  });
  const metadata = {
    scope: "2".repeat(64),
    id: "3".repeat(64),
    deviceHash: "4".repeat(64),
    revision: 1,
  };
  return { value, metadata };
}
function ready(v: BrowserResumeDeliveryValue): BrowserResumeDeliveryValue {
  return {
    ...v,
    state: "ready",
    envelope: { header: v.header, enc: "AA", ciphertext: "AA" },
  };
}
function accepted(v: BrowserResumeDeliveryValue): BrowserResumeDeliveryValue {
  const c = v.request.command,
    h = v.header;
  return {
    ...ready(v),
    state: "accepted",
    receipt: {
      version: 1,
      type: "task.resumed",
      receipt: {
        version: 1,
        id: c.id,
        deviceId: c.deviceId,
        permissionId: c.permissionId,
        taskId: c.taskId,
        taskRevision: c.expectedRevision + 1,
        outcome: "queued",
        completedAt: c.issuedAt,
      },
    },
    receiptEnvelope: {
      enc: "AA",
      ciphertext: "AA",
      header: {
        ...h,
        messageId: randomUUID(),
        senderId: h.recipientId,
        recipientId: h.senderId,
        senderKeyEpoch: h.recipientKeyEpoch,
        recipientKeyEpoch: h.senderKeyEpoch,
      },
    },
  };
}
test("resume storage keeps preparation, original ciphertext and accepted receipt distinct and encrypts with a nonextractable key", async () => {
  const { value, metadata } = fixture();
  for (const candidate of [
    value,
    ready(value),
    accepted(value),
    { ...ready(value), stopped: true },
  ]) {
    const row = await sealBrowserResumeDeliveryRow(metadata, candidate);
    assert.deepEqual(
      (await openBrowserResumeDeliveryRow(structuredClone(row))).value,
      candidate,
    );
    assert.equal((row.key as CryptoKey).extractable, false);
    await assert.rejects(crypto.subtle.exportKey("raw", row.key as CryptoKey));
    assert.ok(!JSON.stringify(row).includes(value.request.command.taskId));
  }
});
test("resume storage rejects substituted task, permission, route, model or receipt identities and impossible lifecycle combinations", () => {
  const { value } = fixture();
  const change = (
    fn: (v: BrowserResumeDeliveryValue) => void,
    original = value,
  ) => {
    const v = structuredClone(original);
    fn(v);
    assert.equal(browserResumeDeliveryValueSchema.safeParse(v).success, false);
  };
  change((v) => {
    v.request.command.taskId = randomUUID();
  });
  change((v) => {
    v.request.command.permissionId = randomUUID();
  });
  change((v) => {
    v.request.command.expectedRevision++;
  });
  change((v) => {
    v.request.command.deviceId = v.header.senderId;
  });
  change((v) => {
    v.grant.choices.modelDigest = "9".repeat(64);
  });
  change((v) => {
    v.grant.revoked = true;
  });
  change((v) => {
    v.header.senderKeyEpoch++;
  });
  change((v) => {
    v.header.operationId = randomUUID();
  });
  change((v) => {
    v.header.expiresAt++;
  });
  change((v) => {
    v.state = "ready";
  });
  change((v) => {
    v.state = "accepted";
  }, ready(value));
  change((v) => {
    v.state = "preparing";
  }, ready(value));
  change((v) => {
    v.receipt!.receipt.id = randomUUID();
  }, accepted(value));
  change((v) => {
    v.receipt!.receipt.taskRevision = value.request.command.expectedRevision;
  }, accepted(value));
  change((v) => {
    v.receiptEnvelope!.header.senderId = value.header.senderId;
  }, accepted(value));
  change((v) => {
    v.receiptEnvelope!.header.expiresAt = value.grant.offer.expiresAt + 1;
  }, accepted(value));
  change((v) => {
    v.receipt!.receipt.completedAt = new Date(
      value.header.issuedAt - 1,
    ).toISOString();
  }, accepted(value));
  change((v) => {
    v.receipt!.receipt.taskRevision =
      value.request.command.expectedRevision + 2;
  }, accepted(value));
  assert.equal(
    browserResumeDeliveryValueSchema.safeParse({ ...value, authority: true })
      .success,
    false,
  );
});
test("resume encrypted rows bind owner, device, row ID and revision and reject corrupted ciphertext or extractable keys", async () => {
  const { value, metadata } = fixture();
  const row = await sealBrowserResumeDeliveryRow(metadata, ready(value));
  for (const field of ["scope", "id", "deviceHash"] as const)
    await assert.rejects(
      openBrowserResumeDeliveryRow({ ...row, [field]: "9".repeat(64) }),
      /STORAGE_UNAVAILABLE/,
    );
  await assert.rejects(
    openBrowserResumeDeliveryRow({ ...row, revision: 2 }),
    /STORAGE_UNAVAILABLE/,
  );
  await assert.rejects(
    openBrowserResumeDeliveryRow({
      ...row,
      ciphertext:
        (row.ciphertext[0] === "A" ? "B" : "A") + row.ciphertext.slice(1),
    }),
    /STORAGE_UNAVAILABLE/,
  );
  const extractable = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  await assert.rejects(
    openBrowserResumeDeliveryRow({ ...row, key: extractable }),
    /STORAGE_UNAVAILABLE/,
  );
  const next = await sealBrowserResumeDeliveryRow(
    { ...metadata, revision: 2 },
    ready(value),
    row.key,
  );
  assert.equal(next.key, row.key);
  assert.notEqual(next.iv, row.iv);
  assert.deepEqual(
    (await openBrowserResumeDeliveryRow(next)).value,
    ready(value),
  );
});

test("Mac receipt expiry may follow its offer without extending the saved browser permission", () => {
  const { value } = fixture();
  const candidate = accepted(value);
  candidate.receiptEnvelope!.header.expiresAt = value.grant.offer.expiresAt;
  const saved = browserResumeDeliveryValueSchema.parse(candidate);
  assert.equal(saved.grant.choices.expiresAt, value.grant.choices.expiresAt);
  assert.ok(
    saved.grant.choices.expiresAt < saved.receiptEnvelope!.header.expiresAt,
  );
});
