import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AsyncEntry } from "@napi-rs/keyring";
import { z } from "zod";

const origin = "https://crm.bittrees.org";
const ids = z
  .array(z.uuid())
  .min(1)
  .max(100)
  .refine((v) => new Set(v).size === v.length);
const grantSchema = z.strictObject({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  grantId: z.uuid(),
  subjectId: z.uuid(),
  workspaceId: z.uuid(),
  recordIds: ids,
  actions: z.tuple([z.literal("read")]),
  expiresAt: z.iso.datetime(),
  policyRevision: z.literal("crm-ai-read-v1"),
});
const savedSchema = z.strictObject({
  owner: z.string().min(1).max(256),
  grant: grantSchema,
});
const text = z.string().max(4000),
  short = z.string().max(200);
const ref = z.union([z.uuid(), z.literal("")]);
const recordSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum([
    "people",
    "organizations",
    "opportunities",
    "projects",
    "tasks",
    "notes",
  ]),
  version: z.number().int().positive(),
  data: z.strictObject({
    name: short,
    email: z.string().max(320),
    organizationId: ref,
    personId: ref,
    projectId: ref,
    opportunityId: ref,
    ownerId: z.literal(""),
    title: short,
    website: z.string().max(4096),
    category: short,
    source: short,
    description: text,
    nextAction: short,
    dueDate: z.union([z.iso.date(), z.literal("")]),
    stage: z.enum([
      "Introduction",
      "Qualified",
      "Discovery",
      "Proposal",
      "Won",
      "Lost",
    ]),
    value: z.union([z.number().finite(), z.string().max(32)]),
    currency: z.string().regex(/^[A-Z]{3}$/),
    status: z.enum(["Open", "Done"]),
    wallet: z.string().max(42),
    communication: z.enum(["Unknown", "Allowed", "Do not contact"]),
  }),
});
const readSchema = z.strictObject({
  contractVersion: z.literal("1.0.0"),
  grantId: z.uuid(),
  subjectId: z.uuid(),
  workspaceId: z.uuid(),
  policyRevision: z.literal("crm-ai-read-v1"),
  records: z.array(recordSchema).min(1).max(100),
});
export interface ConnectorSecret {
  getSecret(): Promise<Uint8Array | undefined>;
  setSecret(value: Uint8Array): Promise<void>;
  deleteCredential(): Promise<boolean>;
}
export function crmKeychainEntry(profile: string): ConnectorSecret {
  if (process.platform !== "darwin" || !/^[A-Za-z0-9_-]{1,80}$/.test(profile))
    throw new Error("CRM credentials require a valid macOS profile");
  return new AsyncEntry("org.bittrees.ai.connector.crm", profile);
}
export class ConnectorError extends Error {
  constructor(
    public readonly code:
      | "CONNECTION_REQUIRED"
      | "CONNECTION_EXPIRED"
      | "CONNECTION_BUSY"
      | "INVALID_CONNECTION"
      | "SOURCE_UNAVAILABLE"
      | "SOURCE_DENIED"
      | "INVALID_SOURCE",
  ) {
    super(code);
  }
}
/** One explicit source identity per personal profile. No inference, writes or automatic reconnect. */
export class CrmConnector {
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
      return saved.grant;
    } catch {
      throw new ConnectorError("INVALID_CONNECTION");
    }
  }
  async status() {
    try {
      const { token: _token, ...grant } = await this.saved();
      return {
        ...grant,
        state:
          Date.parse(grant.expiresAt) <= this.now()
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
  private async post(path: "exchange" | "read", body: unknown, token?: string) {
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
          [401, 403, 404].includes(response.status)
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
  async read(recordIds: string[]) {
    const chosen = ids.safeParse(recordIds);
    if (!chosen.success) throw new ConnectorError("INVALID_CONNECTION");
    const generation = this.generation,
      grant = await this.saved();
    if (Date.parse(grant.expiresAt) <= this.now())
      throw new ConnectorError("CONNECTION_EXPIRED");
    if (recordIds.some((id) => !grant.recordIds.includes(id)))
      throw new ConnectorError("SOURCE_DENIED");
    const parsed = readSchema.safeParse(
      await this.post("read", { recordIds }, grant.token),
    );
    if (!parsed.success) throw new ConnectorError("INVALID_SOURCE");
    const result = parsed.data;
    if (
      result.grantId !== grant.grantId ||
      result.subjectId !== grant.subjectId ||
      result.workspaceId !== grant.workspaceId ||
      result.records.length !== recordIds.length ||
      new Set(result.records.map((r) => r.id)).size !== recordIds.length ||
      result.records.some(
        (r) =>
          !recordIds.includes(r.id) ||
          [
            r.data.organizationId,
            r.data.personId,
            r.data.projectId,
            r.data.opportunityId,
          ].some((ref) => ref && !recordIds.includes(ref)),
      )
    )
      throw new ConnectorError("INVALID_SOURCE");
    if (
      generation !== this.generation ||
      Date.parse(grant.expiresAt) <= this.now()
    )
      throw new ConnectorError("CONNECTION_EXPIRED");
    return result;
  }
  /** Local removal only. The source consent page must revoke the source grant. */
  async forgetLocal() {
    if (this.busy) throw new ConnectorError("CONNECTION_BUSY");
    this.busy = true;
    try {
      this.pending = undefined;
      this.generation++;
      await this.secret.deleteCredential();
    } finally {
      this.busy = false;
    }
  }
}
