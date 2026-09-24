import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  privateReplayIdentity,
  classifyPrivateReplay,
  privateReplayTypeSchema,
} from "../modules/remote/private-replay.js";
import {
  privateEnvelopeSuite,
  sealPrivateEnvelope,
  openPrivateEnvelope,
  type PrivateHeader,
} from "../modules/remote/private-envelope.js";

async function fixture() {
  const sender = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    ),
    recipient = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    ),
    now = Date.now();
  const header: PrivateHeader = {
    version: 1,
    suite: privateEnvelopeSuite,
    ownerId: randomUUID(),
    senderId: randomUUID(),
    recipientId: randomUUID(),
    senderKeyEpoch: 1,
    recipientKeyEpoch: 1,
    messageId: randomUUID(),
    operationId: randomUUID(),
    sequence: 1,
    issuedAt: now,
    expiresAt: now + 60000,
  };
  async function wire(patch: Partial<PrivateHeader> = {}, text = "synthetic") {
    return sealPrivateEnvelope(
      { ...header, ...patch },
      new TextEncoder().encode(text),
      { senderKey: sender, recipientPublicKey: recipient.publicKey },
      () => now,
    );
  }
  async function plaintext(envelope: Awaited<ReturnType<typeof wire>>) {
    const opened = await openPrivateEnvelope(
      envelope,
      envelope.header,
      { recipientKey: recipient, senderPublicKey: sender.publicKey },
      () => now,
    );
    try {
      return new TextDecoder().decode(opened.plaintext);
    } finally {
      opened.plaintext.fill(0);
    }
  }
  return { header, wire, plaintext };
}

test("replay identity permits original wire retries but rejects authenticated re-encryption of identical content", async () => {
  const f = await fixture(),
    a = await f.wire(),
    b = await f.wire();
  assert.equal(await f.plaintext(a), await f.plaintext(b));
  const first = await privateReplayIdentity(a, "task.submit"),
    repeat = await privateReplayIdentity(
      Object.fromEntries(Object.entries(a).reverse()),
      "task.submit",
    ),
    changed = await privateReplayIdentity(b, "task.submit");
  assert.deepEqual(first, repeat);
  assert.equal(classifyPrivateReplay(repeat, [first]), "duplicate");
  assert.equal(first.message, changed.message);
  assert.equal(first.sequence, changed.sequence);
  assert.notEqual(first.envelope, changed.envelope);
  assert.throws(() => classifyPrivateReplay(changed, [first]), /CONFLICT/);
});

test("task acceptance and results share an operation without sharing message or directed sequence identities", async () => {
  const f = await fixture(),
    a = await privateReplayIdentity(await f.wire(), "task.accepted"),
    b = await privateReplayIdentity(
      await f.wire({ messageId: randomUUID(), sequence: 2 }),
      "task.result",
    );
  assert.notEqual(a.operation, b.operation);
  assert.notEqual(a.message, b.message);
  assert.notEqual(a.sequence, b.sequence);
  assert.equal(classifyPrivateReplay(a, []), "new");
  assert.equal(classifyPrivateReplay(b, []), "new");
  assert.equal(classifyPrivateReplay(b, [b]), "duplicate");
});

test("changing a payload family cannot disguise message or sequence reuse", async () => {
  const f = await fixture(),
    wire = await f.wire(),
    original = await privateReplayIdentity(wire, "peer.key.challenge");
  for (const type of privateReplayTypeSchema.options) {
    if (type === original.type) continue;
    const messageReuse = await privateReplayIdentity(
        await f.wire({ operationId: randomUUID(), sequence: 2 }),
        type,
      ),
      sequenceReuse = await privateReplayIdentity(
        await f.wire({ operationId: randomUUID(), messageId: randomUUID() }),
        type,
      );
    assert.equal(messageReuse.message, original.message);
    assert.equal(sequenceReuse.sequence, original.sequence);
    assert.throws(
      () => classifyPrivateReplay(messageReuse, [original]),
      /CONFLICT/,
    );
    assert.throws(
      () => classifyPrivateReplay(sequenceReuse, [original]),
      /CONFLICT/,
    );
  }
});

test("operation identity cannot be renewed by changing peer or key epoch; sequence channels remain directed and epoch scoped", async () => {
  const f = await fixture(),
    a = await privateReplayIdentity(await f.wire(), "conversation.message");
  for (const patch of [
    { senderId: randomUUID() },
    { recipientId: randomUUID() },
    { senderKeyEpoch: 2 },
    { recipientKeyEpoch: 2 },
    { senderId: f.header.recipientId, recipientId: f.header.senderId },
  ]) {
    const b = await privateReplayIdentity(
      await f.wire({ ...patch, messageId: randomUUID() }),
      "conversation.message",
    );
    assert.equal(a.operation, b.operation);
    assert.notEqual(a.sequence, b.sequence);
    assert.throws(() => classifyPrivateReplay(b, [a]), /CONFLICT/);
  }
  const otherOwner = await privateReplayIdentity(
    await f.wire({ ownerId: randomUUID() }),
    "conversation.message",
  );
  for (const key of ["operation", "message", "sequence", "envelope"] as const)
    assert.notEqual(a[key], otherOwner[key]);
});

test("ambiguous or damaged retained matches fail closed instead of treating an incoming message as new", async () => {
  const f = await fixture(),
    a = await privateReplayIdentity(await f.wire(), "conversation.answer");
  assert.throws(() => classifyPrivateReplay(a, [a, a]), /CONFLICT/);
  assert.throws(
    () => classifyPrivateReplay(a, [{ ...a, envelope: "bad" }]),
    /STORAGE_UNAVAILABLE/,
  );
  assert.throws(
    () => classifyPrivateReplay(a, [{ ...a, extra: true }]),
    /STORAGE_UNAVAILABLE/,
  );
  await assert.rejects(
    privateReplayIdentity({ ...(await f.wire()), extra: true }, "task.submit"),
  );
  await assert.rejects(
    privateReplayIdentity(await f.wire(), "untrusted.route" as "task.submit"),
  );
});
