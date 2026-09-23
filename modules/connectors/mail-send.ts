import { randomBytes, randomUUID, createHash } from "node:crypto";
import { AsyncEntry } from "@napi-rs/keyring";
import { z } from "zod";
import { ConnectorError, type ConnectorSecret } from "./crm.js";
import type { MailSendJournal } from "../storage/mail-sends.js";
import {
  mailSendOrigin,
  mailSendVersion,
  mailSendDraftSchema,
  mailSendIdentitySchema,
  mailSendGrantSchema,
  mailSendId,
  mailSendDigestSchema,
  mailSendDigest,
  mailSendObservationSchema,
} from "./mail-send-contracts.js";
const savedSchema = z.strictObject({
  owner: z.string().min(1).max(256),
  grant: mailSendGrantSchema,
  disconnectPending: z.boolean().optional(),
});
type Saved = z.infer<typeof savedSchema>;
export function mailSendKeychainEntry(profile: string): ConnectorSecret {
  if (process.platform !== "darwin" || !/^[A-Za-z0-9_-]{1,80}$/.test(profile))
    throw Error("Reviewed Mail credentials require a valid macOS profile");
  return new AsyncEntry("org.bittrees.ai.connector.mail-send", profile);
}
/** Explicit review, one durable dispatch, read-only reconciliation. Independent of selected-message read credentials. */
export class MailSendConnector {
  private running = false;
  private pending?: { operationId: string; verifier: string; expires: number };
  private review?: {
    id: string;
    operationId: string;
    expires: number;
    credential: string;
    digest: string;
    timer: NodeJS.Timeout;
  };
  constructor(
    private readonly owner: string,
    private secret: ConnectorSecret,
    private journal: MailSendJournal,
    private transport: typeof fetch = fetch,
    private now = Date.now,
  ) {
    z.string().min(1).max(256).parse(owner);
    if (journal.owner !== owner) throw new ConnectorError("INVALID_CONNECTION");
  }
  get busy() {
    return this.running;
  }
  invalidateReview() {
    if (this.review) clearTimeout(this.review.timer);
    this.review = undefined;
  }
  private async exclusive<T>(fn: () => Promise<T>) {
    if (this.running) throw new ConnectorError("CONNECTION_BUSY");
    this.running = true;
    try {
      return await fn();
    } finally {
      this.running = false;
    }
  }
  private async saved(): Promise<Saved> {
    const raw = await this.secret.getSecret();
    if (!raw) throw new ConnectorError("CONNECTION_REQUIRED");
    try {
      const s = savedSchema.parse(JSON.parse(Buffer.from(raw).toString()));
      if (s.owner !== this.owner) throw Error();
      return s;
    } catch {
      throw new ConnectorError("INVALID_CONNECTION");
    }
  }
  private async checked(id: string) {
    const s = await this.saved();
    if (s.disconnectPending) throw new ConnectorError("CONNECTION_BUSY");
    if (Date.parse(s.grant.expiresAt) <= this.now())
      throw new ConnectorError("CONNECTION_EXPIRED");
    const r = this.journal.read(id),
      g = s.grant;
    if (
      g.operationId !== id ||
      g.wallet !== r.identity.wallet ||
      g.mailbox !== r.identity.mailbox ||
      g.digest !== mailSendDigest(r.envelope) ||
      g.recipientCount !==
        r.envelope.to.length + r.envelope.cc.length + r.envelope.bcc.length
    )
      throw new ConnectorError("SOURCE_CONFLICT");
    return s;
  }
  private async verify(s: Saved) {
    const current = await this.checked(s.grant.operationId);
    if (JSON.stringify(current) !== JSON.stringify(s))
      throw new ConnectorError("SOURCE_CONFLICT");
  }
  private async save(s: Saved) {
    const bytes = Buffer.from(JSON.stringify(savedSchema.parse(s)));
    await this.secret.setSecret(bytes);
    const read = await this.secret.getSecret();
    if (!read || !bytes.equals(Buffer.from(read)))
      throw new ConnectorError("INVALID_CONNECTION");
  }
  private async post(
    action: "exchange" | "submit" | "receipt" | "disconnect",
    input: unknown,
    token?: string,
  ) {
    try {
      const response = await this.transport(
        mailSendOrigin + "/api/integrations/ai-send/" + action,
        {
          method: "POST",
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: "Bearer " + token } : {}),
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(45000),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new ConnectorError(
          response.status === 409
            ? "SOURCE_CONFLICT"
            : response.status === 429
              ? "SOURCE_CAPACITY"
              : [401, 403, 404].includes(response.status)
                ? "SOURCE_DENIED"
                : "SOURCE_UNAVAILABLE",
        );
      }
      if (
        !/^application\/json\b/i.test(
          response.headers.get("content-type") ?? "",
        )
      ) {
        await response.body?.cancel();
        throw new ConnectorError("INVALID_SOURCE");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new ConnectorError("INVALID_SOURCE");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 65536) throw new ConnectorError("INVALID_SOURCE");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch (e) {
      if (e instanceof ConnectorError) throw e;
      throw new ConnectorError("SOURCE_UNAVAILABLE");
    }
  }
  async status() {
    let saved;
    try {
      saved = await this.saved();
    } catch (e) {
      if (e instanceof ConnectorError && e.code === "CONNECTION_REQUIRED")
        return {
          connection: null,
          manageUrl: mailSendOrigin + "/connect/ai-send",
        };
      throw e;
    }
    const { token: _token, ...grant } = saved.grant;
    return {
      connection: {
        ...grant,
        state: saved.disconnectPending
          ? "disconnect_pending"
          : Date.parse(grant.expiresAt) <= this.now()
            ? "expired"
            : "stored",
      },
      manageUrl: mailSendOrigin + "/connect/ai-send",
    };
  }
  private async noOtherConnection(id?: string) {
    try {
      const s = await this.saved();
      if (s.disconnectPending || s.grant.operationId !== id)
        throw new ConnectorError("INVALID_CONNECTION");
    } catch (e) {
      if (!(e instanceof ConnectorError && e.code === "CONNECTION_REQUIRED"))
        throw e;
    }
  }
  private beginRecord(id: string) {
    const record = this.journal.read(id),
      verifier = randomBytes(32).toString("base64url"),
      expires = this.now() + 600000;
    this.pending = { operationId: id, verifier, expires };
    return {
      operationId: id,
      consentUrl: mailSendOrigin + "/connect/ai-send",
      expiresAt: new Date(expires).toISOString(),
      reviewFile: {
        version: "bittrees-mail-review-v1" as const,
        challenge: createHash("sha256").update(verifier).digest("base64url"),
        envelope: record.envelope,
      },
    };
  }
  async prepare(raw: unknown) {
    return this.exclusive(async () => {
      this.invalidateReview();
      this.pending = undefined;
      await this.noOtherConnection();
      const input = z
        .strictObject({
          identity: mailSendIdentitySchema,
          message: mailSendDraftSchema,
        })
        .parse(raw);
      if (input.identity.mailbox !== input.message.from)
        throw new ConnectorError("SOURCE_CONFLICT");
      const operationId = randomUUID();
      this.journal.create({
        identity: input.identity,
        envelope: {
          contractVersion: mailSendVersion,
          operationId,
          ...input.message,
        },
      });
      return this.beginRecord(operationId);
    });
  }
  async reconnect(raw: unknown) {
    return this.exclusive(async () => {
      const { operationId } = z
        .strictObject({ operationId: mailSendId })
        .parse(raw);
      this.invalidateReview();
      this.pending = undefined;
      await this.noOtherConnection(operationId);
      return this.beginRecord(operationId);
    });
  }
  async finish(raw: unknown) {
    return this.exclusive(async () => {
      const input = z
          .strictObject({ operationId: mailSendId, code: mailSendDigestSchema })
          .parse(raw),
        pending = this.pending;
      this.pending = undefined;
      this.invalidateReview();
      if (
        !pending ||
        pending.operationId !== input.operationId ||
        pending.expires <= this.now()
      )
        throw new ConnectorError("INVALID_CONNECTION");
      const r = this.journal.read(input.operationId);
      await this.noOtherConnection(input.operationId);
      const parsed = mailSendGrantSchema.safeParse(
        await this.post("exchange", {
          code: input.code,
          verifier: pending.verifier,
        }),
      );
      if (!parsed.success) throw new ConnectorError("INVALID_SOURCE");
      const g = parsed.data;
      if (
        g.wallet !== r.identity.wallet ||
        g.mailbox !== r.identity.mailbox ||
        g.operationId !== input.operationId ||
        g.digest !== mailSendDigest(r.envelope) ||
        g.recipientCount !==
          r.envelope.to.length + r.envelope.cc.length + r.envelope.bcc.length ||
        Date.parse(g.expiresAt) <= this.now() ||
        Date.parse(g.expiresAt) > this.now() + 61 * 60000
      )
        throw new ConnectorError("INVALID_SOURCE");
      this.journal.read(input.operationId);
      if (g.previouslySubmitted)
        this.journal.observe(input.operationId, {
          operationId: input.operationId,
          digest: g.digest,
          sourceSubmission: "reserved",
          receipt: null,
        });
      await this.save({ owner: this.owner, grant: g });
      return this.status();
    });
  }
  async prepareSend(raw: unknown) {
    return this.exclusive(async () => {
      this.invalidateReview();
      const { operationId } = z
          .strictObject({ operationId: mailSendId })
          .parse(raw),
        saved = await this.checked(operationId),
        r = this.journal.read(operationId);
      if (
        r.reconciliationOnly ||
        r.submittedAt ||
        r.sourceSubmission === "reserved" ||
        r.receipt ||
        saved.grant.previouslySubmitted
      )
        throw new ConnectorError("MAIL_SEND_UNCONFIRMED");
      const id = randomUUID(),
        expires = Math.min(
          this.now() + 120000,
          Date.parse(saved.grant.expiresAt),
        ),
        timer = setTimeout(
          () => {
            if (this.review?.id === id) this.invalidateReview();
          },
          Math.max(1, expires - this.now()),
        );
      timer.unref();
      this.review = {
        id,
        operationId,
        expires,
        credential: JSON.stringify(saved),
        digest: mailSendDigest(r.envelope),
        timer,
      };
      return {
        id,
        operationId,
        identity: r.identity,
        envelope: r.envelope,
        digest: this.review.digest,
        expiresAt: new Date(expires).toISOString(),
      };
    });
  }
  cancelReview(raw: unknown) {
    const { id } = z.strictObject({ id: mailSendId }).parse(raw);
    if (this.review?.id === id) this.invalidateReview();
    return { cancelled: true };
  }
  async confirm(raw: unknown) {
    return this.exclusive(async () => {
      const input = z
          .strictObject({ id: mailSendId, confirmed: z.literal(true) })
          .parse(raw),
        p = this.review;
      this.invalidateReview();
      if (!p || p.id !== input.id || p.expires <= this.now())
        throw new ConnectorError("REVIEW_EXPIRED");
      const saved = await this.checked(p.operationId);
      if (JSON.stringify(saved) !== p.credential || p.expires <= this.now())
        throw new ConnectorError("SOURCE_CONFLICT");
      this.journal.reserve(p.operationId, {
        digest: p.digest,
        grantId: saved.grant.grantId,
        confirmed: true,
      });
      const r = this.journal.read(p.operationId);
      if (
        !r.submittedAt ||
        r.submittedGrantId !== saved.grant.grantId ||
        mailSendDigest(r.envelope) !== p.digest
      )
        throw new ConnectorError("SOURCE_CONFLICT");
      await this.verify(saved);
      this.journal.read(p.operationId);
      if (p.expires <= this.now()) throw new ConnectorError("REVIEW_EXPIRED");
      try {
        const observation = mailSendObservationSchema.parse(
          await this.post(
            "submit",
            { envelope: r.envelope },
            saved.grant.token,
          ),
        );
        await this.verify(saved);
        return this.journal.observe(p.operationId, observation);
      } catch {
        throw new ConnectorError("MAIL_SEND_UNCONFIRMED");
      }
    });
  }
  async reconcile(raw: unknown) {
    return this.exclusive(async () => {
      this.invalidateReview();
      const { operationId } = z
          .strictObject({ operationId: mailSendId })
          .parse(raw),
        saved = await this.checked(operationId),
        r = this.journal.read(operationId);
      const observation = mailSendObservationSchema.safeParse(
        await this.post("receipt", { envelope: r.envelope }, saved.grant.token),
      );
      if (!observation.success) throw new ConnectorError("INVALID_SOURCE");
      await this.verify(saved);
      return this.journal.observe(operationId, observation.data);
    });
  }
  history() {
    return {
      items: this.journal
        .list()
        .map((r) => ({
          operationId: r.envelope.operationId,
          identity: r.identity,
          subject: r.envelope.subject,
          recordedAt: r.recordedAt,
          reconciliationOnly: r.reconciliationOnly,
          submittedAt: r.submittedAt,
          sourceSubmission: r.sourceSubmission,
          receipt: r.receipt,
          lastCheckedAt: r.lastCheckedAt,
        })),
    };
  }
  record(raw: unknown) {
    const { operationId } = z
      .strictObject({ operationId: mailSendId })
      .parse(raw);
    return this.journal.read(operationId);
  }
  async disconnect() {
    return this.exclusive(async () => {
      this.invalidateReview();
      this.pending = undefined;
      let s;
      try {
        s = await this.saved();
      } catch (e) {
        if (e instanceof ConnectorError && e.code === "CONNECTION_REQUIRED")
          return { disconnected: true };
        throw e;
      }
      await this.save({ ...s, disconnectPending: true });
      const response = z
        .strictObject({ ok: z.literal(true) })
        .safeParse(await this.post("disconnect", {}, s.grant.token));
      if (!response.success) throw new ConnectorError("INVALID_SOURCE");
      await this.clearSecret();
      return { disconnected: true };
    });
  }
  private async clearSecret() {
    await this.secret.deleteCredential();
    if (await this.secret.getSecret())
      throw new ConnectorError("INVALID_CONNECTION");
  }
  async forgetLocal() {
    return this.exclusive(async () => {
      this.invalidateReview();
      this.pending = undefined;
      await this.clearSecret();
      return { removed: true, sourceRevoked: false };
    });
  }
  async remove(raw: unknown) {
    return this.exclusive(async () => {
      const input = z
        .strictObject({
          operationId: mailSendId,
          confirmed: z.literal(true),
          forgetSendTracking: z.literal(true),
        })
        .parse(raw);
      this.journal.read(input.operationId);
      this.invalidateReview();
      if (this.pending?.operationId === input.operationId)
        this.pending = undefined;
      let s;
      try {
        s = await this.saved();
      } catch (e) {
        if (!(e instanceof ConnectorError && e.code === "CONNECTION_REQUIRED"))
          throw e;
      }
      if (s?.grant.operationId === input.operationId) await this.clearSecret();
      this.journal.remove(input);
      return { removed: true, sourceCancelled: false, sourceRevoked: false };
    });
  }
}
