import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Owner, Store } from "../storage/store.js";
import type { Vault } from "../storage/vault.js";
import {
  PrivateConversationConsent,
  privateConversationGrantSchema,
} from "./private-conversation-consent.js";
import { conversationOfferSchema } from "./private-conversation-contracts.js";
import {
  privateEnvelopeSchema,
  privateHeaderSchema,
  privateEnvelopeSuite,
  sealPrivateEnvelope,
} from "./private-envelope.js";
import { reservePrivateSequence } from "./private-send-sequence.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const valueSchema = z
  .strictObject({
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    grant: privateConversationGrantSchema,
    offer: conversationOfferSchema,
    header: privateHeaderSchema,
    state: z.enum(["preparing", "ready", "stopped"]),
    envelope: privateEnvelopeSchema.nullable(),
  })
  .refine(
    (v) =>
      v.offer.scope.permissionId === v.grant.id &&
      v.offer.scope.conversationRef === v.grant.conversationRef &&
      same(v.offer.permissions, v.grant.choices.permissions) &&
      v.offer.expiresAt === v.grant.choices.expiresAt &&
      v.header.ownerId === v.grant.local.binding.ownerId &&
      v.header.senderId === v.grant.local.binding.deviceId &&
      v.header.senderKeyEpoch === v.grant.local.keyEpoch &&
      v.header.recipientId === v.grant.choices.peerId &&
      v.header.recipientKeyEpoch === v.grant.choices.peerKeyEpoch &&
      v.header.issuedAt === v.offer.issuedAt &&
      v.header.expiresAt <= v.offer.expiresAt &&
      v.header.expiresAt > v.header.issuedAt &&
      (v.state !== "ready" || !!v.envelope) &&
      (v.state !== "preparing" || !v.envelope) &&
      (!v.envelope || same(v.envelope.header, v.header)),
  );
type Entry = {
  id: string;
  revision: number;
  locked: boolean;
  value: z.infer<typeof valueSchema>;
};
type Handle = Awaited<ReturnType<PrivateConversationConsent["resolve"]>>;
export class ConversationOfferError extends Error {
  constructor(
    readonly code: "DENIED" | "CONFLICT" | "CAPACITY" | "STORAGE_UNAVAILABLE",
  ) {
    super(code);
  }
}
const purpose = (owner: Owner, id: string) =>
  JSON.stringify([
    "private-conversation-offer:v1",
    owner.tenantId,
    owner.userId,
    id,
  ]);
function read(store: Store, vault: Vault, owner: Owner, id: string): Entry {
  try {
    const r = store.db
      .prepare(
        "SELECT revision,locked,payload FROM private_conversation_offers WHERE user_id=? AND tenant_id=? AND id=?",
      )
      .get(owner.userId, owner.tenantId, id) as
      { revision: number; locked: number; payload: Buffer } | undefined;
    if (!r) throw new ConversationOfferError("DENIED");
    if (
      !positive.safeParse(r.revision).success ||
      ![0, 1].includes(r.locked) ||
      r.payload.length > 16384
    )
      throw Error();
    const value = valueSchema.parse(vault.open(r.payload, purpose(owner, id)));
    if (value.header.operationId !== id) throw Error();
    return { id, revision: r.revision, locked: r.locked === 1, value };
  } catch (e) {
    if (e instanceof ConversationOfferError) throw e;
    throw new ConversationOfferError("STORAGE_UNAVAILABLE");
  }
}
export function exportPrivateConversationOffers(
  store: Store,
  vault: Vault,
  owner: Owner,
) {
  const rows = store.db
    .prepare(
      "SELECT id FROM private_conversation_offers WHERE user_id=? AND tenant_id=? ORDER BY id LIMIT 257",
    )
    .all(owner.userId, owner.tenantId) as { id: string }[];
  if (rows.length > 256) throw new ConversationOfferError("CAPACITY");
  return rows.map((r) => read(store, vault, owner, r.id));
}
/** Internal preparation only: no network, polling, UI authority or implicit send.
 * All retained offers require current Mac consent again before encryption/reveal. */
export class PrivateConversationOffers {
  private inflight = 0;
  constructor(
    private store: Store,
    private vault: Vault,
    private owner: Owner,
    private consent: PrivateConversationConsent,
    private now = Date.now,
  ) {
    this.owner = { ...owner };
  }
  private input<T>(schema: z.ZodType<T>, raw: unknown): T {
    const p = schema.safeParse(raw);
    if (!p.success) throw new ConversationOfferError("DENIED");
    return p.data;
  }
  private hash(kind: string, raw: unknown) {
    return this.vault.fingerprint([
      "private-conversation-offer:v1",
      this.owner,
      kind,
      raw,
    ]);
  }
  private async bounded<T>(fn: () => Promise<T>) {
    if (this.inflight >= 4) throw new ConversationOfferError("CAPACITY");
    this.inflight++;
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ConversationOfferError) throw e;
      throw new ConversationOfferError("DENIED");
    } finally {
      this.inflight--;
    }
  }
  private checked(e: Entry, h: Handle) {
    const p = h.offerAccess();
    if (
      !p ||
      e.locked ||
      e.value.state === "stopped" ||
      !same(e.value.grant, p.grant) ||
      e.value.header.issuedAt > this.now() ||
      e.value.header.expiresAt <= this.now()
    )
      throw new ConversationOfferError("DENIED");
    return p;
  }
  private sealed(e: Entry) {
    const payload = this.vault.seal(
      valueSchema.parse(e.value),
      purpose(this.owner, e.id),
    );
    if (payload.length > 16384) throw new ConversationOfferError("CAPACITY");
    return payload;
  }
  private save(e: Entry) {
    if (e.revision >= Number.MAX_SAFE_INTEGER)
      throw new ConversationOfferError("CAPACITY");
    const updated = this.store.db
      .prepare(
        "UPDATE private_conversation_offers SET revision=revision+1,payload=? WHERE user_id=? AND tenant_id=? AND id=? AND revision=?",
      )
      .run(
        this.sealed(e),
        this.owner.userId,
        this.owner.tenantId,
        e.id,
        e.revision,
      );
    if (updated.changes !== 1) throw new ConversationOfferError("CONFLICT");
    e.revision++;
  }
  get(raw: unknown) {
    return read(this.store, this.vault, this.owner, this.input(z.uuid(), raw));
  }
  prepare(raw: unknown) {
    return this.bounded(async () => {
      const input = this.input(
          z.strictObject({
            clientRequestId: z.uuid(),
            permissionId: z.uuid(),
            expectedConsentRevision: positive,
            confirmed: z.literal(true),
          }),
          raw,
        ),
        handle = await this.consent.resolve(input.permissionId),
        clientHash = this.hash("client", input.clientRequestId),
        requestHash = this.hash("request", input);
      return this.store.db
        .transaction(() => {
          const p = handle.offerAccess();
          if (!p) throw new ConversationOfferError("DENIED");
          const existing = this.store.db
            .prepare(
              "SELECT id FROM private_conversation_offers WHERE user_id=? AND tenant_id=? AND client_hash=?",
            )
            .get(this.owner.userId, this.owner.tenantId, clientHash) as
            { id: string } | undefined;
          if (existing) {
            const e = this.get(existing.id);
            this.checked(e, handle);
            if (e.value.requestHash !== requestHash)
              throw new ConversationOfferError("CONFLICT");
            return e;
          }
          if (this.consent.list().revision !== input.expectedConsentRevision)
            throw new ConversationOfferError("CONFLICT");
          const count = this.store.db
            .prepare(
              "SELECT COUNT(*) AS count FROM private_conversation_offers WHERE user_id=? AND tenant_id=?",
            )
            .get(this.owner.userId, this.owner.tenantId) as { count: number };
          if (count.count >= 256) throw new ConversationOfferError("CAPACITY");
          const id = randomUUID(),
            issuedAt = this.now(),
            grant = p.grant,
            offer = conversationOfferSchema.parse({
              version: 1,
              type: "conversation.offer",
              scope: {
                conversationRef: grant.conversationRef,
                permissionId: grant.id,
              },
              permissions: grant.choices.permissions,
              issuedAt,
              expiresAt: grant.choices.expiresAt,
            }),
            route = {
              ownerId: grant.local.binding.ownerId,
              senderId: grant.local.binding.deviceId,
              recipientId: grant.choices.peerId,
              senderKeyEpoch: grant.local.keyEpoch,
              recipientKeyEpoch: grant.choices.peerKeyEpoch,
            },
            sequence = reservePrivateSequence(
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
              operationId: id,
              sequence,
              issuedAt,
              expiresAt: Math.min(issuedAt + 300000, offer.expiresAt),
            }),
            e: Entry = {
              id,
              revision: 1,
              locked: false,
              value: {
                requestHash,
                grant,
                offer,
                header,
                state: "preparing",
                envelope: null,
              },
            };
          this.checked(e, handle);
          this.store.db
            .prepare(
              "INSERT INTO private_conversation_offers(user_id,tenant_id,id,client_hash,revision,locked,payload) VALUES(?,?,?,?,1,0,?)",
            )
            .run(
              this.owner.userId,
              this.owner.tenantId,
              id,
              clientHash,
              this.sealed(e),
            );
          return structuredClone(e);
        })
        .immediate();
    });
  }
  resume(raw: unknown) {
    return this.bounded(async () => {
      const input = this.input(
          z.strictObject({
            id: z.uuid(),
            expectedRevision: positive,
            confirmed: z.literal(true),
          }),
          raw,
        ),
        original = this.get(input.id),
        handle = await this.consent.resolve(original.value.grant.id),
        p = this.checked(original, handle);
      if (original.revision !== input.expectedRevision)
        throw new ConversationOfferError("CONFLICT");
      if (original.value.state === "ready") return original;
      const bytes = new TextEncoder().encode(
        JSON.stringify(original.value.offer),
      );
      try {
        const envelope = await sealPrivateEnvelope(
          original.value.header,
          bytes,
          { senderKey: p.localKey, recipientPublicKey: p.peerPublicKey },
          this.now,
        );
        return this.store.db
          .transaction(() => {
            const current = this.get(input.id);
            this.checked(current, handle);
            if (
              !same(current.value.header, original.value.header) ||
              !same(current.value.offer, original.value.offer)
            )
              throw new ConversationOfferError("CONFLICT");
            // A concurrent encryptor may have won. Publish only its original ciphertext.
            if (current.value.state === "ready") return current;
            if (current.revision !== original.revision)
              throw new ConversationOfferError("CONFLICT");
            current.value.envelope = envelope;
            current.value.state = "ready";
            this.save(current);
            return current;
          })
          .immediate();
      } finally {
        bytes.fill(0);
      }
    });
  }
  delivery(raw: unknown) {
    return this.bounded(async () => {
      const input = this.input(
          z.strictObject({
            id: z.uuid(),
            expectedRevision: positive,
            confirmed: z.literal(true),
          }),
          raw,
        ),
        e = this.get(input.id),
        handle = await this.consent.resolve(e.value.grant.id);
      return this.store.db
        .transaction(() => {
          const current = this.get(input.id);
          this.checked(current, handle);
          if (current.revision !== input.expectedRevision)
            throw new ConversationOfferError("CONFLICT");
          if (current.value.state !== "ready" || !current.value.envelope)
            throw new ConversationOfferError("DENIED");
          return structuredClone(current.value.envelope);
        })
        .immediate();
    });
  }
  stop(raw: unknown) {
    const input = this.input(
      z.strictObject({
        id: z.uuid(),
        expectedRevision: positive,
        confirmed: z.literal(true),
      }),
      raw,
    );
    return this.store.db
      .transaction(() => {
        const e = this.get(input.id);
        if (e.revision !== input.expectedRevision)
          throw new ConversationOfferError("CONFLICT");
        if (e.value.state !== "stopped") {
          e.value.state = "stopped";
          this.save(e);
        }
        return e;
      })
      .immediate();
  }
}
