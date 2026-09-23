import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store, Owner } from "../storage/store.js";
import type { Vault } from "../storage/vault.js";
import {
  PrivateKeyLifecycle,
  type PrivateKeyProof,
} from "./private-key-lifecycle.js";
import {
  PrivatePeerEnrollment,
  type PrivatePeerProof,
} from "./private-peers.js";
import {
  privateBindingSchema,
  type PrivateBinding,
} from "./private-peer-contracts.js";
import {
  privateEnvelopeSchema,
  privateHeaderSchema,
  privateEnvelopeSuite,
  sealPrivateEnvelope,
  openPrivateEnvelope,
  type PrivateEnvelope,
} from "./private-envelope.js";
import { reservePrivateSequence } from "./private-send-sequence.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  hex = z.string().regex(/^[a-f0-9]{64}$/);
export const peerChallengeSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("peer.key.challenge"),
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export const peerResponseSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("peer.key.response"),
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  requestHash: hex,
});
const localSchema = z.strictObject({
  revision: positive,
  keyId: z.uuid(),
  keyEpoch: positive,
  binding: privateBindingSchema,
  publicKey: z.string().length(87),
});
const peerSchema = z.strictObject({
  revision: positive,
  binding: privateBindingSchema,
  peerId: z.uuid(),
  keyEpoch: positive,
  fingerprint: hex,
});
const valueSchema = z
  .strictObject({
    local: localSchema,
    peer: peerSchema,
    header: privateHeaderSchema,
    state: z.enum(["preparing", "pending", "verified", "stopped"]),
    content: z.union([peerChallengeSchema, peerResponseSchema]),
    envelope: privateEnvelopeSchema.nullable(),
    requestHash: hex.nullable(),
    responseHash: hex.nullable(),
    verifiedAt: positive.nullable(),
  })
  .refine(
    (v) =>
      (v.state !== "preparing" || v.envelope === null) &&
      (v.state !== "pending" || v.envelope !== null) &&
      (v.state !== "verified" ||
        (v.content.type === "peer.key.challenge" &&
          !!v.envelope &&
          !!v.responseHash &&
          !!v.verifiedAt)) &&
      (!v.envelope || same(v.envelope.header, v.header)),
  );
type Value = z.infer<typeof valueSchema>;
type Entry = {
  id: string;
  role: "challenge" | "response";
  revision: number;
  locked: boolean;
  value: Value;
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export const peerEnvelopeHash = (envelope: PrivateEnvelope) =>
  createHash("sha256")
    .update(JSON.stringify(privateEnvelopeSchema.parse(envelope)))
    .digest("hex");
const purpose = (owner: Owner, id: string) =>
  JSON.stringify(["private-peer-check:v1", owner.tenantId, owner.userId, id]);
export class PrivatePeerCheckError extends Error {
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
        "SELECT role,revision,locked,payload FROM private_peer_checks WHERE user_id=? AND tenant_id=? AND id=?",
      )
      .get(owner.userId, owner.tenantId, id) as
      | { role: string; revision: number; locked: number; payload: Buffer }
      | undefined;
    if (!row) throw new PrivatePeerCheckError("DENIED");
    if (
      !positive.safeParse(row.revision).success ||
      ![0, 1].includes(row.locked) ||
      row.payload.length > 16384
    )
      throw Error();
    const value = valueSchema.parse(
        vault.open(row.payload, purpose(owner, id)),
      ),
      role = z.enum(["challenge", "response"]).parse(row.role);
    if (
      (role === "challenge") !==
      (value.content.type === "peer.key.challenge")
    )
      throw Error();
    if (
      value.header.senderId !== value.local.binding.deviceId ||
      value.header.ownerId !== value.local.binding.ownerId ||
      value.header.recipientId !== value.peer.peerId ||
      value.header.senderKeyEpoch !== value.local.keyEpoch ||
      value.header.recipientKeyEpoch !== value.peer.keyEpoch ||
      !same(value.local.binding, value.peer.binding)
    )
      throw Error();
    return {
      id,
      role,
      revision: row.revision,
      locked: row.locked === 1,
      value,
    };
  } catch (e) {
    if (e instanceof PrivatePeerCheckError) throw e;
    throw new PrivatePeerCheckError("STORAGE_UNAVAILABLE");
  }
}
export function exportPrivatePeerChecks(
  store: Store,
  vault: Vault,
  owner: Owner,
) {
  const rows = store.db
    .prepare(
      "SELECT id FROM private_peer_checks WHERE user_id=? AND tenant_id=? ORDER BY id LIMIT 257",
    )
    .all(owner.userId, owner.tenantId) as { id: string }[];
  if (rows.length > 256) throw new PrivatePeerCheckError("CAPACITY");
  return rows.map((r) => read(store, vault, owner, r.id));
}
export function peerCheckSummary(e: Entry) {
  return {
    id: e.id,
    role: e.role,
    revision: e.revision,
    locked: e.locked,
    state: e.value.state,
    peerId: e.value.peer.peerId,
    expiresAt: e.value.header.expiresAt,
    verifiedAt: e.value.verifiedAt,
  };
}
/** Each endpoint independently challenges its reviewed peer. Responding never
 * marks that responder's peer verified and never grants task permission.
 */
export class PrivatePeerChecks {
  private inflight = 0;
  constructor(
    private store: Store,
    private vault: Vault,
    private owner: Owner,
    private current: () => PrivateBinding | null,
    private keys: PrivateKeyLifecycle,
    private peers: PrivatePeerEnrollment,
    private now = Date.now,
  ) {
    this.owner = { ...owner };
  }
  list() {
    return exportPrivatePeerChecks(this.store, this.vault, this.owner);
  }
  validFor(local: PrivateKeyProof, peer: PrivatePeerProof) {
    try {
      return (
        this.keys.validate(local) &&
        this.peers.validate(peer) &&
        this.list().some(
          (e) =>
            !e.locked &&
            e.role === "challenge" &&
            e.value.state === "verified" &&
            e.value.verifiedAt! <= this.now() &&
            same(e.value.local, local) &&
            same(e.value.peer, peer),
        )
      );
    } catch {
      return false;
    }
  }
  private validate(e: Entry, unexpired = true) {
    if (
      e.locked ||
      !this.keys.validate(e.value.local) ||
      !this.peers.validate(e.value.peer) ||
      !same(this.current(), e.value.local.binding) ||
      (unexpired &&
        (this.now() >= e.value.header.expiresAt ||
          this.now() < e.value.header.issuedAt))
    )
      throw new PrivatePeerCheckError("DENIED");
  }
  private async resolve(peerId: string) {
    const local = await this.keys.resolve(),
      peer = await this.peers.resolve(
        peerId,
        this.peers.list().peers.find((p) => p.peerId === peerId)?.keyEpoch ?? 0,
      );
    if (
      !this.keys.validate(local.proof) ||
      !this.peers.validate(peer.proof) ||
      !same(local.proof.binding, peer.proof.binding)
    )
      throw new PrivatePeerCheckError("DENIED");
    return { local, peer };
  }
  private hash(operation: string, sender: string) {
    return this.vault.fingerprint([
      "peer-check-operation:v1",
      this.owner,
      sender,
      operation,
    ]);
  }
  private save(e: Entry) {
    if (e.revision >= Number.MAX_SAFE_INTEGER)
      throw new PrivatePeerCheckError("CAPACITY");
    const payload = this.vault.seal(
      valueSchema.parse(e.value),
      purpose(this.owner, e.id),
    );
    if (payload.length > 16384) throw new PrivatePeerCheckError("CAPACITY");
    const result = this.store.db
      .prepare(
        "UPDATE private_peer_checks SET revision=revision+1,payload=? WHERE user_id=? AND tenant_id=? AND id=? AND revision=?",
      )
      .run(payload, this.owner.userId, this.owner.tenantId, e.id, e.revision);
    if (result.changes !== 1) throw new PrivatePeerCheckError("CONFLICT");
    e.revision++;
  }
  private reserve(
    role: Entry["role"],
    proofs: Awaited<ReturnType<PrivatePeerChecks["resolve"]>>,
    operationId: string,
    content: Value["content"],
    requestHash: string | null,
    deadline: number,
  ) {
    const local = proofs.local.proof,
      peer = proofs.peer.proof,
      issuedAt = this.now(),
      id = role === "challenge" ? operationId : randomUUID();
    const existing = this.store.db
      .prepare(
        "SELECT id FROM private_peer_checks WHERE user_id=? AND tenant_id=? AND role=? AND operation_hash=?",
      )
      .get(
        this.owner.userId,
        this.owner.tenantId,
        role,
        this.hash(
          operationId,
          role === "challenge" ? local.binding.deviceId : peer.peerId,
        ),
      ) as { id: string } | undefined;
    if (existing) {
      const e = read(this.store, this.vault, this.owner, existing.id);
      this.validate(e);
      if (
        !same(e.value.content, content) ||
        e.value.requestHash !== requestHash ||
        !same(e.value.local, local) ||
        !same(e.value.peer, peer)
      )
        throw new PrivatePeerCheckError("CONFLICT");
      return e;
    }
    if (this.list().length >= 256) throw new PrivatePeerCheckError("CAPACITY");
    const route = {
      ownerId: local.binding.ownerId,
      senderId: local.binding.deviceId,
      recipientId: peer.peerId,
      senderKeyEpoch: local.keyEpoch,
      recipientKeyEpoch: peer.keyEpoch,
    };
    const sequence = reservePrivateSequence(
        this.store,
        this.vault,
        this.owner,
        route,
      ),
      header = privateHeaderSchema.parse({
        version: 1,
        suite: privateEnvelopeSuite,
        ...route,
        messageId: randomUUID(),
        operationId,
        sequence,
        issuedAt,
        expiresAt: Math.min(
          deadline,
          issuedAt + 300000,
          local.binding.expiresAt,
        ),
      });
    const e: Entry = {
      id,
      role,
      revision: 1,
      locked: false,
      value: {
        local,
        peer,
        header,
        content,
        requestHash,
        state: "preparing",
        envelope: null,
        responseHash: null,
        verifiedAt: null,
      },
    };
    this.validate(e);
    const payload = this.vault.seal(
      valueSchema.parse(e.value),
      purpose(this.owner, id),
    );
    if (payload.length > 16384) throw new PrivatePeerCheckError("CAPACITY");
    this.store.db
      .prepare("INSERT INTO private_peer_checks VALUES(?,?,?,?,?,1,0,?)")
      .run(
        this.owner.userId,
        this.owner.tenantId,
        id,
        role,
        this.hash(
          operationId,
          role === "challenge" ? local.binding.deviceId : peer.peerId,
        ),
        payload,
      );
    return e;
  }
  private async bounded<T>(work: () => Promise<T>) {
    if (this.inflight >= 4) throw new PrivatePeerCheckError("CAPACITY");
    this.inflight++;
    try {
      return await work();
    } catch (e) {
      if (e instanceof PrivatePeerCheckError) throw e;
      throw new PrivatePeerCheckError("DENIED");
    } finally {
      this.inflight--;
    }
  }
  begin(raw: unknown) {
    return this.bounded(async () => {
      const input = z
          .strictObject({
            peerId: z.uuid(),
            expectedKeyRevision: z.number().int().nonnegative(),
            expectedPeerRevision: z.number().int().nonnegative(),
            confirmed: z.literal(true),
          })
          .parse(raw),
        p = await this.resolve(input.peerId);
      const e = this.store.db
        .transaction(() => {
          if (
            p.local.proof.revision !== input.expectedKeyRevision ||
            p.peer.proof.revision !== input.expectedPeerRevision
          )
            throw new PrivatePeerCheckError("CONFLICT");
          return this.reserve(
            "challenge",
            p,
            randomUUID(),
            {
              version: 1,
              type: "peer.key.challenge",
              challenge: randomBytes(32).toString("base64url"),
            },
            null,
            this.now() + 300000,
          );
        })
        .immediate();
      return this.publish(e.id);
    });
  }
  private async incoming(raw: unknown) {
    const envelope = privateEnvelopeSchema.parse(raw),
      h = envelope.header,
      p = await this.resolve(h.senderId);
    if (
      h.ownerId !== p.local.proof.binding.ownerId ||
      h.recipientId !== p.local.proof.binding.deviceId ||
      h.recipientKeyEpoch !== p.local.proof.keyEpoch ||
      h.senderKeyEpoch !== p.peer.proof.keyEpoch ||
      h.expiresAt - h.issuedAt > 300000
    )
      throw new PrivatePeerCheckError("DENIED");
    const opened = await openPrivateEnvelope(
      envelope,
      h,
      { recipientKey: p.local.pair, senderPublicKey: p.peer.publicKey },
      this.now,
    );
    let content: unknown;
    try {
      content = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(opened.plaintext),
      );
    } finally {
      opened.plaintext.fill(0);
    }
    return { envelope, content, p };
  }
  respond(raw: unknown) {
    return this.bounded(async () => {
      const input = z
          .strictObject({
            envelope: privateEnvelopeSchema,
            confirmed: z.literal(true),
          })
          .parse(raw),
        { envelope, content, p } = await this.incoming(input.envelope),
        challenge = peerChallengeSchema.parse(content),
        hash = peerEnvelopeHash(envelope);
      const e = this.store.db
        .transaction(() => {
          if (envelope.header.expiresAt <= this.now())
            throw new PrivatePeerCheckError("DENIED");
          return this.reserve(
            "response",
            p,
            envelope.header.operationId,
            {
              version: 1,
              type: "peer.key.response",
              challenge: challenge.challenge,
              requestHash: hash,
            },
            hash,
            envelope.header.expiresAt,
          );
        })
        .immediate();
      return this.publish(e.id);
    });
  }
  resume(raw: unknown) {
    return this.bounded(async () => {
      const input = z
        .strictObject({ id: z.uuid(), confirmed: z.literal(true) })
        .parse(raw);
      return this.publish(input.id);
    });
  }
  private async publish(id: string) {
    const before = read(this.store, this.vault, this.owner, id);
    this.validate(before);
    if (before.value.state !== "preparing") return peerCheckSummary(before);
    const p = await this.resolve(before.value.peer.peerId);
    if (
      !same(p.local.proof, before.value.local) ||
      !same(p.peer.proof, before.value.peer)
    )
      throw new PrivatePeerCheckError("CONFLICT");
    const bytes = new TextEncoder().encode(
      JSON.stringify(before.value.content),
    );
    let envelope;
    try {
      envelope = await sealPrivateEnvelope(
        before.value.header,
        bytes,
        { senderKey: p.local.pair, recipientPublicKey: p.peer.publicKey },
        this.now,
      );
    } finally {
      bytes.fill(0);
    }
    return this.store.db
      .transaction(() => {
        const e = read(this.store, this.vault, this.owner, id);
        this.validate(e);
        if (e.revision !== before.revision)
          throw new PrivatePeerCheckError("CONFLICT");
        e.value.envelope = envelope;
        e.value.state = "pending";
        this.save(e);
        return peerCheckSummary(e);
      })
      .immediate();
  }
  delivery(raw: unknown) {
    const input = z
      .strictObject({ id: z.uuid(), confirmed: z.literal(true) })
      .parse(raw);
    return this.store.db
      .transaction(() => {
        const e = read(this.store, this.vault, this.owner, input.id);
        this.validate(e);
        if (e.value.state !== "pending" || !e.value.envelope)
          throw new PrivatePeerCheckError("DENIED");
        return structuredClone(e.value.envelope);
      })
      .immediate();
  }
  complete(raw: unknown) {
    return this.bounded(async () => {
      const input = z
          .strictObject({
            envelope: privateEnvelopeSchema,
            confirmed: z.literal(true),
          })
          .parse(raw),
        { envelope, content } = await this.incoming(input.envelope),
        response = peerResponseSchema.parse(content);
      return this.store.db
        .transaction(() => {
          const e = read(
            this.store,
            this.vault,
            this.owner,
            envelope.header.operationId,
          );
          this.validate(e);
          if (
            e.role !== "challenge" ||
            !["pending", "verified"].includes(e.value.state) ||
            !e.value.envelope ||
            e.value.content.type !== "peer.key.challenge" ||
            e.value.peer.peerId !== envelope.header.senderId ||
            e.value.header.operationId !== envelope.header.operationId ||
            envelope.header.expiresAt > e.value.header.expiresAt ||
            envelope.header.expiresAt <= this.now() ||
            response.challenge !== e.value.content.challenge ||
            response.requestHash !== peerEnvelopeHash(e.value.envelope)
          )
            throw new PrivatePeerCheckError("DENIED");
          const hash = peerEnvelopeHash(envelope);
          if (e.value.responseHash && e.value.responseHash !== hash)
            throw new PrivatePeerCheckError("CONFLICT");
          if (e.value.state !== "verified") {
            e.value.state = "verified";
            e.value.responseHash = hash;
            e.value.verifiedAt = this.now();
            this.save(e);
          }
          return peerCheckSummary(e);
        })
        .immediate();
    });
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
        const e = read(this.store, this.vault, this.owner, input.id);
        if (e.revision !== input.expectedRevision)
          throw new PrivatePeerCheckError("CONFLICT");
        if (e.value.state === "verified")
          throw new PrivatePeerCheckError("DENIED");
        e.value.state = "stopped";
        this.save(e);
        return peerCheckSummary(e);
      })
      .immediate();
  }
}
