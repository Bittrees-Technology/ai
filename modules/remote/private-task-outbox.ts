import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Owner, Store } from "../storage/store.js";
import type { Vault } from "../storage/vault.js";
import {
  privateBindingSchema,
  type PrivateBinding,
} from "./private-peer-contracts.js";
import { PrivatePeerEnrollment } from "./private-peers.js";
import {
  privateEnvelopeSchema,
  privateHeaderSchema,
  privateEnvelopeSuite,
  privateEnvelopeLimit,
  openPrivateEnvelope,
  sealPrivateEnvelope,
} from "./private-envelope.js";
import { privateTaskPayloadSchema } from "./private-task-receiver.js";
import { privateTaskReceiptSchema } from "./private-task-receipts.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const permissionSchema = z.strictObject({
  binding: privateBindingSchema,
  peerId: z.uuid(),
  senderKeyEpoch: positive,
  permissionRevision: positive,
  sendingEnabled: z.literal(true),
});
export type PrivateSendAuthority = z.infer<typeof permissionSchema> & {
  senderKey: CryptoKeyPair;
};
const proofSchema = z.strictObject({
  revision: positive,
  binding: privateBindingSchema,
  peerId: z.uuid(),
  keyEpoch: positive,
  fingerprint: hex,
});
const stateSchema = z
  .strictObject({
    requestHash: hex,
    permission: permissionSchema,
    peer: proofSchema,
    header: privateHeaderSchema,
    content: privateTaskPayloadSchema,
    state: z.enum(["preparing", "pending", "accepted", "stopped"]),
    envelope: privateEnvelopeSchema.nullable(),
    receipt: privateTaskReceiptSchema.nullable(),
    attempts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    lastAttemptAt: positive.nullable(),
  })
  .refine(
    (s) =>
      (s.state !== "pending" || !!s.envelope) &&
      (s.state !== "preparing" || !s.envelope) &&
      (s.state === "accepted") === !!s.receipt &&
      (!s.receipt || !!s.envelope) &&
      (!s.envelope ||
        JSON.stringify(s.header) === JSON.stringify(s.envelope.header)) &&
      (!s.receipt ||
        JSON.stringify(s.header) === JSON.stringify(s.receipt.header)),
  );
type State = z.infer<typeof stateSchema>;
type Entry = { id: string; revision: number; locked: boolean; value: State };
export class PrivateOutboxError extends Error {
  constructor(
    readonly code: "DENIED" | "CONFLICT" | "CAPACITY" | "STORAGE_UNAVAILABLE",
  ) {
    super(code);
  }
}
const purpose = (owner: Owner, id: string) =>
  JSON.stringify(["private-task-outbox:v1", owner.tenantId, owner.userId, id]);
function read(store: Store, vault: Vault, owner: Owner, id: string): Entry {
  try {
    const row = store.db
      .prepare(
        "SELECT revision,locked,payload FROM private_task_outbox WHERE user_id=? AND tenant_id=? AND id=?",
      )
      .get(owner.userId, owner.tenantId, id) as
      { revision: number; locked: number; payload: Buffer } | undefined;
    if (!row) throw new PrivateOutboxError("DENIED");
    if (
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      ![0, 1].includes(row.locked) ||
      row.payload.length > 262144
    )
      throw Error();
    return {
      id,
      revision: row.revision,
      locked: row.locked === 1,
      value: stateSchema.parse(vault.open(row.payload, purpose(owner, id))),
    };
  } catch (e) {
    if (e instanceof PrivateOutboxError) throw e;
    throw new PrivateOutboxError("STORAGE_UNAVAILABLE");
  }
}
/** Local private-content export. This is never a remote-status projection. */
export function exportPrivateTaskOutbox(
  store: Store,
  vault: Vault,
  owner: Owner,
) {
  const rows = store.db
    .prepare(
      "SELECT id FROM private_task_outbox WHERE user_id=? AND tenant_id=? ORDER BY id LIMIT 257",
    )
    .all(owner.userId, owner.tenantId) as { id: string }[];
  if (rows.length > 256) throw new PrivateOutboxError("CAPACITY");
  return rows.map((row) => read(store, vault, owner, row.id));
}
const enqueueSchema = z.strictObject({
  clientRequestId: z.uuid(),
  peerId: z.uuid(),
  peerKeyEpoch: positive,
  expectedPeerRevision: positive,
  content: privateTaskPayloadSchema,
  confirmed: z.literal(true),
});
export const privateAcceptedPayloadSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("task.accepted"),
  receipt: privateTaskReceiptSchema,
});

/** Internal durable sender; no transport, timers, HTTP routes, key storage or UI.
 * Providers must read verified current identity and separate local per-peer sending consent.
 */
export class PrivateTaskOutbox {
  private peers: PrivatePeerEnrollment;
  private inflight = 0;
  constructor(
    private store: Store,
    private vault: Vault,
    private owner: Owner,
    currentBinding: () => PrivateBinding | null,
    private authority: (peerId: string) => PrivateSendAuthority | null,
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
  private hash(kind: string, value: unknown) {
    return this.vault.fingerprint([
      "private-outbox:v1",
      this.owner,
      kind,
      value,
    ]);
  }
  private permission(peerId: string) {
    const supplied = this.authority(peerId);
    if (!supplied) throw new PrivateOutboxError("DENIED");
    const { senderKey, ...raw } = supplied,
      parsed = permissionSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.peerId !== peerId ||
      parsed.data.binding.expiresAt <= this.now()
    )
      throw new PrivateOutboxError("DENIED");
    return {
      value: parsed.data,
      key: { privateKey: senderKey.privateKey, publicKey: senderKey.publicKey },
    };
  }
  private check(entry: Entry) {
    const p = this.permission(entry.value.permission.peerId);
    if (
      entry.locked ||
      JSON.stringify(p.value) !== JSON.stringify(entry.value.permission) ||
      !this.peers.validate(entry.value.peer)
    )
      throw new PrivateOutboxError("DENIED");
    return p;
  }
  private save(entry: Entry) {
    if (entry.revision >= Number.MAX_SAFE_INTEGER)
      throw new PrivateOutboxError("CAPACITY");
    stateSchema.parse(entry.value);
    const payload = this.vault.seal(entry.value, purpose(this.owner, entry.id));
    if (payload.length > 262144) throw new PrivateOutboxError("CAPACITY");
    const result = this.store.db
      .prepare(
        "UPDATE private_task_outbox SET revision=revision+1,payload=? WHERE user_id=? AND tenant_id=? AND id=? AND revision=?",
      )
      .run(
        payload,
        this.owner.userId,
        this.owner.tenantId,
        entry.id,
        entry.revision,
      );
    if (result.changes !== 1) throw new PrivateOutboxError("CONFLICT");
    entry.revision++;
  }
  private async bounded<T>(work: () => Promise<T>) {
    if (this.inflight >= 4) throw new PrivateOutboxError("CAPACITY");
    this.inflight++;
    try {
      return await work();
    } catch (e) {
      if (e instanceof PrivateOutboxError) throw e;
      throw new PrivateOutboxError("DENIED");
    } finally {
      this.inflight--;
    }
  }
  get(id: string) {
    return read(this.store, this.vault, this.owner, z.uuid().parse(id));
  }
  enqueue(raw: unknown) {
    return this.bounded(async () => {
      const input = enqueueSchema.parse(raw);
      if (
        new TextEncoder().encode(JSON.stringify(input.content)).byteLength >
        privateEnvelopeLimit
      )
        throw new PrivateOutboxError("DENIED");
      const permission = this.permission(input.peerId);
      const pin = await this.peers.resolve(input.peerId, input.peerKeyEpoch);
      if (
        pin.proof.revision !== input.expectedPeerRevision ||
        JSON.stringify(pin.proof.binding) !==
          JSON.stringify(permission.value.binding)
      )
        throw new PrivateOutboxError("CONFLICT");
      const clientHash = this.hash("client", input.clientRequestId),
        requestHash = this.hash("request", input);
      const entry = this.store.db
        .transaction(() => {
          const p = this.permission(input.peerId);
          if (
            JSON.stringify(p.value) !== JSON.stringify(permission.value) ||
            p.key.privateKey !== permission.key.privateKey ||
            p.key.publicKey !== permission.key.publicKey ||
            !this.peers.validate(pin.proof)
          )
            throw new PrivateOutboxError("DENIED");
          const existing = this.store.db
            .prepare(
              "SELECT id FROM private_task_outbox WHERE user_id=? AND tenant_id=? AND client_hash=?",
            )
            .get(this.owner.userId, this.owner.tenantId, clientHash) as
            { id: string } | undefined;
          if (existing) {
            const found = this.get(existing.id);
            this.check(found);
            if (found.value.requestHash !== requestHash)
              throw new PrivateOutboxError("CONFLICT");
            return found;
          }
          const count = this.store.db
            .prepare(
              "SELECT COUNT(*) AS count FROM private_task_outbox WHERE user_id=? AND tenant_id=?",
            )
            .get(this.owner.userId, this.owner.tenantId) as { count: number };
          if (count.count >= 256) throw new PrivateOutboxError("CAPACITY");
          const id = randomUUID(),
            issuedAt = this.now(),
            b = p.value.binding;
          const channel = this.hash("channel", [
            b.ownerId,
            b.deviceId,
            input.peerId,
            p.value.senderKeyEpoch,
            input.peerKeyEpoch,
          ]);
          this.store.db
            .prepare(
              "INSERT OR IGNORE INTO private_send_channels(user_id,tenant_id,channel_hash,next_sequence) VALUES(?,?,?,1)",
            )
            .run(this.owner.userId, this.owner.tenantId, channel);
          const c = this.store.db
            .prepare(
              "UPDATE private_send_channels SET next_sequence=next_sequence+1 WHERE user_id=? AND tenant_id=? AND channel_hash=? AND next_sequence<? RETURNING next_sequence-1 AS sequence",
            )
            .get(
              this.owner.userId,
              this.owner.tenantId,
              channel,
              Number.MAX_SAFE_INTEGER,
            ) as { sequence: number } | undefined;
          if (!c) throw new PrivateOutboxError("CAPACITY");
          const header = privateHeaderSchema.parse({
            version: 1,
            suite: privateEnvelopeSuite,
            ownerId: b.ownerId,
            senderId: b.deviceId,
            recipientId: input.peerId,
            senderKeyEpoch: p.value.senderKeyEpoch,
            recipientKeyEpoch: input.peerKeyEpoch,
            messageId: randomUUID(),
            operationId: randomUUID(),
            sequence: c.sequence,
            issuedAt,
            expiresAt: Math.min(issuedAt + 86400000, b.expiresAt),
          });
          if (header.expiresAt <= issuedAt)
            throw new PrivateOutboxError("DENIED");
          const value = stateSchema.parse({
            requestHash,
            permission: p.value,
            peer: pin.proof,
            header,
            content: input.content,
            state: "preparing",
            envelope: null,
            receipt: null,
            attempts: 0,
            lastAttemptAt: null,
          });
          const payload = this.vault.seal(value, purpose(this.owner, id));
          if (payload.length > 262144) throw new PrivateOutboxError("CAPACITY");
          this.store.db
            .prepare(
              "INSERT INTO private_task_outbox(user_id,tenant_id,id,client_hash,operation_hash,revision,locked,payload) VALUES(?,?,?,?,?,1,0,?)",
            )
            .run(
              this.owner.userId,
              this.owner.tenantId,
              id,
              clientHash,
              this.hash("operation", [b.ownerId, header.operationId]),
              payload,
            );
          return { id, revision: 1, locked: false, value };
        })
        .immediate();
      return this.prepare(entry.id);
    });
  }
  /** Resume an interrupted preparation by its local ID, never replace a published envelope. */
  resume(id: string) {
    return this.bounded(() => this.prepare(z.uuid().parse(id)));
  }
  private async prepare(id: string) {
    const before = this.get(id),
      p = this.check(before);
    if (before.value.state !== "preparing") return before;
    if (before.value.header.expiresAt <= this.now())
      throw new PrivateOutboxError("DENIED");
    const pin = await this.peers.resolve(
      before.value.peer.peerId,
      before.value.peer.keyEpoch,
    );
    if (JSON.stringify(pin.proof) !== JSON.stringify(before.value.peer))
      throw new PrivateOutboxError("CONFLICT");
    const bytes = new TextEncoder().encode(
      JSON.stringify(before.value.content),
    );
    let envelope;
    try {
      envelope = await sealPrivateEnvelope(
        before.value.header,
        bytes,
        { senderKey: p.key, recipientPublicKey: pin.publicKey },
        this.now,
      );
    } finally {
      bytes.fill(0);
    }
    return this.store.db
      .transaction(() => {
        const entry = this.get(id),
          current = this.check(entry);
        if (
          current.key.privateKey !== p.key.privateKey ||
          current.key.publicKey !== p.key.publicKey ||
          entry.value.header.expiresAt <= this.now()
        )
          throw new PrivateOutboxError("DENIED");
        if (entry.value.state !== "preparing") return entry;
        if (entry.revision !== before.revision)
          throw new PrivateOutboxError("CONFLICT");
        entry.value.envelope = envelope;
        entry.value.state = "pending";
        this.save(entry);
        return entry;
      })
      .immediate();
  }
  /** Call immediately before transport; copies already handed to a transport cannot be recalled. */
  delivery(id: string) {
    try {
      return this.store.db
        .transaction(() => {
          const entry = this.get(id);
          this.check(entry);
          if (
            entry.value.state !== "pending" ||
            !entry.value.envelope ||
            entry.value.header.expiresAt <= this.now()
          )
            throw new PrivateOutboxError("DENIED");
          if (entry.value.attempts >= Number.MAX_SAFE_INTEGER)
            throw new PrivateOutboxError("CAPACITY");
          entry.value.attempts++;
          entry.value.lastAttemptAt = this.now();
          if (
            entry.value.lastAttemptAt >= entry.value.header.expiresAt ||
            entry.value.lastAttemptAt >=
              entry.value.permission.binding.expiresAt
          )
            throw new PrivateOutboxError("DENIED");
          this.save(entry);
          return structuredClone(entry.value.envelope);
        })
        .immediate();
    } catch (e) {
      if (e instanceof PrivateOutboxError) throw e;
      throw new PrivateOutboxError("DENIED");
    }
  }
  stop(raw: unknown) {
    const input = z
      .strictObject({
        id: z.uuid(),
        expectedRevision: positive,
        confirmed: z.literal(true),
      })
      .parse(raw);
    return this.store.db
      .transaction(() => {
        const entry = this.get(input.id);
        if (entry.revision !== input.expectedRevision)
          throw new PrivateOutboxError("CONFLICT");
        if (entry.value.state === "accepted")
          throw new PrivateOutboxError("DENIED");
        entry.value.state = "stopped";
        this.save(entry);
        return entry;
      })
      .immediate();
  }
  acceptReceipt(raw: unknown) {
    return this.bounded(async () => {
      const envelope = privateEnvelopeSchema.parse(raw),
        h = envelope.header;
      const row = this.store.db
        .prepare(
          "SELECT id FROM private_task_outbox WHERE user_id=? AND tenant_id=? AND operation_hash=?",
        )
        .get(
          this.owner.userId,
          this.owner.tenantId,
          this.hash("operation", [h.ownerId, h.operationId]),
        ) as { id: string } | undefined;
      if (!row) throw new PrivateOutboxError("DENIED");
      const before = this.get(row.id),
        p = this.check(before),
        original = before.value.header;
      if (
        !before.value.envelope ||
        h.senderId !== original.recipientId ||
        h.recipientId !== original.senderId ||
        h.senderKeyEpoch !== original.recipientKeyEpoch ||
        h.recipientKeyEpoch !== original.senderKeyEpoch
      )
        throw new PrivateOutboxError("DENIED");
      const pin = await this.peers.resolve(h.senderId, h.senderKeyEpoch);
      if (JSON.stringify(pin.proof) !== JSON.stringify(before.value.peer))
        throw new PrivateOutboxError("CONFLICT");
      const opened = await openPrivateEnvelope(
        envelope,
        h,
        { recipientKey: p.key, senderPublicKey: pin.publicKey },
        this.now,
      );
      let receipt;
      try {
        receipt = privateAcceptedPayloadSchema.parse(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(opened.plaintext),
          ),
        ).receipt;
      } finally {
        opened.plaintext.fill(0);
      }
      if (
        JSON.stringify(receipt.header) !== JSON.stringify(original) ||
        receipt.acceptedAt >= original.expiresAt ||
        receipt.acceptedAt > this.now() + 30000 ||
        receipt.acceptedAt < original.issuedAt - 30000
      )
        throw new PrivateOutboxError("DENIED");
      return this.store.db
        .transaction(() => {
          const entry = this.get(row.id),
            current = this.check(entry);
          if (
            current.key.privateKey !== p.key.privateKey ||
            current.key.publicKey !== p.key.publicKey ||
            h.expiresAt <= this.now()
          )
            throw new PrivateOutboxError("DENIED");
          if (entry.value.receipt) {
            if (JSON.stringify(entry.value.receipt) !== JSON.stringify(receipt))
              throw new PrivateOutboxError("CONFLICT");
            return entry;
          }
          // A late authenticated receipt is evidence even after local retries were stopped.
          entry.value.receipt = receipt;
          entry.value.state = "accepted";
          this.save(entry);
          return entry;
        })
        .immediate();
    });
  }
}
