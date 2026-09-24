import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  conversationContentSchema,
  conversationOfferSchema,
  conversationReceiptSchema,
  conversationPermissionsSchema,
} from "../modules/remote/private-conversation-contracts.js";
import {
  sealPrivateEnvelope,
  openPrivateEnvelope,
  privateEnvelopeSuite,
} from "../modules/remote/private-envelope.js";
const now = Date.now();
const scope = { conversationRef: randomUUID(), permissionId: randomUUID() };
const message = {
  version: 1,
  type: "conversation.message",
  scope,
  id: randomUUID(),
  parentId: null,
  content: "Synthetic conversation text",
};
const question = {
  version: 1,
  type: "conversation.question",
  scope,
  id: randomUUID(),
  taskId: randomUUID(),
  taskRevision: 3,
  content: "Which project?",
  deadline: now + 60000,
};
const answer = {
  version: 1,
  type: "conversation.answer",
  scope,
  id: randomUUID(),
  taskId: question.taskId,
  questionId: question.id,
  expectedRevision: 3,
  content: "The selected prototype",
  confirmed: true,
};
test("ordinary conversation messages cannot silently become task answers or action approvals", () => {
  const spaced = { ...message, content: "  Keep this exact spacing.\n" };
  assert.deepEqual(conversationContentSchema.parse(spaced), spaced);
  assert.equal(
    conversationContentSchema.safeParse({ ...message, content: "   " }).success,
    false,
  );
  for (const m of [message, question, answer])
    assert.equal(conversationContentSchema.safeParse(m).success, true);
  for (const patch of [
    { taskId: question.taskId },
    { questionId: question.id },
    { confirmed: true },
    { authority: { publish: true } },
    { type: "task.submit" },
    { modelProfileId: "other" },
    { sourceRefs: [] },
  ])
    assert.equal(
      conversationContentSchema.safeParse({ ...message, ...patch }).success,
      false,
    );
  for (const patch of [
    { confirmed: false },
    { expectedRevision: 0 },
    { questionId: answer.id },
    { permissionId: scope.permissionId },
    { tool: "send" },
  ])
    assert.equal(
      conversationContentSchema.safeParse({ ...answer, ...patch }).success,
      false,
    );
  assert.equal(
    conversationContentSchema.safeParse({ ...message, parentId: message.id })
      .success,
    false,
  );
  assert.equal(
    conversationContentSchema.safeParse({ ...question, deadline: 0 }).success,
    false,
  );
});
test("conversation choices are independently directed and cannot grant task creation, approval or resume", () => {
  const p = {
    messagesToMac: true,
    messagesToBrowser: false,
    questionsToBrowser: false,
    answersToMac: false,
  };
  assert.equal(conversationPermissionsSchema.safeParse(p).success, true);
  assert.equal(
    conversationPermissionsSchema.safeParse({ ...p, messagesToMac: false })
      .success,
    false,
  );
  assert.equal(
    conversationPermissionsSchema.safeParse({ ...p, answersToMac: true })
      .success,
    false,
  );
  assert.equal(
    conversationPermissionsSchema.safeParse({
      ...p,
      messagesToMac: false,
      questionsToBrowser: true,
      answersToMac: true,
    }).success,
    true,
  );
  for (const extra of [
    { resume: true },
    { approve: true },
    { receiveTasks: true },
    { modelProfileId: "local" },
    { inboxId: "personal" },
  ])
    assert.equal(
      conversationPermissionsSchema.safeParse({ ...p, ...extra }).success,
      false,
    );
  const offer = {
    version: 1,
    type: "conversation.offer",
    scope,
    permissions: p,
    issuedAt: now,
    expiresAt: now + 86400000,
  };
  assert.equal(conversationOfferSchema.safeParse(offer).success, true);
  for (const patch of [
    { expiresAt: now },
    { expiresAt: now + 86400001 },
    { conversationId: "local-thread" },
    { title: "Private source title" },
  ])
    assert.equal(
      conversationOfferSchema.safeParse({ ...offer, ...patch }).success,
      false,
    );
});
test("encoded conversation content fits the real encrypted envelope byte bound", async () => {
  const sender = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    ),
    recipient = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    );
  const accepted = conversationContentSchema.parse({
    ...message,
    content: "資料🌳".repeat(4000),
  });
  assert.equal(
    conversationContentSchema.safeParse({
      ...message,
      content: "🌳".repeat(16000),
    }).success,
    true,
  );
  assert.equal(
    conversationContentSchema.safeParse({
      ...message,
      content: "資".repeat(24000),
    }).success,
    false,
  );
  const header = {
    version: 1 as const,
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
  const envelope = await sealPrivateEnvelope(
    header,
    new TextEncoder().encode(JSON.stringify(accepted)),
    { senderKey: sender, recipientPublicKey: recipient.publicKey },
    () => now,
  );
  const opened = await openPrivateEnvelope(
    envelope,
    header,
    { recipientKey: recipient, senderPublicKey: sender.publicKey },
    () => now,
  );
  try {
    assert.deepEqual(
      conversationContentSchema.parse(
        JSON.parse(new TextDecoder().decode(opened.plaintext)),
      ),
      accepted,
    );
  } finally {
    opened.plaintext.fill(0);
  }
  const alteredHeader = { ...header, operationId: randomUUID() };
  await assert.rejects(
    openPrivateEnvelope(
      { ...envelope, header: alteredHeader },
      alteredHeader,
      { recipientKey: recipient, senderPublicKey: sender.publicKey },
      () => now,
    ),
  );
});
test("conversation receipts cannot claim execution, source permission or user reading", () => {
  const receipt = {
    version: 1,
    type: "conversation.received",
    scope,
    acceptedId: message.id,
    acceptedType: message.type,
    operationId: randomUUID(),
    acceptedAt: now,
  };
  assert.equal(conversationReceiptSchema.safeParse(receipt).success, true);
  for (const patch of [
    { status: "completed" },
    { readAt: now },
    { sourceAccess: true },
    { acceptedType: "task.submit" },
    { acceptedAt: 0 },
  ])
    assert.equal(
      conversationReceiptSchema.safeParse({ ...receipt, ...patch }).success,
      false,
    );
});
