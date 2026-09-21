import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AsyncEntry } from "@napi-rs/keyring";
import { z } from "zod";

import { ConnectorError, type ConnectorSecret } from "./crm.js";

const origin = "https://autonote.bittrees.org";
const grantSchema = z.strictObject({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  grantId: z.uuid(),
  subjectId: z.uuid(),
  workspaceId: z.uuid(),
  meetingId: z.uuid(),
  actions: z.tuple([z.literal("read_transcript")]),
  expiresAt: z.iso.datetime(),
  policyRevision: z.literal("autonote-ai-transcript-v1"),
});
const savedSchema = z.strictObject({
  owner: z.string().min(1).max(256),
  grant: grantSchema,
  disconnectPending: z.boolean().optional(),
});
const segmentSchema = z
  .strictObject({
    id: z.string().min(1).max(100),
    start: z.number().finite().nonnegative(),
    end: z.number().finite().nonnegative(),
    speaker: z.string().max(100),
    text: z.string().max(10000),
  })
  .refine((s) => s.end >= s.start);
const meetingSchema = z.strictObject({
  id: z.uuid(),
  title: z.string().max(200),
  language: z.string().max(32),
  version: z.number().int().positive(),
  segments: z
    .array(segmentSchema)
    .min(1)
    .max(10000)
    .refine((items) => new Set(items.map((s) => s.id)).size === items.length),
});
const readSchema = z.strictObject({
  contractVersion: z.literal("1.0.0"),
  grantId: z.uuid(),
  subjectId: z.uuid(),
  workspaceId: z.uuid(),
  policyRevision: z.literal("autonote-ai-transcript-v1"),
  meeting: meetingSchema,
  projectionHash: z.string().regex(/^[a-f0-9]{64}$/),
  publication: z.strictObject({
    mode: z.literal("autonote_review_only"),
    directCrm: z.literal(false),
  }),
});
export function autonoteKeychainEntry(profile: string): ConnectorSecret {
  if (process.platform !== "darwin" || !/^[A-Za-z0-9_-]{1,80}$/.test(profile))
    throw new Error("AutoNote credentials require a valid macOS profile");
  return new AsyncEntry("org.bittrees.ai.connector.autonote", profile);
}
/** One explicit source identity per personal profile. No inference, source approval or automatic reconnect. */
export class AutoNoteConnector {
  private pending?: { id: string; verifier: string; expires: number };
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
          signal: AbortSignal.timeout(15_000),
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
          if (size > 2_000_000) throw new ConnectorError("INVALID_SOURCE");
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
        Date.parse(parsed.data.expiresAt) > this.now() + 31 * 86_400_000
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
  async read(meetingId: string) {
    if (this.busy) throw new ConnectorError("CONNECTION_BUSY");
    if (!z.uuid().safeParse(meetingId).success)
      throw new ConnectorError("INVALID_CONNECTION");
    const generation = this.generation,
      grant = await this.saved();
    if (grant.disconnectPending) throw new ConnectorError("CONNECTION_BUSY");
    if (Date.parse(grant.expiresAt) <= this.now())
      throw new ConnectorError("CONNECTION_EXPIRED");
    if (meetingId !== grant.meetingId)
      throw new ConnectorError("SOURCE_DENIED");
    const parsed = readSchema.safeParse(
      await this.post("read", { meetingId }, grant.token),
    );
    if (!parsed.success) throw new ConnectorError("INVALID_SOURCE");
    const result = parsed.data;
    const projection = JSON.stringify(result.meeting);
    if (
      result.grantId !== grant.grantId ||
      result.subjectId !== grant.subjectId ||
      result.workspaceId !== grant.workspaceId ||
      result.meeting.id !== meetingId ||
      Buffer.byteLength(projection) > 1024 * 1024 ||
      createHash("sha256").update(projection).digest("hex") !==
        result.projectionHash
    )
      throw new ConnectorError("INVALID_SOURCE");
    if (
      generation !== this.generation ||
      Date.parse(grant.expiresAt) <= this.now()
    )
      throw new ConnectorError("CONNECTION_EXPIRED");
    return result;
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
