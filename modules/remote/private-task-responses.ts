import {
  readResponseDelivery,
  saveResponseDelivery,
} from "./private-response-delivery.js";
import {
  privateRelayEnvelopeHash,
  privateRelayStorageReceiptSchema,
} from "./private-relay-contracts.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store, Owner } from "../storage/store.js";
import type { Vault } from "../storage/vault.js";
import {
  privateBindingSchema,
  type PrivateBinding,
} from "./private-peer-contracts.js";
import { PrivatePeerEnrollment } from "./private-peers.js";
import {
  privateReceiptPurpose,
  privateTaskReceiptSchema,
} from "./private-task-receipts.js";
import {
  privateAcceptedPayloadSchema,
  privateResultPayloadSchema,
} from "./private-task-contracts.js";
import {
  privateHeaderSchema,
  privateEnvelopeSchema,
  privateEnvelopeSuite,
  privateEnvelopeLimit,
  sealPrivateEnvelope,
} from "./private-envelope.js";
import { reservePrivateSequence } from "./private-send-sequence.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const kindSchema = z.enum(["accepted", "result"]);
type Kind = z.infer<typeof kindSchema>;
const permissionSchema = z.strictObject({
  binding: privateBindingSchema,
  peerId: z.uuid(),
  senderKeyEpoch: positive,
  permissionRevision: positive,
  admissionRevision: positive,
  acceptanceEnabled: z.literal(true),
  resultsEnabled: z.boolean(),
});
export type PrivateResponseAuthority = z.infer<typeof permissionSchema> & {
  senderKey: CryptoKeyPair;
};
const proofSchema = z.strictObject({
  revision: positive,
  binding: privateBindingSchema,
  peerId: z.uuid(),
  keyEpoch: positive,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
const payloadSchema = z.union([
  privateAcceptedPayloadSchema,
  privateResultPayloadSchema,
]);
const stateSchema = z
  .strictObject({
    permission: permissionSchema,
    peer: proofSchema,
    header: privateHeaderSchema,
    content: payloadSchema,
    state: z.enum(["preparing", "pending", "stopped"]),
    envelope: privateEnvelopeSchema.nullable(),
    attempts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .refine(
    (s) =>
      (s.state !== "pending" || !!s.envelope) &&
      (s.state !== "preparing" || !s.envelope) &&
      (!s.envelope || same(s.envelope.header, s.header)) &&
      s.header.operationId === s.content.receipt.header.operationId &&
      s.header.ownerId === s.content.receipt.header.ownerId &&
      s.header.senderId === s.content.receipt.header.recipientId &&
      s.header.recipientId === s.content.receipt.header.senderId &&
      s.header.senderKeyEpoch === s.content.receipt.header.recipientKeyEpoch &&
      s.header.recipientKeyEpoch === s.content.receipt.header.senderKeyEpoch,
  );
type State = z.infer<typeof stateSchema>;
type Entry = {
  id: string;
  revision: number;
  locked: boolean;
  kind: Kind;
  value: State;
  delivery?: ReturnType<typeof readResponseDelivery>;
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const purpose = (owner: Owner, id: string) =>
  JSON.stringify([
    "private-task-response:v1",
    owner.tenantId,
    owner.userId,
    id,
  ]);
export class PrivateResponseError extends Error {
  constructor(
    readonly code: "DENIED" | "CONFLICT" | "CAPACITY" | "STORAGE_UNAVAILABLE",
  ) {
    super(code);
  }
}
function read(store: Store, vault: Vault, owner: Owner, id: string): Entry {
  try {
    const row = store.db
      .prepare(
        "SELECT kind,revision,locked,payload FROM private_task_responses WHERE user_id=? AND tenant_id=? AND id=?",
      )
      .get(owner.userId, owner.tenantId, id) as
      | { kind: string; revision: number; locked: number; payload: Buffer }
      | undefined;
    if (!row) throw new PrivateResponseError("DENIED");
    if (
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      ![0, 1].includes(row.locked) ||
      row.payload.length > 262144
    )
      throw Error();
    const value = stateSchema.parse(
        vault.open(row.payload, purpose(owner, id)),
      ),
      kind = kindSchema.parse(row.kind);
    if ((kind === "accepted") !== (value.content.type === "task.accepted"))
      throw Error();
    return {
      id,
      revision: row.revision,
      locked: row.locked === 1,
      kind,
      value,
      delivery: readResponseDelivery(
        store,
        vault,
        owner,
        id,
        value.envelope,
        value.attempts,
      ),
    };
  } catch (e) {
    if (e instanceof PrivateResponseError) throw e;
    throw new PrivateResponseError("STORAGE_UNAVAILABLE");
  }
}
export function exportPrivateTaskResponses(
  store: Store,
  vault: Vault,
  owner: Owner,
) {
  const rows = store.db
    .prepare(
      "SELECT id FROM private_task_responses WHERE user_id=? AND tenant_id=? ORDER BY id LIMIT 513",
    )
    .all(owner.userId, owner.tenantId) as { id: string }[];
  if (rows.length > 512) throw new PrivateResponseError("CAPACITY");
  return rows.map((r) => read(store, vault, owner, r.id));
}
/** Internal producer. Payload/routing come only from locally authenticated admission records.
 * Trusted providers must supply separate current response consent and current endpoint keys.
 * The Mac local controller supplies scoped providers. No transport, scheduler
 * or remote acknowledgement is provided by this module.
 */
export class PrivateTaskResponses {
  private peers: PrivatePeerEnrollment;
  private inflight = 0;
  constructor(
    private store: Store,
    private vault: Vault,
    private owner: Owner,
    current: () => PrivateBinding | null,
    private authority: (peerId: string) => PrivateResponseAuthority | null,
    private now = Date.now,
  ) {
    this.owner = { ...owner };
    this.peers = new PrivatePeerEnrollment(
      store,
      vault,
      this.owner,
      current,
      now,
    );
  }
  private operationHash(operationId: string, remoteOwner: string) {
    return this.vault.fingerprint([
      "private-task:v1",
      this.owner,
      "operation",
      [remoteOwner, operationId],
    ]);
  }
  private receipt(operationId: string, remoteOwner: string) {
    const hash = this.operationHash(operationId, remoteOwner),
      row = this.store.db
        .prepare(
          "SELECT payload FROM private_task_receipts WHERE user_id=? AND tenant_id=? AND operation_hash=?",
        )
        .get(this.owner.userId, this.owner.tenantId, hash) as
        { payload: Buffer } | undefined;
    if (!row) throw new PrivateResponseError("DENIED");
    try {
      const receipt = privateTaskReceiptSchema.parse(
        this.vault.open(row.payload, privateReceiptPurpose(this.owner, hash)),
      );
      if (
        receipt.header.operationId !== operationId ||
        receipt.header.ownerId !== remoteOwner
      )
        throw Error();
      return receipt;
    } catch {
      throw new PrivateResponseError("STORAGE_UNAVAILABLE");
    }
  }
  private permission(peerId: string) {
    const supplied = this.authority(peerId);
    if (!supplied) throw new PrivateResponseError("DENIED");
    const { senderKey, ...raw } = supplied,
      value = permissionSchema.parse(raw);
    if (value.peerId !== peerId || value.binding.expiresAt <= this.now())
      throw new PrivateResponseError("DENIED");
    return {
      value,
      key: { privateKey: senderKey.privateKey, publicKey: senderKey.publicKey },
    };
  }
  private content(
    operationId: string,
    kind: Kind,
    p: z.infer<typeof permissionSchema>,
  ) {
    const receipt = this.receipt(operationId, p.binding.ownerId),
      h = receipt.header;
    if (
      h.recipientId !== p.binding.deviceId ||
      h.senderId !== p.peerId ||
      h.recipientKeyEpoch !== p.senderKeyEpoch ||
      receipt.permissionRevision !== p.admissionRevision ||
      (kind === "result" && !p.resultsEnabled)
    )
      throw new PrivateResponseError("DENIED");
    const task = this.store.get(this.owner, receipt.taskId);
    if (
      task.input.sourceRefs.length ||
      task.input.memoryIds?.length ||
      task.input.dependencies.length ||
      this.store.sourceBinding(this.owner, task.id)
    )
      throw new PrivateResponseError("DENIED");
    if (kind === "accepted")
      return privateAcceptedPayloadSchema.parse({
        version: 1,
        type: "task.accepted",
        receipt,
      });
    const output =
      task.status === "completed"
        ? z
            .strictObject({
              text: z.string(),
              kind: z.literal("unreviewed_draft"),
              memories: z.array(z.never()).max(0),
              model: z.unknown(),
            })
            .parse(task.result).text
        : null;
    const content = privateResultPayloadSchema.parse({
      version: 1,
      type: "task.result",
      receipt,
      task: {
        id: task.id,
        revision: task.revision,
        status: task.status,
        updatedAt: task.updatedAt,
        output,
      },
    });
    if (
      content.task.updatedAt < receipt.acceptedAt ||
      content.task.updatedAt > this.now() + 30000
    )
      throw new PrivateResponseError("DENIED");
    return content;
  }
  private check(e: Entry) {
    const p = this.permission(e.value.permission.peerId);
    if (
      e.locked ||
      !same(p.value, e.value.permission) ||
      !this.peers.validate(e.value.peer) ||
      !same(
        this.content(e.value.header.operationId, e.kind, p.value),
        e.value.content,
      )
    )
      throw new PrivateResponseError("DENIED");
    return p;
  }
  get(id: string) {
    return read(this.store, this.vault, this.owner, z.uuid().parse(id));
  }
  private save(e: Entry) {
    if (e.revision >= Number.MAX_SAFE_INTEGER)
      throw new PrivateResponseError("CAPACITY");
    stateSchema.parse(e.value);
    const payload = this.vault.seal(e.value, purpose(this.owner, e.id));
    if (payload.length > 262144) throw new PrivateResponseError("CAPACITY");
    const result = this.store.db
      .prepare(
        "UPDATE private_task_responses SET revision=revision+1,payload=? WHERE user_id=? AND tenant_id=? AND id=? AND revision=?",
      )
      .run(payload, this.owner.userId, this.owner.tenantId, e.id, e.revision);
    if (result.changes !== 1) throw new PrivateResponseError("CONFLICT");
    e.revision++;
  }
  private async bounded<T>(fn: () => Promise<T>) {
    if (this.inflight >= 4) throw new PrivateResponseError("CAPACITY");
    this.inflight++;
    try {
      return await fn();
    } catch (e) {
      if (e instanceof PrivateResponseError) throw e;
      throw new PrivateResponseError("DENIED");
    } finally {
      this.inflight--;
    }
  }
  prepare(raw: unknown, deliveryLimit = Number.MAX_SAFE_INTEGER) {
    return this.bounded(async () => {
      if (!Number.isSafeInteger(deliveryLimit) || deliveryLimit <= this.now())
        throw new PrivateResponseError("DENIED");
      const input = z
          .strictObject({
            operationId: z.uuid(),
            peerId: z.uuid(),
            kind: kindSchema,
            confirmed: z.literal(true),
          })
          .parse(raw),
        p = this.permission(input.peerId),
        content = this.content(input.operationId, input.kind, p.value),
        original = content.receipt.header,
        pin = await this.peers.resolve(input.peerId, original.senderKeyEpoch);
      if (!same(pin.proof.binding, p.value.binding))
        throw new PrivateResponseError("DENIED");
      if (
        new TextEncoder().encode(JSON.stringify(content)).byteLength >
        privateEnvelopeLimit
      )
        throw new PrivateResponseError("CAPACITY");
      const operationHash = this.operationHash(
        input.operationId,
        p.value.binding.ownerId,
      );
      const entry = this.store.db
        .transaction(() => {
          const current = this.permission(input.peerId);
          if (
            deliveryLimit <= this.now() ||
            !same(current.value, p.value) ||
            current.key.privateKey !== p.key.privateKey ||
            current.key.publicKey !== p.key.publicKey ||
            !this.peers.validate(pin.proof) ||
            !same(
              this.content(input.operationId, input.kind, current.value),
              content,
            )
          )
            throw new PrivateResponseError("DENIED");
          const previous = this.store.db
            .prepare(
              "SELECT id FROM private_task_responses WHERE user_id=? AND tenant_id=? AND operation_hash=? AND kind=?",
            )
            .get(
              this.owner.userId,
              this.owner.tenantId,
              operationHash,
              input.kind,
            ) as { id: string } | undefined;
          if (previous) {
            const entry = this.get(previous.id);
            this.check(entry);
            if (entry.value.header.expiresAt > deliveryLimit)
              throw new PrivateResponseError("DENIED");
            return entry;
          }
          const count = this.store.db
            .prepare(
              "SELECT COUNT(*) AS count FROM private_task_responses WHERE user_id=? AND tenant_id=?",
            )
            .get(this.owner.userId, this.owner.tenantId) as { count: number };
          if (count.count >= 512) throw new PrivateResponseError("CAPACITY");
          const b = current.value.binding,
            issuedAt = this.now(),
            route = {
              ownerId: b.ownerId,
              senderId: b.deviceId,
              recipientId: input.peerId,
              senderKeyEpoch: current.value.senderKeyEpoch,
              recipientKeyEpoch: original.senderKeyEpoch,
            };
          let sequence: number;
          try {
            sequence = reservePrivateSequence(
              this.store,
              this.vault,
              this.owner,
              route,
            );
          } catch {
            throw new PrivateResponseError("CAPACITY");
          }
          const header = privateHeaderSchema.parse({
            version: 1,
            suite: privateEnvelopeSuite,
            ...route,
            messageId: randomUUID(),
            operationId: input.operationId,
            sequence,
            issuedAt,
            expiresAt: Math.min(
              issuedAt + 86400000,
              b.expiresAt,
              deliveryLimit,
            ),
          });
          if (header.expiresAt <= issuedAt)
            throw new PrivateResponseError("DENIED");
          const id = randomUUID(),
            value = stateSchema.parse({
              permission: current.value,
              peer: pin.proof,
              header,
              content,
              state: "preparing",
              envelope: null,
              attempts: 0,
            }),
            payload = this.vault.seal(value, purpose(this.owner, id));
          if (payload.length > 262144)
            throw new PrivateResponseError("CAPACITY");
          this.store.db
            .prepare(
              "INSERT INTO private_task_responses VALUES(?,?,?,?,?,1,0,?)",
            )
            .run(
              this.owner.userId,
              this.owner.tenantId,
              id,
              operationHash,
              input.kind,
              payload,
            );
          return { id, revision: 1, locked: false, kind: input.kind, value };
        })
        .immediate();
      return this.publish(entry.id);
    });
  }
  resume(id: string) {
    return this.bounded(() => this.publish(z.uuid().parse(id)));
  }
  private async publish(id: string) {
    const before = this.get(id),
      p = this.check(before);
    if (before.value.state !== "preparing") return before;
    if (before.value.header.expiresAt <= this.now())
      throw new PrivateResponseError("DENIED");
    const pin = await this.peers.resolve(
      before.value.peer.peerId,
      before.value.peer.keyEpoch,
    );
    if (!same(pin.proof, before.value.peer))
      throw new PrivateResponseError("CONFLICT");
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
          throw new PrivateResponseError("DENIED");
        if (entry.value.state !== "preparing") return entry;
        if (entry.revision !== before.revision)
          throw new PrivateResponseError("CONFLICT");
        entry.value.envelope = envelope;
        entry.value.state = "pending";
        this.save(entry);
        return entry;
      })
      .immediate();
  }
  delivery(
    id: string,
    expectedRevision?: number,
    deliveryLimit = Number.MAX_SAFE_INTEGER,
  ) {
    try {
      if (!Number.isSafeInteger(deliveryLimit) || deliveryLimit <= this.now())
        throw new PrivateResponseError("DENIED");
      if (expectedRevision !== undefined) positive.parse(expectedRevision);
      return this.store.db
        .transaction(() => {
          const entry = this.get(id);
          if (
            expectedRevision !== undefined &&
            entry.revision !== expectedRevision
          )
            throw new PrivateResponseError("CONFLICT");
          this.check(entry);
          if (
            entry.value.header.expiresAt > deliveryLimit ||
            entry.value.state !== "pending" ||
            !entry.value.envelope ||
            entry.value.header.expiresAt <= this.now()
          )
            throw new PrivateResponseError("DENIED");
          if (entry.value.attempts >= Number.MAX_SAFE_INTEGER)
            throw new PrivateResponseError("CAPACITY");
          entry.value.attempts++;
          this.save(entry);
          return structuredClone(entry.value.envelope);
        })
        .immediate();
    } catch (e) {
      if (e instanceof PrivateResponseError) throw e;
      throw new PrivateResponseError("DENIED");
    }
  }
  async recordDelivery(
    id: string,
    expectedRevision: number,
    envelope: unknown,
    rawReceipt: unknown,
  ) {
    try {
      const wire = privateEnvelopeSchema.parse(envelope),
        receipt = privateRelayStorageReceiptSchema.parse(rawReceipt);
      if (
        receipt.messageId !== wire.header.messageId ||
        receipt.envelopeHash !== (await privateRelayEnvelopeHash(wire)) ||
        receipt.storedAt < wire.header.issuedAt - 30000 ||
        receipt.storedAt > this.now() + 30000
      )
        throw new PrivateResponseError("DENIED");
      return this.store.db
        .transaction(() => {
          const entry = this.get(id);
          if (entry.revision !== expectedRevision)
            throw new PrivateResponseError("CONFLICT");
          if (
            entry.locked ||
            entry.value.state !== "pending" ||
            !same(entry.value.envelope, wire) ||
            entry.value.attempts < 1
          )
            throw new PrivateResponseError("DENIED");
          saveResponseDelivery(
            this.store,
            this.vault,
            this.owner,
            id,
            wire,
            entry.value.attempts,
            receipt,
            this.now(),
          );
        })
        .immediate();
    } catch (error) {
      if (error instanceof PrivateResponseError) throw error;
      throw new PrivateResponseError("STORAGE_UNAVAILABLE");
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
          throw new PrivateResponseError("CONFLICT");
        entry.value.state = "stopped";
        this.save(entry);
        return entry;
      })
      .immediate();
  }
}
