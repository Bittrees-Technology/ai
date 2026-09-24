import {
  privateRelayEnvelopeHash,
  privateRelayStorageReceiptSchema,
} from "./private-relay-contracts.js";
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
    // Absent on genuine pre-schema31 offers; migration invents no upload history.
    relay: z
      .strictObject({
        attempts: positive,
        lastAttemptAt: positive,
        observation: z
          .strictObject({
            receipt: privateRelayStorageReceiptSchema,
            observedAt: positive,
            attempt: positive,
          })
          .nullable(),
      })
      .optional(),
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
      (!v.envelope || same(v.envelope.header, v.header)) &&
      (!v.relay ||
        (!!v.envelope &&
          v.state !== "preparing" &&
          v.relay.lastAttemptAt >= v.header.issuedAt &&
          v.relay.lastAttemptAt < v.header.expiresAt &&
          (!v.relay.observation ||
            (v.relay.observation.attempt <= v.relay.attempts &&
              v.relay.observation.receipt.messageId === v.header.messageId &&
              v.relay.observation.receipt.storedAt >=
                v.header.issuedAt - 30000 &&
              v.relay.observation.receipt.storedAt <=
                v.relay.observation.observedAt + 30000)))),
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
            expiresAt: positive.optional(),
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
          if (
            input.expiresAt !== undefined &&
            (input.expiresAt <= this.now() ||
              input.expiresAt > this.now() + 300000 ||
              input.expiresAt > p.grant.choices.expiresAt)
          )
            throw new ConversationOfferError("DENIED");
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
              expiresAt:
                input.expiresAt ?? Math.min(issuedAt + 300000, offer.expiresAt),
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
  /** Reserve an explicit upload attempt before network work. Retrying never
   * reseals, extends the offer or consumes another outgoing sequence. */
  beginRelayDelivery(raw: unknown) {
    return this.bounded(async () => {
      const input = this.input(
          z.strictObject({
            id: z.uuid(),
            expectedRevision: positive,
            deliveryExpiresAt: positive,
            confirmed: z.literal(true),
          }),
          raw,
        ),
        before = this.get(input.id),
        handle = await this.consent.resolve(before.value.grant.id);
      return this.store.db
        .transaction(() => {
          const current = this.get(input.id);
          if (current.revision !== input.expectedRevision)
            throw new ConversationOfferError("CONFLICT");
          this.checked(current, handle);
          if (
            current.value.state !== "ready" ||
            !current.value.envelope ||
            current.value.header.expiresAt > input.deliveryExpiresAt
          )
            throw new ConversationOfferError("DENIED");
          const attempts = current.value.relay?.attempts ?? 0;
          if (attempts >= Number.MAX_SAFE_INTEGER)
            throw new ConversationOfferError("CAPACITY");
          current.value.relay = {
            attempts: attempts + 1,
            lastAttemptAt: this.now(),
            observation: current.value.relay?.observation ?? null,
          };
          this.save(current);
          this.checked(current, handle);
          return structuredClone(current);
        })
        .immediate();
    });
  }
  /** Historical server storage observation, not browser consent or content
   * acceptance. Validate the exact envelope and current authority before commit. */
  recordRelayDelivery(raw: unknown) {
    return this.bounded(async () => {
      const input = this.input(
          z.strictObject({
            id: z.uuid(),
            expectedRevision: positive,
            receipt: privateRelayStorageReceiptSchema,
          }),
          raw,
        ),
        before = this.get(input.id),
        handle = await this.consent.resolve(before.value.grant.id);
      if (
        !before.value.envelope ||
        input.receipt.messageId !== before.value.header.messageId ||
        input.receipt.envelopeHash !==
          (await privateRelayEnvelopeHash(before.value.envelope)) ||
        input.receipt.storedAt < before.value.header.issuedAt - 30000 ||
        input.receipt.storedAt > this.now() + 30000
      )
        throw new ConversationOfferError("DENIED");
      return this.store.db
        .transaction(() => {
          const current = this.get(input.id);
          if (current.revision !== input.expectedRevision)
            throw new ConversationOfferError("CONFLICT");
          this.checked(current, handle);
          if (
            current.value.state !== "ready" ||
            !current.value.relay ||
            !same(current.value.envelope, before.value.envelope)
          )
            throw new ConversationOfferError("DENIED");
          const old = current.value.relay.observation?.receipt,
            receipt = input.receipt;
          const rank = { stored: 0, received: 1, deleted: 2 };
          if (
            old &&
            (receipt.storedAt !== old.storedAt ||
              receipt.envelopeHash !== old.envelopeHash ||
              receipt.revision < old.revision ||
              rank[receipt.state] < rank[old.state] ||
              (receipt.revision === old.revision && !same(receipt, old)))
          )
            throw new ConversationOfferError("CONFLICT");
          current.value.relay.observation = {
            receipt,
            observedAt: this.now(),
            attempt: current.value.relay.attempts,
          };
          this.save(current);
          this.checked(current, handle);
          return structuredClone(current);
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
