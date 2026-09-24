import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  sealPrivateEnvelope,
  openPrivateEnvelope,
  privateEnvelopeLimit,
  privateEnvelopeSuite,
} from "../modules/remote/private-envelope.js";
import {
  parsePrivateRelaySubmission,
  privateRelayEnvelopeHash,
  PrivateRelayInputError,
  privateRelayBodyLimit,
  privateRelayPolicySchema,
  privateRelayIdentitySchema,
  privateRelaySubmitSchema,
  privateRelayPageSchema,
  privateRelayAcknowledgeSchema,
  privateRelayStorageReceiptSchema,
} from "../modules/remote/private-relay-contracts.js";
const now = 1800000000000;
async function fixture(size = 80) {
  const key = () =>
    crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
      "deriveBits",
    ]);
  const senderKey = await key(),
    recipientKey = await key(),
    ownerId = randomUUID();
  const sender = {
    version: 1 as const,
    scope: "private:relay" as const,
    ownerId,
    endpointId: randomUUID(),
    endpointKind: "browser" as const,
    credentialEpoch: 1,
    permissionId: randomUUID(),
    expiresAt: now + 600000,
  };
  const recipient = {
    ...sender,
    endpointId: randomUUID(),
    endpointKind: "mac" as const,
    permissionId: randomUUID(),
  };
  const header = {
    version: 1 as const,
    suite: privateEnvelopeSuite,
    ownerId,
    senderId: sender.endpointId,
    recipientId: recipient.endpointId,
    senderKeyEpoch: 1,
    recipientKeyEpoch: 2,
    messageId: randomUUID(),
    operationId: randomUUID(),
    sequence: 1,
    issuedAt: now,
    expiresAt: now + 300000,
  };
  const plaintext = new Uint8Array(size).fill(83);
  const envelope = await sealPrivateEnvelope(
    header,
    plaintext,
    { senderKey, recipientPublicKey: recipientKey.publicKey },
    () => now,
  );
  return {
    sender,
    recipient,
    plaintext,
    senderKey,
    recipientKey,
    input: { version: 1 as const, envelope },
  };
}
const invalid = (e: unknown) =>
  e instanceof PrivateRelayInputError &&
  e.message === "PRIVATE_RELAY_INVALID" &&
  e.cause === undefined;

test("private relay structure preserves a real maximum-size encrypted message and exposes no plaintext", async () => {
  const f = await fixture(privateEnvelopeLimit),
    before = structuredClone(f.input);
  const parsed = parsePrivateRelaySubmission(
    f.input,
    f.sender,
    f.recipient,
    now,
  );
  assert.deepEqual(parsed, before);
  assert.ok(
    new TextEncoder().encode(JSON.stringify(parsed)).byteLength <
      privateRelayBodyLimit,
  );
  assert.deepEqual(
    (
      await openPrivateEnvelope(
        parsed.envelope,
        parsed.envelope.header,
        {
          recipientKey: f.recipientKey,
          senderPublicKey: f.senderKey.publicKey,
        },
        () => now,
      )
    ).plaintext,
    f.plaintext,
  );
  parsed.envelope.header.sequence = 99;
  assert.deepEqual(f.input, before);
});

test("relay message validation enforces explicit transport identity and current same-owner opposite endpoints", async () => {
  const f = await fixture();
  for (const changed of [
    { ...f.sender, scope: "status:publish" },
    { ...f.sender, scope: "controls:write" },
    { ...f.sender, scope: "templates:run" },
    { ...f.sender, ownerId: randomUUID() },
    { ...f.sender, endpointId: randomUUID() },
    { ...f.sender, expiresAt: now },
    { ...f.sender, credentialEpoch: 0 },
    { ...f.sender, permissionId: undefined },
    { ...f.sender, extra: true },
  ])
    assert.throws(
      () => parsePrivateRelaySubmission(f.input, changed, f.recipient, now),
      invalid,
    );
  for (const changed of [
    { ...f.recipient, ownerId: randomUUID() },
    { ...f.recipient, endpointId: f.sender.endpointId },
    { ...f.recipient, endpointKind: "browser" },
    { ...f.recipient, expiresAt: now },
    { ...f.recipient, expiresAt: now + 299999 },
    { ...f.recipient, scope: "status:publish" },
  ])
    assert.throws(
      () => parsePrivateRelaySubmission(f.input, f.sender, changed, now),
      invalid,
    );
  assert.equal(
    privateRelayIdentitySchema.safeParse({ ...f.sender, taskPermission: true })
      .success,
    false,
  );
});

test("relay framing rejects bad clocks, deadlines, route metadata, unknown plaintext and malformed encoding", async () => {
  const f = await fixture();
  for (const time of [0, -1, NaN, Infinity, now + 300000, now - 30001])
    assert.throws(
      () => parsePrivateRelaySubmission(f.input, f.sender, f.recipient, time),
      invalid,
    );
  for (const changed of [
    { ownerId: randomUUID() },
    { senderId: randomUUID() },
    { recipientId: randomUUID() },
    { senderKeyEpoch: 0 },
    { sequence: 0 },
    { issuedAt: now + 30001 },
    { expiresAt: now },
    { issuedAt: now - 86400001 },
    { expiresAt: now + 600001 },
    { version: 2 },
    { prompt: "SECRET" },
  ])
    assert.throws(
      () =>
        parsePrivateRelaySubmission(
          {
            ...f.input,
            envelope: {
              ...f.input.envelope,
              header: { ...f.input.envelope.header, ...changed },
            },
          },
          f.sender,
          f.recipient,
          now,
        ),
      invalid,
    );
  for (const changed of [
    { enc: "A" },
    { enc: f.input.envelope.enc + "=" },
    { enc: Buffer.alloc(65, 3).toString("base64url") },
    { ciphertext: "A" },
    { ciphertext: f.input.envelope.ciphertext + "=" },
    { ciphertext: Buffer.alloc(16).toString("base64url") },
    {
      ciphertext: Buffer.alloc(privateEnvelopeLimit + 17).toString("base64url"),
    },
    { plaintext: "SECRET" },
  ])
    assert.throws(
      () =>
        parsePrivateRelaySubmission(
          { ...f.input, envelope: { ...f.input.envelope, ...changed } },
          f.sender,
          f.recipient,
          now,
        ),
      invalid,
    );
  assert.equal(
    privateRelaySubmitSchema.safeParse({ ...f.input, prompt: "SECRET" })
      .success,
    false,
  );
});

test("structural relay validation intentionally cannot authenticate ciphertext or replace endpoint verification", async () => {
  const f = await fixture(),
    input = structuredClone(f.input);
  const bytes = Buffer.from(input.envelope.ciphertext, "base64url");
  bytes[0] = bytes[0]! ^ 1;
  input.envelope.ciphertext = bytes.toString("base64url");
  assert.deepEqual(
    parsePrivateRelaySubmission(input, f.sender, f.recipient, now),
    input,
  );
  await assert.rejects(
    openPrivateEnvelope(
      input.envelope,
      input.envelope.header,
      { recipientKey: f.recipientKey, senderPublicKey: f.senderKey.publicKey },
      () => now,
    ),
  );
});

test("relay accepts reversed authenticated Mac-to-browser routing without changing keys or ciphertext", async () => {
  const f = await fixture();
  const h = {
    ...f.input.envelope.header,
    senderId: f.recipient.endpointId,
    recipientId: f.sender.endpointId,
    senderKeyEpoch: 2,
    recipientKeyEpoch: 1,
  };
  const envelope = await sealPrivateEnvelope(
    h,
    f.plaintext,
    { senderKey: f.recipientKey, recipientPublicKey: f.senderKey.publicKey },
    () => now,
  );
  assert.deepEqual(
    parsePrivateRelaySubmission(
      { version: 1, envelope },
      f.recipient,
      f.sender,
      now,
    ),
    { version: 1, envelope },
  );
});

test("relay retention and quota policy has no implicit user decision or host defaults", () => {
  const policy = {
    version: 1,
    origin: "https://ai.bittrees.org",
    chainId: 1,
    receivedContent: "until-deleted",
    unreceivedContent: { mode: "until-deleted" },
    operationalMetadataMs: 7 * 86400000,
    maxMessagesPerOwner: 100,
    maxBytesPerOwner: privateRelayBodyLimit * 100,
  };
  assert.equal(privateRelayPolicySchema.safeParse(policy).success, true);
  assert.equal(
    privateRelayPolicySchema.safeParse({
      ...policy,
      receivedContent: "delete-after-receipt",
      unreceivedContent: { mode: "bounded", retentionMs: 86400000 },
      operationalMetadataMs: 30 * 86400000,
    }).success,
    true,
  );
  for (const k of Object.keys(policy)) {
    const missing = { ...policy };
    delete (missing as any)[k];
    assert.equal(privateRelayPolicySchema.safeParse(missing).success, false, k);
  }
  for (const changed of [
    { origin: "http://ai.bittrees.org" },
    { origin: "https://ai.bittrees.org/" },
    { origin: "https://user:password@ai.bittrees.org" },
    { unreceivedContent: { mode: "bounded" } },
    { unreceivedContent: { mode: "until-deleted", retentionMs: 1 } },
    { operationalMetadataMs: 0 },
    { maxMessagesPerOwner: 0 },
    { maxBytesPerOwner: privateRelayBodyLimit - 1 },
    { fallback: "acer-server" },
  ])
    assert.equal(
      privateRelayPolicySchema.safeParse({ ...policy, ...changed }).success,
      false,
    );
});

test("relay storage receipts are distinct from task execution and acknowledgement is exact and revision-bound", () => {
  const messageId = randomUUID(),
    envelopeHash = "a".repeat(64),
    base = {
      version: 1,
      messageId,
      envelopeHash,
      revision: 1,
      storedAt: now,
      state: "stored",
    };
  assert.equal(privateRelayStorageReceiptSchema.safeParse(base).success, true);
  for (const state of ["queued", "accepted", "running", "completed"])
    assert.equal(
      privateRelayStorageReceiptSchema.safeParse({ ...base, state }).success,
      false,
    );
  assert.equal(
    privateRelayStorageReceiptSchema.safeParse({
      ...base,
      taskId: randomUUID(),
    }).success,
    false,
  );
  const ack = { messageId, envelopeHash, expectedRevision: 1, confirmed: true };
  assert.equal(privateRelayAcknowledgeSchema.safeParse(ack).success, true);
  for (const changed of [
    { envelopeHash: "a" },
    { expectedRevision: 0 },
    { confirmed: false },
    { senderId: randomUUID() },
  ])
    assert.equal(
      privateRelayAcknowledgeSchema.safeParse({ ...ack, ...changed }).success,
      false,
    );
  assert.equal(
    privateRelayPageSchema.safeParse({ after: null, limit: 20 }).success,
    true,
  );
  assert.equal(
    privateRelayPageSchema.safeParse({
      after: { storedAt: now, messageId },
      limit: 1,
    }).success,
    true,
  );
  for (const limit of [0, 21, 1.5])
    assert.equal(
      privateRelayPageSchema.safeParse({ after: null, limit }).success,
      false,
    );
});

test("relay envelope hashing is stable across object ordering and binds every encrypted envelope field", async () => {
  const f = await fixture(),
    original = f.input.envelope;
  const expected = createHash("sha256")
    .update(
      "org.bittrees.ai/private-relay-envelope/v1\0" + JSON.stringify(original),
    )
    .digest("hex");
  assert.equal(await privateRelayEnvelopeHash(original), expected);
  assert.equal(
    await privateRelayEnvelopeHash({
      ciphertext: original.ciphertext,
      enc: original.enc,
      header: Object.fromEntries(Object.entries(original.header).reverse()),
    }),
    expected,
  );
  for (const [field, value] of Object.entries(original.header)) {
    const replacement =
      typeof value === "number"
        ? value + 1
        : field === "suite"
          ? "unsupported"
          : randomUUID();
    const changed = {
      ...original,
      header: { ...original.header, [field]: replacement },
    };
    if (field === "suite" || field === "version")
      await assert.rejects(privateRelayEnvelopeHash(changed), invalid);
    else
      assert.notEqual(await privateRelayEnvelopeHash(changed), expected, field);
  }
  for (const field of ["enc", "ciphertext"] as const) {
    const changed = {
      ...original,
      [field]:
        (original[field][0] === "A" ? "B" : "A") + original[field].slice(1),
    };
    assert.notEqual(await privateRelayEnvelopeHash(changed), expected, field);
  }
  await assert.rejects(
    privateRelayEnvelopeHash({ ...original, prompt: "SECRET" }),
    invalid,
  );
});
