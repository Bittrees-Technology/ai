import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Owner, Store } from "../storage/store.js";
import type { Vault } from "../storage/vault.js";
import type { ResumeAccess } from "../storage/remote-resumes.js";
import { PrivateResumeConsent } from "./private-resume-consent.js";
import { resumeReceiptSchema } from "./resume-contracts.js";
import {
  privateEnvelopeSchema,
  privateHeaderSchema,
  privateEnvelopeSuite,
  openPrivateEnvelope,
  sealPrivateEnvelope,
} from "./private-envelope.js";
import { privateReplayIdentity } from "./private-replay.js";
import { consumePrivateIncomingReplay } from "./private-incoming-replay.js";
import { reservePrivateSequence } from "./private-send-sequence.js";
import {
  privateResumeCommandSchema,
  privateResumeReceiptSchema,
} from "./private-resume-contracts.js";
export {
  privateResumeCommandSchema,
  privateResumeReceiptSchema,
} from "./private-resume-contracts.js";
const receiveSchema = z.strictObject({
  permissionId: z.uuid(),
  envelope: privateEnvelopeSchema,
  confirmed: z.literal(true),
});
const receiptInput = z.strictObject({
  permissionId: z.uuid(),
  commandId: z.uuid(),
  confirmed: z.literal(true),
});
const savedSchema = z
  .strictObject({
    permissionId: z.uuid(),
    request: privateEnvelopeSchema,
    receipt: resumeReceiptSchema,
    header: privateHeaderSchema,
    envelope: privateEnvelopeSchema.nullable(),
  })
  .refine(
    (v) =>
      v.permissionId === v.receipt.permissionId &&
      v.request.header.operationId === v.receipt.id &&
      v.header.operationId === v.receipt.id &&
      v.header.ownerId === v.request.header.ownerId &&
      v.header.senderId === v.request.header.recipientId &&
      v.header.recipientId === v.request.header.senderId &&
      v.header.senderKeyEpoch === v.request.header.recipientKeyEpoch &&
      v.header.recipientKeyEpoch === v.request.header.senderKeyEpoch &&
      (!v.envelope || same(v.header, v.envelope.header)),
  );
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
type Saved = z.infer<typeof savedSchema>;
const purpose = (owner: Owner, id: string) =>
  JSON.stringify([
    "private-resume-delivery:v1",
    owner.tenantId,
    owner.userId,
    id,
  ]);
export class PrivateResumeDeliveryError extends Error {
  constructor(readonly code: "DENIED" | "CONFLICT" | "STORAGE_UNAVAILABLE") {
    super(code);
  }
}
function read(
  store: Store,
  vault: Vault,
  owner: Owner,
  id: string,
): { locked: boolean; value: Saved } | null {
  const row = store.db
    .prepare(
      "SELECT locked,payload FROM private_resume_delivery WHERE user_id=? AND tenant_id=? AND id=?",
    )
    .get(owner.userId, owner.tenantId, id) as
    { locked: number; payload: Buffer } | undefined;
  if (!row) return null;
  try {
    if (
      ![0, 1].includes(row.locked) ||
      !Buffer.isBuffer(row.payload) ||
      row.payload.length > 262144
    )
      throw Error();
    const value = savedSchema.parse(
      vault.open(row.payload, purpose(owner, id)),
    );
    if (value.receipt.id !== id) throw Error();
    return { locked: row.locked === 1, value };
  } catch {
    throw new PrivateResumeDeliveryError("STORAGE_UNAVAILABLE");
  }
}
export function exportPrivateResumeDelivery(
  store: Store,
  vault: Vault,
  owner: Owner,
) {
  const rows = store.db
    .prepare(
      "SELECT id FROM private_resume_delivery WHERE user_id=? AND tenant_id=? ORDER BY id LIMIT 1025",
    )
    .all(owner.userId, owner.tenantId) as { id: string }[];
  if (rows.length > 1024)
    throw new PrivateResumeDeliveryError("STORAGE_UNAVAILABLE");
  return rows.map((r) => ({ id: r.id, ...read(store, vault, owner, r.id)! }));
}
/** Host-owned encrypted admission only; no network route or implicit consent.
 * Receipt confirms the committed resume transition, never task completion. */
export class PrivateResumeDelivery {
  constructor(
    private store: Store,
    private vault: Vault,
    private owner: Owner,
    private consent: PrivateResumeConsent,
    private access: ResumeAccess,
    private now = Date.now,
  ) {
    this.owner = { ...owner };
  }
  private write(id: string, value: Saved, insert = false) {
    if (!this.store.db.inTransaction)
      throw new PrivateResumeDeliveryError("STORAGE_UNAVAILABLE");
    const payload = this.vault.seal(
      savedSchema.parse(value),
      purpose(this.owner, id),
    );
    if (insert)
      this.store.db
        .prepare("INSERT INTO private_resume_delivery VALUES(?,?,?,0,?)")
        .run(this.owner.userId, this.owner.tenantId, id, payload);
    else {
      const r = this.store.db
        .prepare(
          "UPDATE private_resume_delivery SET payload=? WHERE user_id=? AND tenant_id=? AND id=? AND locked=0",
        )
        .run(payload, this.owner.userId, this.owner.tenantId, id);
      if (r.changes !== 1) throw new PrivateResumeDeliveryError("CONFLICT");
    }
  }
  async receive(raw: unknown) {
    const input = receiveSchema.parse(raw),
      handle = await this.consent.resolve(input.permissionId),
      g = handle.grant,
      h = input.envelope.header;
    if (
      h.ownerId !== g.local.binding.ownerId ||
      h.senderId !== g.peer.peerId ||
      h.senderKeyEpoch !== g.peer.keyEpoch ||
      h.recipientId !== g.local.binding.deviceId ||
      h.recipientKeyEpoch !== g.local.keyEpoch ||
      h.expiresAt > g.choices.expiresAt
    )
      throw new PrivateResumeDeliveryError("DENIED");
    const opened = await openPrivateEnvelope(
      input.envelope,
      h,
      { recipientKey: handle.localKey, senderPublicKey: handle.peerPublicKey },
      this.now,
    );
    let body: z.infer<typeof privateResumeCommandSchema>;
    try {
      body = privateResumeCommandSchema.parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(opened.plaintext),
        ),
      );
    } finally {
      opened.plaintext.fill(0);
    }
    const command = body.command;
    if (
      command.permissionId !== input.permissionId ||
      command.id !== h.operationId ||
      Date.parse(command.issuedAt) !== h.issuedAt ||
      Date.parse(command.expiresAt) !== h.expiresAt
    )
      throw new PrivateResumeDeliveryError("DENIED");
    const replay = await privateReplayIdentity(input.envelope, body.type);
    const check = () => {
      handle.check();
      if (this.now() < h.issuedAt || this.now() >= h.expiresAt)
        throw new PrivateResumeDeliveryError("DENIED");
    };
    check();
    return this.store.remoteResumes.executeDelivery(
      this.owner,
      handle.identity,
      command,
      this.access,
      {
        check,
        admit: (receipt) => {
          const prior = read(this.store, this.vault, this.owner, command.id);
          if (
            prior &&
            (prior.locked ||
              !same(prior.value.request, input.envelope) ||
              !same(prior.value.receipt, receipt) ||
              prior.value.permissionId !== input.permissionId)
          )
            throw new PrivateResumeDeliveryError("CONFLICT");
          const outcome = consumePrivateIncomingReplay(
            this.store,
            this.vault,
            this.owner,
            replay,
            { collection: "remote_resume_receipts", id: command.id },
          );
          if ((outcome === "duplicate") !== !!prior)
            throw new PrivateResumeDeliveryError("CONFLICT");
          if (!prior) {
            const channel = {
              ownerId: h.ownerId,
              senderId: h.recipientId,
              recipientId: h.senderId,
              senderKeyEpoch: h.recipientKeyEpoch,
              recipientKeyEpoch: h.senderKeyEpoch,
            };
            const header = privateHeaderSchema.parse({
              version: 1,
              suite: privateEnvelopeSuite,
              ...channel,
              messageId: randomUUID(),
              operationId: command.id,
              sequence: reservePrivateSequence(
                this.store,
                this.vault,
                this.owner,
                channel,
              ),
              issuedAt: this.now(),
              expiresAt: g.choices.expiresAt,
            });
            this.write(
              command.id,
              {
                permissionId: input.permissionId,
                request: input.envelope,
                receipt,
                header,
                envelope: null,
              },
              true,
            );
          }
          return outcome;
        },
      },
    );
  }
  /** Separately reviewed encryption; no upload and no new task effect. Concurrent
   * sealing retains and returns exactly one original envelope across restart. */
  async receipt(raw: unknown) {
    const input = receiptInput.parse(raw),
      handle = await this.consent.resolve(input.permissionId);
    const checked = () => {
      handle.check();
      const row = read(this.store, this.vault, this.owner, input.commandId);
      if (
        !row ||
        row.locked ||
        row.value.permissionId !== input.permissionId ||
        this.now() < row.value.header.issuedAt ||
        this.now() >= row.value.header.expiresAt
      )
        throw new PrivateResumeDeliveryError("DENIED");
      return row.value;
    };
    const before = checked();
    if (before.envelope) return structuredClone(before.envelope);
    const plain = new TextEncoder().encode(
      JSON.stringify(
        privateResumeReceiptSchema.parse({
          version: 1,
          type: "task.resumed",
          receipt: before.receipt,
        }),
      ),
    );
    let envelope;
    try {
      envelope = await sealPrivateEnvelope(
        before.header,
        plain,
        {
          senderKey: handle.localKey,
          recipientPublicKey: handle.peerPublicKey,
        },
        this.now,
      );
    } finally {
      plain.fill(0);
    }
    return this.store.db
      .transaction(() => {
        const current = checked();
        if (!same({ ...current, envelope: null }, before))
          throw new PrivateResumeDeliveryError("CONFLICT");
        if (current.envelope) return structuredClone(current.envelope);
        this.write(input.commandId, { ...current, envelope });
        checked();
        return structuredClone(envelope);
      })
      .immediate();
  }
}
