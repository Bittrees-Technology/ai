import { randomUUID } from "node:crypto";
import { z } from "zod";
import { id } from "../contracts/index.js";
import type { Store, Owner } from "../storage/store.js";
import type { Vault } from "../storage/vault.js";
import {
  privateBindingSchema,
  type PrivateBinding,
} from "./private-peer-contracts.js";
import { PrivatePeerEnrollment } from "./private-peers.js";
import {
  openPrivateEnvelope,
  privateEnvelopeSchema,
} from "./private-envelope.js";
import {
  privateReceiptPurpose,
  privateTaskReceiptSchema,
  type PrivateTaskReceipt,
} from "./private-task-receipts.js";

import { privateTaskPayloadSchema } from "./private-task-contracts.js";
export { privateTaskPayloadSchema } from "./private-task-contracts.js";
const permissionSchema = z.strictObject({
  binding: privateBindingSchema,
  peerId: z.uuid(),
  recipientKeyEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  permissionRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  modelProfileId: id,
  tasksEnabled: z.literal(true),
});
export type PrivateTaskAuthority = z.infer<typeof permissionSchema> & {
  recipientKey: CryptoKeyPair;
};
export class PrivateTaskError extends Error {
  constructor(
    readonly code: "DENIED" | "CONFLICT" | "CAPACITY" | "STORAGE_UNAVAILABLE",
  ) {
    super(code);
  }
}
type ReceiptRow = {
  operation_hash: string;
  message_hash: string;
  sequence_hash: string;
  envelope_hash: string;
  payload: Buffer;
};

/** Admission boundary. The Mac local controller supplies fresh scoped providers.
 * Providers must read
 * verified current account/device/key state and explicit per-peer local consent.
 * A reviewed public key alone is never task-submission permission.
 */
export class PrivateTaskReceiver {
  private inflight = 0;
  private peers: PrivatePeerEnrollment;
  constructor(
    private store: Store,
    private vault: Vault,
    private owner: Owner,
    currentBinding: () => PrivateBinding | null,
    private authority: (peerId: string) => PrivateTaskAuthority | null,
    private now = Date.now,
  ) {
    this.owner = { ...owner };
    this.peers = new PrivatePeerEnrollment(
      store,
      vault,
      this.owner,
      currentBinding,
      now,
    );
  }
  private permission(peerId: string) {
    const supplied = this.authority(peerId);
    if (!supplied) throw new PrivateTaskError("DENIED");
    const { recipientKey, ...raw } = supplied;
    const value = permissionSchema.safeParse(raw);
    if (
      !value.success ||
      value.data.peerId !== peerId ||
      value.data.binding.expiresAt <= this.now()
    )
      throw new PrivateTaskError("DENIED");
    return {
      value: value.data,
      key: {
        privateKey: recipientKey.privateKey,
        publicKey: recipientKey.publicKey,
      },
    };
  }
  async accept(raw: unknown): Promise<PrivateTaskReceipt> {
    if (this.inflight >= 4) throw new PrivateTaskError("CAPACITY");
    this.inflight++;
    let plaintext: Uint8Array | undefined;
    try {
      const envelope = privateEnvelopeSchema.parse(raw),
        h = envelope.header;
      const permission = this.permission(h.senderId),
        p = permission.value;
      if (
        h.ownerId !== p.binding.ownerId ||
        h.recipientId !== p.binding.deviceId ||
        h.recipientKeyEpoch !== p.recipientKeyEpoch
      )
        throw new PrivateTaskError("DENIED");
      const peer = await this.peers.resolve(h.senderId, h.senderKeyEpoch);
      if (JSON.stringify(peer.proof.binding) !== JSON.stringify(p.binding))
        throw new PrivateTaskError("DENIED");
      // Untrusted IDs/sequence are only candidates until cryptographically verified
      // and consumed in the same transaction as the task and receipt below.
      const opened = await openPrivateEnvelope(
        envelope,
        h,
        { recipientKey: permission.key, senderPublicKey: peer.publicKey },
        this.now,
      );
      plaintext = opened.plaintext;
      const payload = privateTaskPayloadSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)),
      );
      const hash = (kind: string, value: unknown) =>
        this.vault.fingerprint(["private-task:v1", this.owner, kind, value]);
      // Operation/message IDs cannot be reused across peer or key rotation for
      // this local owner and remote account. Sequence is scoped to a directed epoch channel.
      const operationHash = hash("operation", [h.ownerId, h.operationId]),
        messageHash = hash("message", [h.ownerId, h.messageId]),
        sequenceHash = hash("sequence", [
          h.ownerId,
          h.senderId,
          h.recipientId,
          h.senderKeyEpoch,
          h.recipientKeyEpoch,
          h.sequence,
        ]),
        envelopeHash = hash("envelope", envelope);
      return this.store.db
        .transaction(() => {
          const current = this.permission(h.senderId);
          if (
            JSON.stringify(current.value) !== JSON.stringify(p) ||
            current.key.privateKey !== permission.key.privateKey ||
            current.key.publicKey !== permission.key.publicKey ||
            !this.peers.validate(peer.proof) ||
            h.expiresAt <= this.now()
          )
            throw new PrivateTaskError("DENIED");
          const previous = this.store.db
            .prepare(
              "SELECT operation_hash,message_hash,sequence_hash,envelope_hash,payload FROM private_task_receipts WHERE user_id=? AND tenant_id=? AND (operation_hash=? OR message_hash=? OR sequence_hash=?)",
            )
            .all(
              this.owner.userId,
              this.owner.tenantId,
              operationHash,
              messageHash,
              sequenceHash,
            ) as ReceiptRow[];
          if (previous.length) {
            const row = previous[0];
            if (
              !row ||
              previous.length !== 1 ||
              row.operation_hash !== operationHash ||
              row.message_hash !== messageHash ||
              row.sequence_hash !== sequenceHash ||
              row.envelope_hash !== envelopeHash
            )
              throw new PrivateTaskError("CONFLICT");
            try {
              return privateTaskReceiptSchema.parse(
                this.vault.open(
                  row.payload,
                  privateReceiptPurpose(this.owner, operationHash),
                ),
              );
            } catch {
              throw new PrivateTaskError("STORAGE_UNAVAILABLE");
            }
          }
          const count = this.store.db
            .prepare(
              "SELECT COUNT(*) AS count FROM private_task_receipts WHERE user_id=? AND tenant_id=?",
            )
            .get(this.owner.userId, this.owner.tenantId) as { count: number };
          if (count.count >= 1024) throw new PrivateTaskError("CAPACITY");
          this.store.profile(this.owner, p.modelProfileId);
          const task = this.store.create(
            this.owner,
            {
              conversationId: randomUUID(),
              kind: payload.kind,
              prompt: payload.prompt,
              modelProfileId: p.modelProfileId,
            },
            "private-task:" + operationHash,
          );
          const receipt = privateTaskReceiptSchema.parse({
            version: 1,
            id: randomUUID(),
            taskId: task.id,
            status: "accepted",
            acceptedAt: this.now(),
            header: h,
            permissionRevision: p.permissionRevision,
          });
          if (
            receipt.acceptedAt >= h.expiresAt ||
            receipt.acceptedAt >= p.binding.expiresAt
          )
            throw new PrivateTaskError("DENIED");
          this.store.db
            .prepare(
              "INSERT INTO private_task_receipts(user_id,tenant_id,operation_hash,message_hash,sequence_hash,envelope_hash,payload) VALUES(?,?,?,?,?,?,?)",
            )
            .run(
              this.owner.userId,
              this.owner.tenantId,
              operationHash,
              messageHash,
              sequenceHash,
              envelopeHash,
              this.vault.seal(
                receipt,
                privateReceiptPurpose(this.owner, operationHash),
              ),
            );
          return receipt;
        })
        .immediate();
    } catch (error) {
      if (error instanceof PrivateTaskError) throw error;
      throw new PrivateTaskError("DENIED");
    } finally {
      plaintext?.fill(0);
      this.inflight--;
    }
  }
}
