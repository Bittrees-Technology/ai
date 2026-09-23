import { z } from "zod";
import { StoreError, type Store, type Owner } from "./store.js";
import type { Vault } from "./vault.js";
import {
  newsPublicationReviewSchema,
  newsPublicationReceiptSchema,
  newsPublicationIdentitySchema,
  matchingPublicationReceipt,
} from "../connectors/news-publication-contracts.js";

const reservation = z.strictObject({
  operationId: z.uuid(),
  identity: newsPublicationIdentitySchema,
  review: newsPublicationReviewSchema,
  confirmed: z.literal(true),
  audience: z.literal("public"),
});
const record = reservation.extend({
  recordedAt: z.iso.datetime(),
  receipt: newsPublicationReceiptSchema.nullable(),
  lastCheckedAt: z.iso.datetime().nullable(),
});
export type NewsPublicationRecord = z.infer<typeof record>;
/** No dispatch or resume queue: every reservation is uncertain until a matching historical receipt exists. */
export class NewsPublications {
  constructor(
    private store: Store,
    private vault: Vault,
    private now: () => number,
  ) {}
  private purpose(owner: Owner, id: string) {
    return JSON.stringify([
      "news-publication",
      owner.tenantId,
      owner.userId,
      id,
    ]);
  }
  read(owner: Owner, id: string): NewsPublicationRecord {
    z.uuid().parse(id);
    const row = this.store.db
      .prepare(
        "SELECT payload FROM news_publications WHERE user_id=? AND tenant_id=? AND id=?",
      )
      .get(owner.userId, owner.tenantId, id) as { payload: Buffer } | undefined;
    if (!row) throw new StoreError("NOT_FOUND");
    const value = record.parse(
      this.vault.open(row.payload, this.purpose(owner, id)),
    );
    if (
      value.operationId !== id ||
      (value.receipt &&
        !matchingPublicationReceipt(id, value.review, value.receipt))
    )
      throw new StoreError("CONFLICT");
    return value;
  }
  list(owner: Owner) {
    return (
      this.store.db
        .prepare(
          "SELECT id FROM news_publications WHERE user_id=? AND tenant_id=? ORDER BY rowid",
        )
        .all(owner.userId, owner.tenantId) as { id: string }[]
    ).map((r) => this.read(owner, r.id));
  }
  reserve(owner: Owner, raw: unknown) {
    if (
      this.store.db.inTransaction ||
      this.store.db.pragma("synchronous", { simple: true }) !== 2
    )
      throw new StoreError("CONFLICT");
    const input = reservation.parse(raw);
    if (!input.review.eligibility.eligible)
      throw new StoreError("INVALID_INPUT");
    const value: NewsPublicationRecord = {
      ...input,
      recordedAt: new Date(this.now()).toISOString(),
      receipt: null,
      lastCheckedAt: null,
    };
    const bytes = this.vault.seal(
      value,
      this.purpose(owner, value.operationId),
    );
    if (bytes.length > 8 * 1024 * 1024) throw new StoreError("CAPACITY");
    return this.store.db
      .transaction(() => {
        const current = this.list(owner);
        // A missing receipt is never permission to replace an unresolved operation, including after reconnect.
        if (
          current.some(
            (r) =>
              r.operationId === input.operationId ||
              (r.identity.accountId === input.identity.accountId && !r.receipt),
          )
        )
          throw new StoreError("CONFLICT");
        const size = this.store.db
          .prepare(
            "SELECT count(*) AS count, coalesce(sum(length(payload)),0) AS bytes FROM news_publications",
          )
          .get() as { count: number; bytes: number };
        if (size.count >= 100 || size.bytes + bytes.length > 24 * 1024 * 1024)
          throw new StoreError("CAPACITY");
        this.store.db
          .prepare(
            "INSERT INTO news_publications(user_id,tenant_id,id,payload) VALUES(?,?,?,?)",
          )
          .run(owner.userId, owner.tenantId, input.operationId, bytes);
        return this.read(owner, input.operationId);
      })
      .immediate();
  }
  reconcile(owner: Owner, id: string, raw: unknown) {
    const receipt = newsPublicationReceiptSchema.nullable().parse(raw);
    return this.store.db
      .transaction(() => {
        const current = this.read(owner, id);
        if (receipt && !matchingPublicationReceipt(id, current.review, receipt))
          throw new StoreError("CONFLICT");
        if (current.receipt) {
          if (
            receipt &&
            JSON.stringify(current.receipt) !== JSON.stringify(receipt)
          )
            throw new StoreError("CONFLICT");
          return current; // A later absent receipt cannot erase an already verified historical commit.
        }
        const value = {
          ...current,
          receipt,
          lastCheckedAt: new Date(this.now()).toISOString(),
        };
        this.store.db
          .prepare(
            "UPDATE news_publications SET payload=? WHERE user_id=? AND tenant_id=? AND id=?",
          )
          .run(
            this.vault.seal(value, this.purpose(owner, id)),
            owner.userId,
            owner.tenantId,
            id,
          );
        return this.read(owner, id);
      })
      .immediate();
  }
  /** Local deletion is explicit. It neither withdraws an edition nor cancels an in-flight source write. */
  remove(owner: Owner, raw: unknown) {
    const input = z
      .strictObject({
        operationId: z.uuid(),
        confirmed: z.literal(true),
        forgetPublicationTracking: z.literal(true),
      })
      .parse(raw);
    this.read(owner, input.operationId);
    this.store.db
      .prepare(
        "DELETE FROM news_publications WHERE user_id=? AND tenant_id=? AND id=?",
      )
      .run(owner.userId, owner.tenantId, input.operationId);
  }
  forOwner(owner: Owner) {
    const bound = { ...owner };
    return {
      owner: JSON.stringify(bound),
      read: (id: string) => this.read(bound, id),
      list: () => this.list(bound),
      reserve: (raw: unknown) => this.reserve(bound, raw),
      reconcile: (id: string, raw: unknown) => this.reconcile(bound, id, raw),
      remove: (raw: unknown) => this.remove(bound, raw),
    };
  }
}
export type NewsPublicationJournal = ReturnType<NewsPublications["forOwner"]>;
