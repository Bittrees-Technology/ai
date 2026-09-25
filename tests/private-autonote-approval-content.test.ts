import { privateReplayIdentity } from "../modules/remote/private-replay.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import {
  splitAutoNoteApproval,
  assembleAutoNoteApproval,
  ApprovalContentError,
} from "../modules/remote/private-autonote-approval-content.js";
import {
  sealPrivateEnvelope,
  openPrivateEnvelope,
  privateEnvelopeSuite,
  privateEnvelopeLimit,
} from "../modules/remote/private-envelope.js";
import { autoNoteApprovalDecisionSchema } from "../modules/remote/private-autonote-approval-contracts.js";
test("complete multipart exact notes survive authenticated encryption; incomplete or altered sets never become reviews", async () => {
  const now = Date.now(),
    meetingId = randomUUID(),
    proposal = {
      operationId: randomUUID(),
      meetingId,
      version: 1,
      projectionHash: "a".repeat(64),
      summary: [{ text: "Synthetic plan", evidence: ["s1"] }],
      actions: [],
    };
  const detail = {
    id: randomUUID(),
    digest: createHash("sha256").update(JSON.stringify(proposal)).digest("hex"),
    expiresAt: new Date(now + 600000).toISOString(),
    meetingId,
    title: "Synthetic multipart notes",
    visibility: "workspace",
    proposal,
    notes: {
      summary: "Retained context and a synthetic addition.",
      topics: [],
      decisions: [],
      actions: Array.from({ length: 30 }, (_, i) => ({
        id: String(i),
        text: "🌳".repeat(1900),
        evidence: ["s1"],
        owner: null,
        dueDate: null,
        status: "proposed",
      })),
      questions: [],
      recommendations: [],
    },
  };
  const scope = {
    offerId: randomUUID(),
    permissionId: randomUUID(),
    sourceApprovalId: randomUUID(),
    grantId: randomUUID(),
    issuedAt: now,
    expiresAt: now + 300000,
  };
  const transfer = await splitAutoNoteApproval(detail, scope, () => now);
  assert.ok(transfer.manifest.byteLength > privateEnvelopeLimit);
  assert.ok(transfer.chunks.length > 1);
  const sender = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    ),
    recipient = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
  const channel = {
    version: 1 as const,
    suite: privateEnvelopeSuite,
    ownerId: randomUUID(),
    senderId: randomUUID(),
    recipientId: randomUUID(),
    senderKeyEpoch: 1,
    recipientKeyEpoch: 1,
    operationId: scope.offerId,
    issuedAt: now,
    expiresAt: scope.expiresAt,
  };
  const received: any[] = [];
  const replayOperations = new Set<string>();
  let sequence = 1;
  for (const packet of [transfer.manifest, ...transfer.chunks]) {
    const header = {
        ...channel,
        operationId: "id" in packet ? packet.id : packet.offerId,
        messageId: randomUUID(),
        sequence: sequence++,
      },
      plaintext = new TextEncoder().encode(JSON.stringify(packet));
    assert.ok(plaintext.length <= privateEnvelopeLimit);
    const sealed = await sealPrivateEnvelope(
      header,
      plaintext,
      { senderKey: sender, recipientPublicKey: recipient.publicKey },
      () => now,
    );
    assert.equal(JSON.stringify(sealed).includes(detail.title), false);
    const opened = await openPrivateEnvelope(
      sealed,
      header,
      { recipientKey: recipient, senderPublicKey: sender.publicKey },
      () => now,
    );
    const identity = await privateReplayIdentity(sealed, packet.type);
    assert.equal(replayOperations.has(identity.operation), false);
    replayOperations.add(identity.operation);
    received.push(JSON.parse(new TextDecoder().decode(opened.plaintext)));
    opened.plaintext.fill(0);
    plaintext.fill(0);
  }
  const [manifest, ...chunks] = received;
  assert.deepEqual(
    await assembleAutoNoteApproval(manifest, chunks.toReversed(), () => now),
    detail,
  );
  await assert.rejects(
    assembleAutoNoteApproval(manifest, chunks.slice(1), () => now),
    ApprovalContentError,
  );
  await assert.rejects(
    assembleAutoNoteApproval(
      manifest,
      [chunks[0], ...chunks.slice(0, -1)],
      () => now,
    ),
    ApprovalContentError,
  );
  const altered = structuredClone(chunks);
  altered[0].data =
    (altered[0].data[0] === "A" ? "B" : "A") + altered[0].data.slice(1);
  await assert.rejects(
    assembleAutoNoteApproval(manifest, altered, () => now),
    ApprovalContentError,
  );
  await assert.rejects(
    assembleAutoNoteApproval(manifest, chunks, () => scope.expiresAt),
    ApprovalContentError,
  );
  const decision = autoNoteApprovalDecisionSchema.parse({
    version: 1,
    type: "autonote.approval.decision",
    id: randomUUID(),
    offerId: scope.offerId,
    permissionId: scope.permissionId,
    detailHash: manifest.detailHash,
    proposalDigest: detail.digest,
    decision: "approve",
    confirmed: true,
    issuedAt: now,
  });
  assert.equal(decision.detailHash, manifest.detailHash);
  assert.equal(
    autoNoteApprovalDecisionSchema.safeParse({
      ...decision,
      sourceToken: "never allowed",
    }).success,
    false,
  );
});
