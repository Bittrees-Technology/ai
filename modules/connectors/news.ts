import { randomUUID, createHash } from "node:crypto";
import { AsyncEntry } from "@napi-rs/keyring";
import { z } from "zod";
import { ConnectorError, type ConnectorSecret } from "./crm.js";

const endpoint = "https://news.bittrees.org/api/mcp";
const manageUrl = "https://news.bittrees.org/account/ai";
const keySchema = z.string().regex(/^tbn_[a-f0-9]{64}$/);
export const newsConnectionSchema = z.strictObject({
  contractVersion: z.literal("news-mcp-connection-v1"),
  credentialId: z.uuid(),
  accountId: z.uuid(),
  expiresAt: z.iso.datetime(),
  scopes: z
    .array(z.enum(["read", "curate", "publish", "delivery"]))
    .min(1)
    .max(4)
    .refine(
      (scopes) =>
        scopes.includes("read") && new Set(scopes).size === scopes.length,
    )
    .transform((scopes) => scopes.sort()),
});
const savedSchema = z.strictObject({
  owner: z.string().min(1).max(256),
  token: keySchema,
  setupId: z.uuid(),
  connection: newsConnectionSchema,
});
export type NewsConnection = z.infer<typeof newsConnectionSchema>;
const link = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  });
const article = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  source_id: z.string().min(1).max(256),
  title: z.string().min(1).max(2000),
  url: link,
  excerpt: z.string().max(32000),
  summary: z.string().max(16000).nullish(),
  summary_kind: z.string().max(100),
  topic: z.string().max(100),
  kind: z.string().max(100),
  published_at: z.iso.datetime(),
});
export type NewsArticle = z.infer<typeof article>;
const previewArticle = article.extend({
  user_edited: z.boolean().optional(),
  original_title: z.string().max(2000).optional(),
});
const sourcePreview = z.object({
  name: z.string().max(100),
  draft_revision: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER - 1),
  draft: z
    .object({
      front: z
        .array(previewArticle)
        .max(100)
        .refine(
          (items) => new Set(items.map((i) => i.id)).size === items.length,
        ),
      feeds: z.array(z.unknown()).max(100),
    })
    .nullable(),
});
export type NewsPreview = {
  name: string;
  revision: number;
  front: z.infer<typeof previewArticle>[];
  feedCount: number;
  exists: boolean;
  checkedAt: string;
};
const editInput = z.strictObject({
  revision: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER - 1),
  itemId: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().trim().min(1).max(250),
  summary: z.string().trim().max(2000),
});
export type NewsEditInput = z.infer<typeof editInput>;
export type NewsEditReview = {
  id: string;
  expiresAt: string;
  revision: number;
  name: string;
  before: z.infer<typeof previewArticle>;
  after: NewsEditInput;
  feedCount: number;
};
const previewFingerprint = (preview: NewsPreview) =>
  createHash("sha256")
    .update(JSON.stringify({ ...preview, checkedAt: undefined }))
    .digest("hex");

export function newsKeychainEntry(profile: string): ConnectorSecret {
  if (process.platform !== "darwin" || !/^[A-Za-z0-9_-]{1,80}$/.test(profile))
    throw Error("News credentials require a valid macOS profile");
  return new AsyncEntry("org.bittrees.ai.connector.news", profile);
}
/** Fixed News methods only. Curation requires an exact, expiring, explicitly confirmed review. */
export class NewsConnector {
  private editReview?: {
    review: NewsEditReview;
    fingerprint: string;
    saved: string;
    timer: ReturnType<typeof setTimeout>;
  };
  private clearEditReview() {
    if (this.editReview) clearTimeout(this.editReview.timer);
    this.editReview = undefined;
  }
  private active?: { kind: "read" | "write"; abort: AbortController };
  private pending?: {
    id: string;
    token: string;
    connection: NewsConnection;
    expires: number;
    timer: ReturnType<typeof setTimeout>;
  };
  constructor(
    private owner: string,
    private secret: ConnectorSecret,
    private transport: typeof fetch = fetch,
    private now = Date.now,
  ) {
    z.string().min(1).max(256).parse(owner);
  }
  private clearPending() {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = undefined;
  }
  private async operation<T>(
    kind: "read" | "write",
    fn: (signal: AbortSignal) => Promise<T>,
    interruptRead = false,
  ) {
    if (this.active) {
      if (!interruptRead || this.active.kind !== "read")
        throw new ConnectorError("CONNECTION_BUSY");
      this.active.abort.abort();
    }
    const active = { kind, abort: new AbortController() };
    this.active = active;
    try {
      return await fn(active.abort.signal);
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }
  private async saved() {
    const raw = await this.secret.getSecret();
    if (!raw) return null;
    try {
      if (raw.length > 8192) throw Error();
      const value = savedSchema.parse(
        JSON.parse(Buffer.from(raw).toString("utf8")),
      );
      if (value.owner !== this.owner) throw Error();
      return value;
    } catch {
      throw new ConnectorError("INVALID_CONNECTION");
    }
  }
  private current(connection: NewsConnection) {
    if (Date.parse(connection.expiresAt) <= this.now())
      throw new ConnectorError("CONNECTION_EXPIRED");
  }
  async status() {
    const value = await this.saved();
    return {
      manageUrl,
      mode: "read_only" as const,
      curation: "per_action_review" as const,
      connection: value
        ? {
            ...value.connection,
            state:
              Date.parse(value.connection.expiresAt) <= this.now()
                ? ("expired" as const)
                : ("stored" as const),
          }
        : null,
    };
  }
  private async rpc(
    token: string,
    method: "initialize" | "notifications/initialized" | "tools/call",
    params: unknown,
    signal: AbortSignal,
    limit = 16384,
  ): Promise<any> {
    const id =
      method === "notifications/initialized" ? undefined : randomUUID();
    try {
      signal.throwIfAborted();
      const response = await this.transport(endpoint, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          ...(id ? { id } : {}),
          method,
          params,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
      });
      signal.throwIfAborted();
      if (response.status === 401 || response.status === 403)
        throw new ConnectorError("SOURCE_DENIED");
      if (!response.ok) throw new ConnectorError("SOURCE_UNAVAILABLE");
      if (response.redirected || (response.url && response.url !== endpoint))
        throw new ConnectorError("INVALID_SOURCE");
      if (!id) {
        if (response.status !== 202) throw new ConnectorError("INVALID_SOURCE");
        await response.body?.cancel();
        return;
      }
      if (
        !/^application\/json(?:\s*;|$)/i.test(
          response.headers.get("content-type") ?? "",
        )
      )
        throw new ConnectorError("INVALID_SOURCE");
      const reader = response.body?.getReader();
      if (!reader) throw new ConnectorError("INVALID_SOURCE");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          signal.throwIfAborted();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > limit) throw new ConnectorError("SOURCE_CAPACITY");
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        body.jsonrpc !== "2.0" ||
        body.id !== id ||
        body.error ||
        !body.result ||
        body.result.isError
      )
        throw new ConnectorError("INVALID_SOURCE");
      return body.result;
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError("SOURCE_UNAVAILABLE");
    }
  }
  private async metadata(token: string, signal: AbortSignal) {
    const result = await this.rpc(
      token,
      "tools/call",
      { name: "get_connection", arguments: {} },
      signal,
    );
    try {
      const content = z
        .array(
          z.strictObject({
            type: z.literal("text"),
            text: z.string().max(8192),
          }),
        )
        .length(1)
        .parse(result.content);
      const connection = newsConnectionSchema.parse(
        JSON.parse(content[0]!.text),
      );
      this.current(connection);
      return connection;
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError("INVALID_SOURCE");
    }
  }
  private async handshake(token: string, signal: AbortSignal) {
    const init = await this.rpc(
      token,
      "initialize",
      {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "Bittrees AI read-only News", version: "0.1.0" },
      },
      signal,
    );
    if (init.protocolVersion !== "2025-11-25" || !init.capabilities?.tools)
      throw new ConnectorError("INVALID_SOURCE");
    await this.rpc(token, "notifications/initialized", {}, signal);
  }
  async prepare(raw: unknown) {
    const input = z.strictObject({ token: keySchema }).parse(raw);
    return this.operation("write", async (signal) => {
      this.clearPending();
      if (await this.saved()) throw new ConnectorError("INVALID_CONNECTION");
      await this.handshake(input.token, signal);
      const connection = await this.metadata(input.token, signal),
        id = randomUUID(),
        expires = Math.min(
          this.now() + 120000,
          Date.parse(connection.expiresAt),
        );
      if (await this.saved()) throw new ConnectorError("INVALID_CONNECTION");
      const timer = setTimeout(
        () => {
          if (this.pending?.id === id) this.clearPending();
        },
        Math.max(1, expires - this.now()),
      );
      timer.unref();
      this.pending = { id, token: input.token, connection, expires, timer };
      return {
        id,
        connection,
        reviewExpiresAt: new Date(expires).toISOString(),
        mode: "read_only" as const,
      };
    });
  }
  async confirm(raw: unknown) {
    const input = z
      .strictObject({ id: z.uuid(), confirmed: z.literal(true) })
      .parse(raw);
    return this.operation("write", async (signal) => {
      const existing = await this.saved();
      if (existing?.setupId === input.id) return this.status();
      const pending = this.pending;
      if (
        !pending ||
        pending.id !== input.id ||
        pending.expires <= this.now()
      ) {
        this.clearPending();
        throw new ConnectorError("CONNECTION_EXPIRED");
      }
      const current = await this.metadata(pending.token, signal);
      if (
        JSON.stringify(current) !== JSON.stringify(pending.connection) ||
        pending.expires <= this.now()
      )
        throw new ConnectorError("SOURCE_CONFLICT");
      if (await this.saved()) throw new ConnectorError("INVALID_CONNECTION");
      const value = {
        owner: this.owner,
        token: pending.token,
        setupId: input.id,
        connection: current,
      };
      await this.secret.setSecret(Buffer.from(JSON.stringify(value)));
      if (JSON.stringify(await this.saved()) !== JSON.stringify(value))
        throw new ConnectorError("INVALID_CONNECTION");
      this.clearPending();
      return this.status();
    });
  }
  async cancel() {
    if (this.active?.kind === "write")
      throw new ConnectorError("CONNECTION_BUSY");
    this.clearPending();
    this.clearEditReview();
  }
  async read() {
    return this.operation("read", async (signal) => {
      const saved = await this.saved();
      if (!saved) throw new ConnectorError("CONNECTION_REQUIRED");
      this.current(saved.connection);
      await this.handshake(saved.token, signal);
      const validate = async () => {
        const current = await this.metadata(saved.token, signal);
        if (JSON.stringify(current) !== JSON.stringify(saved.connection))
          throw new ConnectorError("SOURCE_CONFLICT");
      };
      await validate();
      const result = await this.rpc(
        saved.token,
        "tools/call",
        { name: "list_articles", arguments: {} },
        signal,
        8 * 1024 * 1024,
      );
      let items: NewsArticle[];
      try {
        const content = z
          .array(z.strictObject({ type: z.literal("text"), text: z.string() }))
          .length(1)
          .parse(result.content);
        items = z
          .array(article)
          .max(100)
          .refine(
            (rows) => new Set(rows.map((row) => row.id)).size === rows.length,
          )
          .parse(JSON.parse(content[0]!.text));
      } catch {
        throw new ConnectorError("INVALID_SOURCE");
      }
      await validate();
      if (JSON.stringify(await this.saved()) !== JSON.stringify(saved))
        throw new ConnectorError("SOURCE_CONFLICT");
      signal.throwIfAborted();
      this.current(saved.connection);
      return {
        accountId: saved.connection.accountId,
        credentialId: saved.connection.credentialId,
        checkedAt: new Date(this.now()).toISOString(),
        items,
        mode: "read_only" as const,
      };
    });
  }
  private async checkedSaved(signal: AbortSignal, curate = false) {
    const saved = await this.saved();
    if (!saved) throw new ConnectorError("CONNECTION_REQUIRED");
    this.current(saved.connection);
    if (curate && !saved.connection.scopes.includes("curate"))
      throw new ConnectorError("CURATION_REQUIRED");
    await this.handshake(saved.token, signal);
    await this.verifySaved(saved, signal);
    return saved;
  }
  private async verifySaved(
    saved: z.infer<typeof savedSchema>,
    signal: AbortSignal,
  ) {
    const current = await this.metadata(saved.token, signal);
    if (
      JSON.stringify(current) !== JSON.stringify(saved.connection) ||
      JSON.stringify(await this.saved()) !== JSON.stringify(saved)
    )
      throw new ConnectorError("SOURCE_CONFLICT");
    this.current(saved.connection);
    signal.throwIfAborted();
  }
  private parsePreview(result: any): NewsPreview {
    try {
      const content = z
        .array(z.strictObject({ type: z.literal("text"), text: z.string() }))
        .length(1)
        .parse(result.content);
      const value = sourcePreview.parse(JSON.parse(content[0]!.text));
      return {
        name: value.name,
        revision: value.draft_revision,
        front: value.draft?.front ?? [],
        feedCount: value.draft?.feeds.length ?? 0,
        exists: !!value.draft,
        checkedAt: new Date(this.now()).toISOString(),
      };
    } catch {
      throw new ConnectorError("INVALID_SOURCE");
    }
  }
  private async fetchPreview(token: string, signal: AbortSignal) {
    return this.parsePreview(
      await this.rpc(
        token,
        "tools/call",
        { name: "get_preview", arguments: {} },
        signal,
        8 * 1024 * 1024,
      ),
    );
  }
  async preview() {
    return this.operation("read", async (signal) => {
      this.clearEditReview();
      const saved = await this.checkedSaved(signal),
        value = await this.fetchPreview(saved.token, signal);
      await this.verifySaved(saved, signal);
      return value;
    });
  }
  async reviewEdit(raw: unknown) {
    const input = editInput.parse(raw);
    return this.operation("read", async (signal) => {
      this.clearEditReview();
      const saved = await this.checkedSaved(signal, true),
        preview = await this.fetchPreview(saved.token, signal);
      await this.verifySaved(saved, signal);
      const before = preview.front.find((item) => item.id === input.itemId);
      if (!before || preview.revision !== input.revision)
        throw new ConnectorError("SOURCE_CONFLICT");
      if (
        before.title === input.title &&
        (before.summary ?? before.excerpt) === input.summary
      )
        throw new ConnectorError("NO_CHANGE");
      const id = randomUUID(),
        expires = Math.min(
          this.now() + 120000,
          Date.parse(saved.connection.expiresAt),
        );
      const review: NewsEditReview = {
        id,
        expiresAt: new Date(expires).toISOString(),
        revision: preview.revision,
        name: preview.name,
        before,
        after: input,
        feedCount: preview.feedCount,
      };
      const timer = setTimeout(
        () => {
          if (this.editReview?.review.id === id) this.clearEditReview();
        },
        Math.max(1, expires - this.now()),
      );
      timer.unref();
      this.editReview = {
        review,
        fingerprint: previewFingerprint(preview),
        saved: JSON.stringify(saved),
        timer,
      };
      return review;
    });
  }
  async confirmEdit(raw: unknown) {
    const input = z
      .strictObject({
        id: z.uuid(),
        confirmed: z.literal(true),
        curate: z.literal(true),
      })
      .parse(raw);
    return this.operation("write", async (signal) => {
      const pending = this.editReview;
      // Consume before any await. Duplicate requests cannot invoke the write twice.
      this.clearEditReview();
      if (
        !pending ||
        pending.review.id !== input.id ||
        Date.parse(pending.review.expiresAt) <= this.now()
      )
        throw new ConnectorError("REVIEW_EXPIRED");
      const saved = await this.checkedSaved(signal, true);
      if (JSON.stringify(saved) !== pending.saved)
        throw new ConnectorError("SOURCE_CONFLICT");
      const current = await this.fetchPreview(saved.token, signal);
      if (previewFingerprint(current) !== pending.fingerprint)
        throw new ConnectorError("SOURCE_CONFLICT");
      await this.verifySaved(saved, signal);
      if (Date.parse(pending.review.expiresAt) <= this.now())
        throw new ConnectorError("REVIEW_EXPIRED");
      try {
        const result = this.parsePreview(
          await this.rpc(
            saved.token,
            "tools/call",
            { name: "edit_preview_item", arguments: pending.review.after },
            signal,
            8 * 1024 * 1024,
          ),
        );
        const after = pending.review.after;
        const expected = current.front.map((item) =>
          item.id === after.itemId
            ? {
                ...item,
                title: after.title,
                summary: after.summary,
                user_edited: true,
                summary_kind: "user_edited",
                original_title: item.original_title || item.title,
              }
            : item,
        );
        if (
          result.revision !== current.revision + 1 ||
          result.name !== current.name ||
          result.feedCount !== current.feedCount ||
          !result.exists ||
          JSON.stringify(result.front) !==
            JSON.stringify(expected.map((item) => previewArticle.parse(item)))
        )
          throw new ConnectorError("INVALID_SOURCE");
        await this.verifySaved(saved, signal);
        return { saved: true, published: false, preview: result };
      } catch {
        // Source may already have committed. Reconcile with an explicit fresh read, never retry this write.
        throw new ConnectorError("NEWS_SAVE_UNCONFIRMED");
      }
    });
  }
  async forget(raw: unknown) {
    z.strictObject({ confirmed: z.literal(true) }).parse(raw);
    return this.operation(
      "write",
      async () => {
        this.clearPending();
        this.clearEditReview();
        await this.secret.deleteCredential();
        if (await this.secret.getSecret())
          throw new ConnectorError("INVALID_CONNECTION");
        return { removed: true, sourceRevoked: false, manageUrl };
      },
      true,
    );
  }
}
