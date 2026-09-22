import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AsyncEntry } from "@napi-rs/keyring";
import { z } from "zod";
import { ConnectorError, type ConnectorSecret } from "./crm.js";
const origin = "https://mail.bittrees.org";
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const mailbox = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}@bittrees\.org$/);
const wallet = z.string().regex(/^0x[a-f0-9]{40}$/);
const folder = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/)
  .refine((v) => v === v.trim());
const attachmentSelection = z.strictObject({
  id: z
    .string()
    .max(80)
    .regex(/^[1-9][0-9]*(?:\.[1-9][0-9]*){0,7}$/),
  version: hex,
});
const selection = z
  .strictObject({
    id: hex,
    folder,
    metadataVersion: hex,
    plainVersion: hex.optional(),
    attachment: attachmentSelection.optional(),
  })
  .refine(
    (s) =>
      !s.attachment ||
      !s.plainVersion ||
      s.attachment.version === s.plainVersion,
  );
const scopes = z.union([
  z.tuple([z.literal("metadata")]),
  z.tuple([z.literal("metadata"), z.literal("plain")]),
  z.tuple([z.literal("metadata"), z.literal("attachment")]),
  z.tuple([z.literal("metadata"), z.literal("plain"), z.literal("attachment")]),
]);
const grantSchema = z
  .strictObject({
    token: hex,
    grantId: hex,
    mailbox,
    wallet,
    selection,
    scopes,
    expiresAt: z.iso.datetime(),
    policyRevision: z.enum(["mail-ai-selected-v1", "mail-ai-selected-v2"]),
  })
  .refine(
    (g) =>
      JSON.stringify(g.scopes) ===
        JSON.stringify([
          "metadata",
          ...(g.selection.plainVersion ? ["plain"] : []),
          ...(g.selection.attachment ? ["attachment"] : []),
        ]) &&
      g.policyRevision ===
        (g.selection.attachment
          ? "mail-ai-selected-v2"
          : "mail-ai-selected-v1"),
  );
const savedSchema = z.strictObject({
  owner: z.string().min(1).max(256),
  grant: grantSchema,
  disconnectPending: z.boolean().optional(),
});
const fields = {
  from: z.string().max(400),
  subject: z.string().max(400),
  date: z.string().max(160),
  truncatedMetadata: z.array(z.enum(["from", "subject", "date"])).max(3),
  sourceVersion: hex,
  attachmentsIncluded: z.literal(false),
};
const attachmentText = z
  .strictObject({
    id: attachmentSelection.shape.id,
    filename: z
      .string()
      .refine(
        (v) =>
          Buffer.byteLength(v) <= 128 &&
          !/[\x00-\x1f\x7f/\\]/.test(v) &&
          /\.(txt|csv|log)$/i.test(v),
      ),
    contentType: z.literal("text/plain"),
    encodedBytes: z.number().int().min(0).max(524288),
    supported: z.literal(true),
    text: z
      .string()
      .refine(
        (v) =>
          Buffer.byteLength(v) <= 32768 &&
          Buffer.from(v).toString("utf8") === v &&
          !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v),
      ),
    bytes: z.number().int().min(0).max(32768),
    truncated: z.literal(false),
  })
  .refine((a) => Buffer.byteLength(a.text) === a.bytes);
// Preserve canonical wire field order before independently verifying the source hash.
const message = z.discriminatedUnion("mode", [
  z.strictObject({ id: hex, mode: z.literal("metadata"), ...fields }),
  z
    .strictObject({
      id: hex,
      mode: z.literal("plain"),
      ...fields,
      text: z.string().refine((v) => Buffer.byteLength(v) <= 16000),
      bodyAvailable: z.boolean(),
      bodyTruncated: z.boolean(),
    })
    .refine((m) => m.bodyAvailable || (!m.text && !m.bodyTruncated)),
  z.strictObject({
    id: hex,
    mode: z.literal("attachment-text"),
    ...fields,
    attachmentsIncluded: z.literal(true),
    attachment: attachmentText,
  }),
]);
const readSchema = z.strictObject({
  grantId: hex,
  mailbox,
  wallet,
  folder,
  scopes,
  expiresAt: z.iso.datetime(),
  policyRevision: z.enum(["mail-ai-selected-v1", "mail-ai-selected-v2"]),
  message,
  projectionHash: hex,
});
export function mailKeychainEntry(profile: string): ConnectorSecret {
  if (process.platform !== "darwin" || !/^[A-Za-z0-9_-]{1,80}$/.test(profile))
    throw new Error("Mail credentials require a valid macOS profile");
  return new AsyncEntry("org.bittrees.ai.connector.mail", profile);
}
/** One explicit source identity per personal profile. No inference, source approval or automatic reconnect. */
export class MailConnector {
  private pending?: {
    id: string;
    verifier: string;
    expires: number;
  };
  private busy = false;
  private generation = 0;
  constructor(
    private readonly owner: string,
    private readonly secret: ConnectorSecret,
    private readonly transport: typeof fetch = fetch,
    private readonly now = Date.now,
  ) {
    z.string().min(1).max(256).parse(owner);
  }
  private async saved() {
    const raw = await this.secret.getSecret();
    if (!raw) throw new ConnectorError("CONNECTION_REQUIRED");
    try {
      if (raw.length > 32_768) throw new Error();
      const saved = savedSchema.parse(
        JSON.parse(Buffer.from(raw).toString("utf8")),
      );
      if (saved.owner !== this.owner) throw new Error();
      return {
        ...saved.grant,
        disconnectPending: saved.disconnectPending === true,
      };
    } catch {
      throw new ConnectorError("INVALID_CONNECTION");
    }
  }
  async status() {
    try {
      const { token: _token, ...grant } = await this.saved();
      return {
        ...grant,
        state: grant.disconnectPending
          ? ("disconnect_pending" as const)
          : Date.parse(grant.expiresAt) <= this.now()
            ? ("expired" as const)
            : ("stored" as const),
        manageUrl: origin + "/connect/ai",
      };
    } catch (e) {
      if (e instanceof ConnectorError && e.code === "CONNECTION_REQUIRED")
        return null;
      throw e;
    }
  }
  async begin() {
    if (this.busy) throw new ConnectorError("CONNECTION_BUSY");
    this.busy = true;
    try {
      if (await this.status()) throw new ConnectorError("INVALID_CONNECTION");
      const verifier = randomBytes(32).toString("base64url"),
        id = randomUUID();
      const expires = this.now() + 10 * 60_000;
      this.pending = { id, verifier, expires };
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      return {
        id,
        consentUrl: origin + "/connect/ai?challenge=" + challenge,
        expiresAt: new Date(expires).toISOString(),
      };
    } finally {
      this.busy = false;
    }
  }
  private async post(
    path: "exchange" | "read" | "disconnect",
    body: unknown,
    token?: string,
  ) {
    try {
      const response = await this.transport(
        origin + "/api/integrations/ai/" + path,
        {
          method: "POST",
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: "Bearer " + token } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(45_000),
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
          if (size > 131072) throw new ConnectorError("INVALID_SOURCE");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch (e) {
      if (e instanceof ConnectorError) throw e;
      // Source bodies, tokens, codes and exception text never become UI/log errors.
      throw new ConnectorError("SOURCE_UNAVAILABLE");
    }
  }
  async finish(id: string, code: string) {
    if (this.busy) throw new ConnectorError("CONNECTION_BUSY");
    const pending = this.pending;
    if (
      !pending ||
      pending.id !== id ||
      pending.expires <= this.now() ||
      !/^[a-f0-9]{64}$/.test(code)
    )
      throw new ConnectorError("INVALID_CONNECTION");
    this.busy = true;
    this.pending = undefined; // No blind retry after an uncertain one-time exchange.
    try {
      const parsed = grantSchema.safeParse(
        await this.post("exchange", { code, verifier: pending.verifier }),
      );
      if (
        !parsed.success ||
        Date.parse(parsed.data.expiresAt) <= this.now() ||
        Date.parse(parsed.data.expiresAt) > this.now() + 61 * 60_000
      )
        throw new ConnectorError("INVALID_SOURCE");
      const value = Buffer.from(
        JSON.stringify({ owner: this.owner, grant: parsed.data }),
      );
      await this.secret.setSecret(value);
      const verified = await this.secret.getSecret();
      if (!verified || !value.equals(Buffer.from(verified)))
        throw new ConnectorError("INVALID_CONNECTION");
      this.generation++;
      return await this.status();
    } finally {
      this.busy = false;
    }
  }
  async read(content: "metadata" | "plain" | "attachment-text" = "metadata") {
    z.enum(["metadata", "plain", "attachment-text"]).parse(content);
    if (this.busy) throw new ConnectorError("CONNECTION_BUSY");
    const generation = this.generation,
      grant = await this.saved();
    if (grant.disconnectPending) throw new ConnectorError("CONNECTION_BUSY");
    if (Date.parse(grant.expiresAt) <= this.now())
      throw new ConnectorError("CONNECTION_EXPIRED");
    if (content === "plain" && !grant.selection.plainVersion)
      throw new ConnectorError("SOURCE_DENIED");
    if (content === "attachment-text" && !grant.selection.attachment)
      throw new ConnectorError("SOURCE_DENIED");
    const parsed = readSchema.safeParse(
      await this.post("read", { content }, grant.token),
    );
    if (!parsed.success) throw new ConnectorError("INVALID_SOURCE");
    const { projectionHash, ...result } = parsed.data,
      m = result.message;
    if (
      result.grantId !== grant.grantId ||
      result.mailbox !== grant.mailbox ||
      result.wallet !== grant.wallet ||
      result.folder !== grant.selection.folder ||
      result.expiresAt !== grant.expiresAt ||
      result.policyRevision !== grant.policyRevision ||
      (m.mode === "attachment-text" &&
        m.attachment.id !== grant.selection.attachment?.id) ||
      JSON.stringify(result.scopes) !== JSON.stringify(grant.scopes) ||
      m.mode !== content ||
      m.id !== grant.selection.id ||
      m.sourceVersion !==
        (content === "plain"
          ? grant.selection.plainVersion
          : content === "attachment-text"
            ? grant.selection.attachment?.version
            : grant.selection.metadataVersion) ||
      createHash("sha256").update(JSON.stringify(result)).digest("hex") !==
        projectionHash
    )
      throw new ConnectorError("INVALID_SOURCE");
    if (
      generation !== this.generation ||
      Date.parse(grant.expiresAt) <= this.now()
    )
      throw new ConnectorError("CONNECTION_EXPIRED");
    return parsed.data;
  }
  async disconnect() {
    if (this.busy) throw new ConnectorError("CONNECTION_BUSY");
    this.busy = true;
    this.pending = undefined;
    this.generation++;
    try {
      let grant;
      try {
        grant = await this.saved();
      } catch (e) {
        if (e instanceof ConnectorError && e.code === "CONNECTION_REQUIRED")
          return;
        throw e;
      }
      const { disconnectPending: _pending, ...credential } = grant;
      // Persist suspension before network dispatch; uncertain revoke remains retryable after restart.
      const value = Buffer.from(
        JSON.stringify({
          owner: this.owner,
          grant: grantSchema.parse(credential),
          disconnectPending: true,
        }),
      );
      await this.secret.setSecret(value);
      const verified = await this.secret.getSecret();
      if (!verified || !value.equals(Buffer.from(verified)))
        throw new ConnectorError("INVALID_CONNECTION");
      const reply = z
        .strictObject({ ok: z.literal(true) })
        .safeParse(await this.post("disconnect", {}, grant.token));
      if (!reply.success) throw new ConnectorError("INVALID_SOURCE");
      await this.secret.deleteCredential();
      if (await this.secret.getSecret())
        throw new ConnectorError("INVALID_CONNECTION");
    } finally {
      this.busy = false;
    }
  }
  /** Local removal only. The source consent page must revoke the source grant. */
  async forgetLocal() {
    if (this.busy) throw new ConnectorError("CONNECTION_BUSY");
    this.busy = true;
    try {
      this.pending = undefined;
      this.generation++;
      await this.secret.deleteCredential();
      if (await this.secret.getSecret())
        throw new ConnectorError("INVALID_CONNECTION");
    } finally {
      this.busy = false;
    }
  }
}
