import { z } from "zod";
import { StoreError, type Store, type Owner } from "./store.js";
import type { Vault } from "./vault.js";
import {
  mailSendEnvelopeSchema,
  mailSendIdentitySchema,
  mailSendReceiptSchema,
  mailSendId,
  mailSendDigestSchema,
  mailSendDigest,
  matchingMailReceipt,
  mailSendObservationSchema,
} from "../connectors/mail-send-contracts.js";
const prepared = z
  .strictObject({
    identity: mailSendIdentitySchema,
    envelope: mailSendEnvelopeSchema,
  })
  .refine((v) => v.identity.mailbox === v.envelope.from);
const record = prepared
  .safeExtend({
    reconciliationOnly: z.boolean(),
    recordedAt: z.iso.datetime(),
    submittedAt: z.iso.datetime().nullable(),
    submittedGrantId: mailSendDigestSchema.nullable(),
    sourceSubmission: z.enum(["unobserved", "not_submitted", "reserved"]),
    receipt: mailSendReceiptSchema.nullable(),
    lastCheckedAt: z.iso.datetime().nullable(),
  })
  .refine(
    (v) =>
      (v.submittedAt === null) === (v.submittedGrantId === null) &&
      (!v.receipt || matchingMailReceipt(v.envelope, v.receipt)),
  );
export type MailSendRecord = z.infer<typeof record>;
/** Encrypted, owner-bound history. It contains no token, verifier, worker queue or automatic resume path. */
export class MailSends {
  constructor(
    private store: Store,
    private vault: Vault,
    private now: () => number,
  ) {}
  private purpose(o: Owner, id: string) {
    return JSON.stringify(["mail-send", o.tenantId, o.userId, id]);
  }
  read(o: Owner, id: string): MailSendRecord {
    mailSendId.parse(id);
    const row = this.store.db
      .prepare(
        "SELECT payload FROM mail_sends WHERE user_id=? AND tenant_id=? AND id=?",
      )
      .get(o.userId, o.tenantId, id) as { payload: Buffer } | undefined;
    if (!row) throw new StoreError("NOT_FOUND");
    const r = record.parse(this.vault.open(row.payload, this.purpose(o, id)));
    if (r.envelope.operationId !== id) throw new StoreError("CONFLICT");
    return r;
  }
  list(o: Owner) {
    return (
      this.store.db
        .prepare(
          "SELECT id FROM mail_sends WHERE user_id=? AND tenant_id=? ORDER BY rowid",
        )
        .all(o.userId, o.tenantId) as { id: string }[]
    ).map((r) => this.read(o, r.id));
  }
  private durable() {
    if (
      this.store.db.inTransaction ||
      this.store.db.pragma("synchronous", { simple: true }) !== 2
    )
      throw new StoreError("CONFLICT");
  }
  create(o: Owner, raw: unknown) {
    this.durable();
    const input = prepared.parse(raw),
      value: MailSendRecord = {
        ...input,
        reconciliationOnly: false,
        recordedAt: new Date(this.now()).toISOString(),
        submittedAt: null,
        submittedGrantId: null,
        sourceSubmission: "unobserved",
        receipt: null,
        lastCheckedAt: null,
      };
    const bytes = this.vault.seal(
      value,
      this.purpose(o, input.envelope.operationId),
    );
    return this.store.db
      .transaction(() => {
        if (
          this.store.db
            .prepare(
              "SELECT id FROM mail_sends WHERE user_id=? AND tenant_id=? AND id=?",
            )
            .get(o.userId, o.tenantId, input.envelope.operationId)
        )
          throw new StoreError("CONFLICT");
        const size = this.store.db
          .prepare(
            "SELECT count(*) count,coalesce(sum(length(payload)),0) bytes FROM mail_sends",
          )
          .get() as { count: number; bytes: number };
        if (size.count >= 100 || size.bytes + bytes.length > 24 * 1024 * 1024)
          throw new StoreError("CAPACITY");
        this.store.db
          .prepare(
            "INSERT INTO mail_sends(user_id,tenant_id,id,payload) VALUES(?,?,?,?)",
          )
          .run(o.userId, o.tenantId, input.envelope.operationId, bytes);
        return this.read(o, input.envelope.operationId);
      })
      .immediate();
  }
  reserve(o: Owner, id: string, raw: unknown) {
    this.durable();
    const input = z
      .strictObject({
        digest: mailSendDigestSchema,
        grantId: mailSendDigestSchema,
        confirmed: z.literal(true),
      })
      .parse(raw);
    return this.store.db
      .transaction(() => {
        const r = this.read(o, id);
        if (
          r.reconciliationOnly ||
          r.submittedAt ||
          r.sourceSubmission === "reserved" ||
          r.receipt ||
          mailSendDigest(r.envelope) !== input.digest
        )
          throw new StoreError("CONFLICT");
        this.write(o, id, {
          ...r,
          submittedAt: new Date(this.now()).toISOString(),
          submittedGrantId: input.grantId,
        });
        return this.read(o, id);
      })
      .immediate();
  }
  private write(o: Owner, id: string, r: MailSendRecord) {
    this.store.db
      .prepare(
        "UPDATE mail_sends SET payload=? WHERE user_id=? AND tenant_id=? AND id=?",
      )
      .run(
        this.vault.seal(record.parse(r), this.purpose(o, id)),
        o.userId,
        o.tenantId,
        id,
      );
  }
  observe(o: Owner, id: string, raw: unknown) {
    const v = mailSendObservationSchema.parse(raw);
    return this.store.db
      .transaction(() => {
        const r = this.read(o, id);
        if (
          v.operationId !== id ||
          v.digest !== mailSendDigest(r.envelope) ||
          (v.receipt && !matchingMailReceipt(r.envelope, v.receipt))
        )
          throw new StoreError("CONFLICT");
        let receipt = v.receipt ?? r.receipt;
        if (r.receipt && v.receipt) {
          const a = r.receipt,
            b = v.receipt;
          if (a.recordedAt !== b.recordedAt) throw new StoreError("CONFLICT");
          if (a.state !== "uncertain") {
            if (b.state === "uncertain")
              receipt = a; // A stale uncertain observation cannot erase known acceptance.
            else {
              const { sentCopy: as, ...ar } = a,
                { sentCopy: bs, ...br } = b;
              if (
                JSON.stringify(ar) !== JSON.stringify(br) ||
                (as !== bs && as !== "unverified" && bs !== "unverified")
              )
                throw new StoreError("CONFLICT");
              if (bs === "unverified") receipt = a;
            }
          } else if (a.completedAt !== null) {
            if (b.completedAt !== null && b.completedAt < a.completedAt)
              throw new StoreError("CONFLICT");
            if (b.state === "uncertain" && b.completedAt === null) receipt = a;
          }
        }
        const value: MailSendRecord = {
          ...r,
          receipt,
          sourceSubmission:
            r.sourceSubmission === "reserved" ||
            v.sourceSubmission === "reserved"
              ? "reserved"
              : "not_submitted",
          lastCheckedAt: new Date(this.now()).toISOString(),
        };
        this.write(o, id, value);
        return this.read(o, id);
      })
      .immediate();
  }
  remove(o: Owner, raw: unknown) {
    const v = z
      .strictObject({
        operationId: mailSendId,
        confirmed: z.literal(true),
        forgetSendTracking: z.literal(true),
      })
      .parse(raw);
    this.read(o, v.operationId);
    this.store.db
      .prepare(
        "DELETE FROM mail_sends WHERE user_id=? AND tenant_id=? AND id=?",
      )
      .run(o.userId, o.tenantId, v.operationId);
  }
  /** A restored prepared record may have been sent after that backup. It can only be reconciled. */
  lockAfterRestore() {
    this.store.db
      .transaction(() => {
        const rows = this.store.db
          .prepare("SELECT user_id,tenant_id,id FROM mail_sends")
          .all() as { user_id: string; tenant_id: string; id: string }[];
        for (const row of rows) {
          const o = { userId: row.user_id, tenantId: row.tenant_id },
            r = this.read(o, row.id);
          this.write(o, row.id, { ...r, reconciliationOnly: true });
        }
      })
      .immediate();
  }
  forOwner(owner: Owner) {
    const o = { ...owner };
    return {
      owner: JSON.stringify(o),
      read: (id: string) => this.read(o, id),
      list: () => this.list(o),
      create: (raw: unknown) => this.create(o, raw),
      reserve: (id: string, raw: unknown) => this.reserve(o, id, raw),
      observe: (id: string, raw: unknown) => this.observe(o, id, raw),
      remove: (raw: unknown) => this.remove(o, raw),
    };
  }
}
export type MailSendJournal = ReturnType<MailSends["forOwner"]>;
