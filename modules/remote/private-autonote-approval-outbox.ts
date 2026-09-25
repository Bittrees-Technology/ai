import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store, Owner } from "../storage/store.js";
import type { Vault } from "../storage/vault.js";
import type { PrivateAutoNoteApprovalConsent } from "./private-autonote-approval-consent.js";
import {
  autoNoteApprovalOutboxesSchema,
  type AutoNoteApprovalOutbox,
} from "./private-autonote-approval-outbox-contracts.js";
import {
  sealPrivateEnvelope,
  privateEnvelopeSuite,
  type PrivateEnvelope,
} from "./private-envelope.js";
import { reservePrivateSequence } from "./private-send-sequence.js";
import {
  privateRelayEnvelopeHash,
  privateRelayStorageReceiptSchema,
} from "./private-relay-contracts.js";
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export class ApprovalOutboxError extends Error {
  constructor(readonly code: "DENIED" | "CONFLICT" | "CAPACITY") {
    super(code);
  }
}
/** Internal outbox. Host supplies reviewed dispatch and an authenticated relay sender.
 * Nothing polls, resumes, uploads or executes a source write automatically. */
export class PrivateAutoNoteApprovalOutbox {
  private active = new Set<string>();
  constructor(
    private store: Store,
    private vault: Vault,
    private owner: Owner,
    private consent: PrivateAutoNoteApprovalConsent,
    private now = Date.now,
  ) {
    this.owner = { ...owner };
  }
  get busy() {
    return this.active.size > 0;
  }
  private async exclusive<T>(id: string, fn: () => Promise<T>) {
    if (this.active.has(id)) throw new ApprovalOutboxError("CONFLICT");
    this.active.add(id);
    try {
      return await fn();
    } finally {
      this.active.delete(id);
    }
  }
  private list(operationId: string) {
    return autoNoteApprovalOutboxesSchema.parse(
      this.store.autoNoteReview(this.owner, operationId).approvalOutboxes ?? [],
    );
  }
  private get(operationId: string, id: string) {
    const value = this.list(operationId).find((b) => b.id === id);
    if (!value) throw new ApprovalOutboxError("DENIED");
    return value;
  }
  private save(
    operationId: string,
    box: AutoNoteApprovalOutbox,
    revision: number,
  ) {
    const boxes = this.list(operationId),
      index = boxes.findIndex((b) => b.id === box.id);
    if (index < 0) boxes.push(box);
    else boxes[index] = box;
    return this.store.setAutoNoteApprovalOutboxes(
      this.owner,
      operationId,
      revision,
      boxes,
    );
  }
  private async checked(operationId: string, id: string) {
    const original = this.get(operationId, id),
      handle = await this.consent.resolve(operationId, original.grant.id);
    handle.check();
    const box = this.get(operationId, id);
    if (!same(original, box)) throw new ApprovalOutboxError("CONFLICT");
    if (
      box.state === "stopped" ||
      box.manifest.expiresAt <= this.now() ||
      !same(box.grant, handle.grant)
    )
      throw new ApprovalOutboxError("DENIED");
    return { box, handle };
  }
  status(operationId: string) {
    return this.list(operationId).map((box) => ({
      id: box.id,
      permissionId: box.grant.id,
      state: box.state,
      expiresAt: box.manifest.expiresAt,
      packets: box.parts.map((p, index) => ({
        index,
        messageId: p.header.messageId,
        encrypted: !!p.envelope,
        attempts: p.attempts,
        receipt: p.receipt,
      })),
    }));
  }
  async prepare(raw: unknown) {
    const input = z
      .strictObject({
        operationId: z.uuid(),
        permissionId: z.uuid(),
        clientRequestId: z.uuid(),
        expectedRevision: z.number().int().positive(),
        confirmed: z.literal(true),
      })
      .parse(raw);
    return this.exclusive(input.operationId, async () => {
      const prior = this.list(input.operationId).find(
        (b) => b.clientRequestId === input.clientRequestId,
      );
      if (prior) {
        if (
          prior.grant.id !== input.permissionId ||
          prior.requestRevision !== input.expectedRevision
        )
          throw new ApprovalOutboxError("CONFLICT");
        await this.checked(input.operationId, prior.id);
        return { id: prior.id };
      }
      const offerId = randomUUID(),
        framed = await this.consent.frameOffer(
          input.operationId,
          input.permissionId,
          offerId,
        ),
        handle = await this.consent.resolve(
          input.operationId,
          input.permissionId,
        );
      handle.check();
      if (!same(framed.grant, handle.grant))
        throw new ApprovalOutboxError("DENIED");
      return this.store.db
        .transaction(() => {
          handle.check();
          const item = this.store.autoNoteReview(this.owner, input.operationId),
            boxes = this.list(input.operationId);
          if (
            item.revision !== input.expectedRevision ||
            boxes.some((b) => b.clientRequestId === input.clientRequestId)
          )
            throw new ApprovalOutboxError("CONFLICT");
          if (boxes.length >= 4) throw new ApprovalOutboxError("CAPACITY");
          const channel = {
            ownerId: handle.grant.local.binding.ownerId,
            senderId: handle.grant.local.binding.deviceId,
            recipientId: handle.grant.peer.peerId,
            senderKeyEpoch: handle.grant.local.keyEpoch,
            recipientKeyEpoch: handle.grant.peer.keyEpoch,
          };
          const box: AutoNoteApprovalOutbox = {
            id: offerId,
            clientRequestId: input.clientRequestId,
            requestRevision: input.expectedRevision,
            grant: handle.grant,
            manifest: framed.manifest,
            state: "preparing",
            parts: [framed.manifest, ...framed.chunks].map((packet) => ({
              header: {
                version: 1,
                suite: privateEnvelopeSuite,
                ...channel,
                messageId: randomUUID(),
                operationId: "id" in packet ? packet.id : packet.offerId,
                sequence: reservePrivateSequence(
                  this.store,
                  this.vault,
                  this.owner,
                  channel,
                ),
                issuedAt: framed.manifest.issuedAt,
                expiresAt: framed.manifest.expiresAt,
              },
              packet,
              envelope: null,
              attempts: 0,
              lastAttemptAt: null,
              receipt: null,
            })),
          };
          this.save(input.operationId, box, item.revision);
          return { id: offerId };
        })
        .immediate();
    });
  }
  async encrypt(operationId: string, id: string) {
    return this.exclusive(operationId, async () => {
      const { handle } = await this.checked(operationId, id);
      for (let index = 0; ; index++) {
        handle.check();
        const item = this.store.autoNoteReview(this.owner, operationId),
          box = this.get(operationId, id);
        if (box.state === "stopped" || box.manifest.expiresAt <= this.now())
          throw new ApprovalOutboxError("DENIED");
        const part = box.parts[index];
        if (!part) break;
        if (part.envelope) continue;
        const plaintext = new TextEncoder().encode(JSON.stringify(part.packet));
        try {
          part.envelope = await sealPrivateEnvelope(
            part.header,
            plaintext,
            {
              senderKey: handle.localKey,
              recipientPublicKey: handle.peerPublicKey,
            },
            this.now,
          );
        } finally {
          plaintext.fill(0);
        }
        handle.check();
        part.packet = null;
        if (box.parts.every((p) => p.envelope)) box.state = "ready";
        this.save(operationId, box, item.revision);
      }
      return this.status(operationId).find((b) => b.id === id)!;
    });
  }
  async dispatch(
    operationId: string,
    id: string,
    index: number,
    send: (envelope: PrivateEnvelope) => Promise<unknown>,
  ) {
    return this.exclusive(operationId, async () => {
      z.number().int().nonnegative().parse(index);
      const { box, handle } = await this.checked(operationId, id),
        part = box.parts[index];
      if (
        box.state !== "ready" ||
        !part?.envelope ||
        part.attempts >= Number.MAX_SAFE_INTEGER
      )
        throw new ApprovalOutboxError("DENIED");
      const envelope = structuredClone(part.envelope),
        hash = await privateRelayEnvelopeHash(envelope);
      handle.check();
      const item = this.store.autoNoteReview(this.owner, operationId),
        current = this.get(operationId, id);
      if (!same(current, box)) throw new ApprovalOutboxError("CONFLICT");
      part.attempts++;
      part.lastAttemptAt = this.now();
      part.receipt = null;
      this.save(operationId, box, item.revision);
      handle.check();
      const receipt = privateRelayStorageReceiptSchema.parse(
        await send(envelope),
      );
      if (
        receipt.messageId !== part.header.messageId ||
        receipt.envelopeHash !== hash ||
        receipt.storedAt < part.header.issuedAt - 30000 ||
        receipt.storedAt > this.now() + 30000
      )
        throw new ApprovalOutboxError("DENIED");
      // Preserve a valid storage observation even if consent was revoked during upload.
      const latest = this.store.autoNoteReview(this.owner, operationId),
        retained = this.get(operationId, id),
        target = retained.parts[index]!;
      if (
        !same(target.envelope, part.envelope) ||
        target.attempts !== part.attempts
      )
        throw new ApprovalOutboxError("CONFLICT");
      target.receipt = receipt;
      this.save(operationId, retained, latest.revision);
      return receipt;
    });
  }
  stop(operationId: string, id: string) {
    const item = this.store.autoNoteReview(this.owner, operationId),
      box = this.get(operationId, id);
    box.state = "stopped";
    this.save(operationId, box, item.revision);
  }
  remove(operationId: string, id: string) {
    if (this.active.has(operationId)) throw new ApprovalOutboxError("CONFLICT");
    const item = this.store.autoNoteReview(this.owner, operationId),
      boxes = this.list(operationId);
    if (!boxes.some((b) => b.id === id && b.state === "stopped"))
      throw new ApprovalOutboxError("DENIED");
    this.store.setAutoNoteApprovalOutboxes(
      this.owner,
      operationId,
      item.revision,
      boxes.filter((b) => b.id !== id),
    );
  }
}
