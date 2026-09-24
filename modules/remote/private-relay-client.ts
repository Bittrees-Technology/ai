import {
  privateRelayGrantSchema,
  privateRelayApprovalSchema,
  privateRelayRevisionSchema,
  privateRelayEndpointLookupSchema,
  privateRelayEndpointInspectionSchema,
  privateRelayPermissionPageSchema,
} from "./private-relay-enrollment.js";
import { privateBindingSchema } from "./private-peer-contracts.js";
import { z } from "zod";
import { privateEnvelopeSchema } from "./private-envelope.js";
import {
  privateRelayIdentitySchema,
  privateRelayRecipientSchema,
  privateRelaySubmitSchema,
  privateRelayPageSchema,
  privateRelayAcknowledgeSchema,
  privateRelayDeleteSchema,
  privateRelayStorageReceiptSchema,
  privateRelayEnvelopeHash,
} from "./private-relay-contracts.js";
const origin = "https://ai.bittrees.org";
const scope = z.string().min(1).max(1024);
const endpointContext = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("browser"),
      scope,
      identity: privateRelayIdentitySchema,
    }),
    z.strictObject({
      kind: z.literal("mac"),
      scope,
      identity: privateRelayIdentitySchema,
      credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    }),
  ])
  .refine((c) => c.kind === c.identity.endpointKind);
export type PrivateRelayClientContext = z.infer<typeof endpointContext>;
const ownerContext = z.strictObject({ ownerId: z.uuid(), scope });
export type PrivateRelayOwnerContext = z.infer<typeof ownerContext>;
const mutation = z.strictObject({
  receipt: privateRelayStorageReceiptSchema,
  duplicate: z.boolean(),
});
const cursor = privateRelayPageSchema.shape.after;
const pollResponse = z.strictObject({
  items: z
    .array(
      z.strictObject({
        receipt: privateRelayStorageReceiptSchema,
        envelope: privateEnvelopeSchema,
      }),
    )
    .max(20),
  nextCursor: cursor,
});
const exportResponse = z.strictObject({
  version: z.literal(1),
  restoreAuthority: z.literal(false),
  items: z
    .array(
      z.strictObject({
        receipt: privateRelayStorageReceiptSchema,
        senderId: z.uuid(),
        recipientId: z.uuid(),
        envelope: privateEnvelopeSchema.nullable(),
      }),
    )
    .max(20),
  nextCursor: cursor,
});
const lookup = z.strictObject({ messageId: z.uuid() });
const invalid = () => Error("INVALID_RESPONSE");
function parsed<T>(schema: z.ZodType<T>, raw: unknown): T {
  const p = schema.safeParse(raw);
  if (!p.success) throw invalid();
  return p.data;
}
function input<T>(schema: z.ZodType<T>, raw: unknown): T {
  const p = schema.safeParse(raw);
  if (!p.success) throw Error("INVALID_INPUT");
  return p.data;
}
const stamp = (x: unknown) => JSON.stringify(x);
const greater = (
  a: { storedAt: number; messageId: string },
  b: { storedAt: number; messageId: string },
) =>
  a.storedAt > b.storedAt ||
  (a.storedAt === b.storedAt && a.messageId > b.messageId);
/** Request-local bounds and invalidation only; no cookie reading, secret storage,
 * retries, scheduler, acknowledgement or endpoint task authority. */
class Requests<C> {
  private generation = 0;
  private active: AbortController | null = null;
  constructor(
    private current: () => C | null,
    private schema: z.ZodType<C>,
    private transport: typeof fetch,
    private now: () => number,
    private monotonic: () => number,
  ) {}
  invalidate() {
    this.generation++;
    this.active?.abort();
  }
  async operation<T>(
    fn: (
      context: C,
      check: (expiresAt?: number) => void,
      post: (
        path: string,
        body: unknown,
        headers: Record<string, string>,
        browser: boolean,
        limit?: number,
      ) => Promise<unknown>,
    ) => Promise<T>,
  ): Promise<T> {
    if (this.active) throw Error("BUSY");
    const controller = new AbortController(),
      generation = ++this.generation,
      start = this.now(),
      mono = this.monotonic();
    this.active = controller;
    try {
      const initial = this.schema.safeParse(this.current());
      if (!initial.success) throw Error("DENIED");
      const c = initial.data,
        snapshot = stamp(c);
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(15000),
      ]);
      const check = (expiresAt = Number.MAX_SAFE_INTEGER) => {
        const current = this.schema.safeParse(this.current()),
          time = this.now(),
          elapsed = this.monotonic() - mono;
        if (
          signal.aborted ||
          generation !== this.generation ||
          !current.success ||
          stamp(current.data) !== snapshot ||
          !Number.isSafeInteger(start) ||
          start <= 0 ||
          !Number.isSafeInteger(time) ||
          time < start ||
          time >= Math.min(expiresAt, start + 30000) ||
          !Number.isFinite(elapsed) ||
          elapsed < 0 ||
          elapsed >= 30000
        )
          throw Error("DENIED");
      };
      const untilAbort = <V>(promise: Promise<V>): Promise<V> =>
        new Promise((resolve, reject) => {
          const abort = () => reject(Error("UNAVAILABLE"));
          if (signal.aborted) {
            reject(Error("UNAVAILABLE"));
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
          promise
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", abort));
        });
      const post = async (
        path: string,
        body: unknown,
        headers: Record<string, string>,
        browser: boolean,
        limit = 32768,
      ) => {
        check();
        const url = origin + path;
        let response: Response;
        try {
          response = await untilAbort(
            this.transport(url, {
              method: "POST",
              credentials: browser ? "same-origin" : "omit",
              redirect: "error",
              cache: "no-store",
              headers: { "Content-Type": "application/json", ...headers },
              body: JSON.stringify(body),
              signal,
            }).then((r) => {
              if (signal.aborted) void r.body?.cancel().catch(() => {});
              return r;
            }),
          );
        } catch {
          check();
          throw Error("UNAVAILABLE");
        }
        const cancel = () => {
          void response.body?.cancel().catch(() => {});
        };
        try {
          check();
        } catch (e) {
          cancel();
          throw e;
        }
        if (
          response.redirected ||
          (response.url && response.url !== url) ||
          response.headers
            .get("content-type")
            ?.split(";")[0]
            ?.trim()
            .toLowerCase() !== "application/json"
        ) {
          cancel();
          throw invalid();
        }
        if (!response.ok) {
          cancel();
          throw Error(
            response.status === 409
              ? "CONFLICT"
              : response.status === 429
                ? "CAPACITY"
                : response.status >= 500
                  ? "UNAVAILABLE"
                  : "DENIED",
          );
        }
        const declared = response.headers.get("content-length");
        if (
          declared !== null &&
          (!/^\d+$/.test(declared) || Number(declared) > limit)
        ) {
          cancel();
          throw invalid();
        }
        const reader = response.body?.getReader();
        if (!reader) throw invalid();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          while (true) {
            const r = await untilAbort(reader.read());
            check();
            if (r.done) break;
            length += r.value.length;
            if (length > limit) throw invalid();
            chunks.push(r.value);
          }
        } finally {
          void reader.cancel().catch(() => {});
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        try {
          return JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          );
        } catch {
          throw invalid();
        }
      };
      check();
      const result = await fn(c, check, post);
      check();
      return result;
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      throw Error(
        [
          "DENIED",
          "INVALID_INPUT",
          "INVALID_RESPONSE",
          "CONFLICT",
          "CAPACITY",
          "UNAVAILABLE",
        ].includes(code)
          ? code
          : "UNAVAILABLE",
      );
    } finally {
      controller.abort();
      this.active = null;
      this.generation++;
    }
  }
}
function receipt(raw: unknown, now: number, id?: string) {
  const r = parsed(privateRelayStorageReceiptSchema, raw);
  if (
    (id && r.messageId !== id) ||
    r.storedAt > now ||
    (r.state === "stored" ? r.revision !== 1 : r.revision < 2)
  )
    throw invalid();
  return r;
}
function pageCheck(
  items: Array<{ receipt: z.infer<typeof privateRelayStorageReceiptSchema> }>,
  next: z.infer<typeof cursor>,
  request: z.infer<typeof privateRelayPageSchema>,
  now: number,
) {
  if (
    items.length > request.limit ||
    (next && (items.length !== request.limit || !items.length))
  )
    throw invalid();
  const ids = new Set<string>();
  let previous = request.after;
  for (const item of items) {
    const r = receipt(item.receipt, now),
      position = { storedAt: r.storedAt, messageId: r.messageId };
    if (ids.has(r.messageId) || (previous && !greater(position, previous)))
      throw invalid();
    ids.add(r.messageId);
    previous = position;
  }
  if (next && stamp(next) !== stamp(previous)) throw invalid();
}
async function bindEnvelope(
  envelope: z.infer<typeof privateEnvelopeSchema>,
  r: z.infer<typeof privateRelayStorageReceiptSchema>,
  ownerId: string,
) {
  if (
    envelope.header.ownerId !== ownerId ||
    envelope.header.messageId !== r.messageId ||
    (await privateRelayEnvelopeHash(envelope)) !== r.envelopeHash
  )
    throw invalid();
}
/** Explicit transport for an already granted endpoint. The trusted host supplies
 * current context and invalidates it on lock/logout/registration/grant changes. */
export class PrivateRelayClient {
  private requests: Requests<PrivateRelayClientContext>;
  constructor(
    current: () => PrivateRelayClientContext | null,
    transport: typeof fetch = (...args) => globalThis.fetch(...args),
    private now = Date.now,
    monotonic = () => performance.now(),
  ) {
    this.requests = new Requests(
      current,
      endpointContext,
      transport,
      now,
      monotonic,
    );
  }
  invalidate() {
    this.requests.invalidate();
  }
  private operation<T>(
    fn: (
      c: PrivateRelayClientContext,
      check: () => void,
      post: (name: string, body: unknown, limit?: number) => Promise<unknown>,
    ) => Promise<T>,
  ) {
    return this.requests.operation(async (c, guard, request) => {
      const check = () => guard(c.identity.expiresAt);
      check();
      const headers: Record<string, string> =
        c.kind === "browser"
          ? {
              "X-Bittrees-Request": "1",
              "X-Bittrees-Account": c.identity.ownerId,
            }
          : { Authorization: "Bearer " + c.credential };
      headers["X-Bittrees-Relay-Permission"] = c.identity.permissionId;
      const post = (name: string, body: unknown, limit?: number) =>
        request(
          "/" +
            (c.kind === "browser" ? "browser" : "device") +
            "/relay/messages/" +
            name,
          body,
          headers,
          c.kind === "browser",
          limit,
        );
      const result = await fn(c, check, post);
      check();
      return result;
    });
  }
  /** Readiness metadata only. Submission revalidates both grants in its transaction. */
  async recipient(raw: unknown) {
    const body = input(privateRelayRecipientSchema, raw);
    return this.operation(async (c, _check, post) => {
      if (body.endpointId === c.identity.endpointId) throw Error("DENIED");
      const target = parsed(
        privateRelayIdentitySchema,
        await post("recipient", body),
      );
      if (
        target.ownerId !== c.identity.ownerId ||
        target.endpointId !== body.endpointId ||
        target.endpointKind === c.identity.endpointKind ||
        target.permissionId === c.identity.permissionId ||
        target.expiresAt <= this.now()
      )
        throw invalid();
      return target;
    });
  }
  /** Optional trusted host guard runs after async hashing immediately before
   * network submission and on response; it cannot come from a wire payload. */
  async submit(raw: unknown, sourceCheck: () => void = () => {}) {
    const body = input(privateRelaySubmitSchema, raw);
    return this.operation(async (c, check, post) => {
      const h = body.envelope.header;
      if (
        h.ownerId !== c.identity.ownerId ||
        h.senderId !== c.identity.endpointId ||
        h.recipientId === h.senderId ||
        h.expiresAt <= this.now() ||
        h.expiresAt > c.identity.expiresAt
      )
        throw Error("DENIED");
      sourceCheck();
      const hash = await privateRelayEnvelopeHash(body.envelope);
      check();
      sourceCheck();
      const result = parsed(mutation, await post("submit", body));
      sourceCheck();
      const r = receipt(result.receipt, this.now(), h.messageId);
      if (
        r.envelopeHash !== hash ||
        (!result.duplicate && (r.state !== "stored" || r.revision !== 1))
      )
        throw invalid();
      return result;
    });
  }
  async inspect(raw: unknown) {
    const body = input(lookup, raw);
    return this.operation(async (_c, _check, post) =>
      receipt(await post("inspect", body), this.now(), body.messageId),
    );
  }
  async poll(raw: unknown) {
    const body = input(privateRelayPageSchema, raw);
    return this.operation(async (c, check, post) => {
      const result = parsed(
        pollResponse,
        await post("poll", body, 2 * 1024 * 1024),
      );
      pageCheck(result.items, result.nextCursor, body, this.now());
      for (const item of result.items) {
        const h = item.envelope.header;
        if (
          item.receipt.state !== "stored" ||
          h.recipientId !== c.identity.endpointId ||
          h.senderId === h.recipientId ||
          h.issuedAt > this.now() + 30000 ||
          h.expiresAt <= this.now() ||
          h.expiresAt <= h.issuedAt ||
          h.expiresAt - h.issuedAt > 86400000 ||
          h.expiresAt > c.identity.expiresAt
        )
          throw invalid();
        await bindEnvelope(item.envelope, item.receipt, c.identity.ownerId);
        check();
      }
      if (result.items.some((i) => i.envelope.header.expiresAt <= this.now()))
        throw Error("DENIED");
      return result;
    });
  }
  async acknowledge(raw: unknown) {
    const body = input(privateRelayAcknowledgeSchema, raw);
    return this.operation(async (_c, _check, post) => {
      const result = parsed(mutation, await post("acknowledge", body)),
        r = receipt(result.receipt, this.now(), body.messageId);
      if (
        r.envelopeHash !== body.envelopeHash ||
        r.state === "stored" ||
        r.revision < body.expectedRevision + 1 ||
        (!result.duplicate &&
          (r.state !== "received" || r.revision !== body.expectedRevision + 1))
      )
        throw invalid();
      return result;
    });
  }
  async delete(raw: unknown) {
    const body = input(privateRelayDeleteSchema, raw);
    return this.operation(async (_c, _check, post) => {
      const result = parsed(mutation, await post("delete", body)),
        r = receipt(result.receipt, this.now(), body.messageId);
      if (r.state !== "deleted" || r.revision !== body.expectedRevision + 1)
        throw invalid();
      return result;
    });
  }
}
/** Owner maintenance does not depend on a still-active endpoint relay grant. */
export class PrivateRelayOwnerClient {
  private requests: Requests<PrivateRelayOwnerContext>;
  constructor(
    current: () => PrivateRelayOwnerContext | null,
    transport: typeof fetch = (...args) => globalThis.fetch(...args),
    private now = Date.now,
    monotonic = () => performance.now(),
  ) {
    this.requests = new Requests(
      current,
      ownerContext,
      transport,
      now,
      monotonic,
    );
  }
  invalidate() {
    this.requests.invalidate();
  }
  async export(raw: unknown) {
    const body = input(privateRelayPageSchema, raw);
    return this.requests.operation(async (c, check, post) => {
      const result = parsed(
        exportResponse,
        await post(
          "/browser/relay/history/export",
          body,
          { "X-Bittrees-Request": "1", "X-Bittrees-Account": c.ownerId },
          true,
          2 * 1024 * 1024,
        ),
      );
      pageCheck(result.items, result.nextCursor, body, this.now());
      for (const item of result.items) {
        if (item.senderId === item.recipientId) throw invalid();
        if (item.envelope) {
          if (
            item.envelope.header.senderId !== item.senderId ||
            item.envelope.header.recipientId !== item.recipientId ||
            item.receipt.state === "deleted"
          )
            throw invalid();
          await bindEnvelope(item.envelope, item.receipt, c.ownerId);
        } else if (item.receipt.state === "stored") throw invalid();
        check();
      }
      return result;
    });
  }
  async delete(raw: unknown) {
    const body = input(privateRelayDeleteSchema, raw);
    return this.requests.operation(async (c, _check, post) => {
      const result = parsed(
          mutation,
          await post(
            "/browser/relay/history/delete",
            body,
            { "X-Bittrees-Request": "1", "X-Bittrees-Account": c.ownerId },
            true,
          ),
        ),
        r = receipt(result.receipt, this.now(), body.messageId);
      if (r.state !== "deleted" || r.revision !== body.expectedRevision + 1)
        throw invalid();
      return result;
    });
  }
}

/** Explicit owner-scoped permission metadata. No cookie reads, native acceptance,
 * secrets, automatic retries, registration, task consent or message transport. */
export class BrowserRelayPermissionsClient {
  private requests: Requests<PrivateRelayOwnerContext>;
  constructor(
    current: () => PrivateRelayOwnerContext | null,
    transport: typeof fetch = (...args) => globalThis.fetch(...args),
    private now = Date.now,
    monotonic = () => performance.now(),
  ) {
    this.requests = new Requests(
      current,
      ownerContext,
      transport,
      now,
      monotonic,
    );
  }
  invalidate() {
    this.requests.invalidate();
  }
  private operation<T>(
    action: (
      ownerId: string,
      post: (path: string, body: unknown) => Promise<unknown>,
      check: (until?: number) => void,
    ) => Promise<T>,
  ) {
    return this.requests.operation(async (c, check, post) =>
      action(
        c.ownerId,
        (path, body) =>
          post(
            "/browser/relay/" + path,
            body,
            { "X-Bittrees-Request": "1", "X-Bittrees-Account": c.ownerId },
            true,
          ),
        check,
      ),
    );
  }
  private grant(raw: unknown, ownerId: string) {
    const g = parsed(privateRelayGrantSchema, raw);
    if (
      g.ownerId !== ownerId ||
      g.createdAt > this.now() ||
      (g.revokedAt !== null && g.revokedAt > this.now())
    )
      throw invalid();
    return g;
  }
  inspectBrowser(rawBinding: unknown) {
    const binding = input(privateBindingSchema, rawBinding);
    return this.operation(async (ownerId, post, check) => {
      if (binding.ownerId !== ownerId) throw Error("DENIED");
      check(binding.expiresAt);
      const raw = await post("permission/inspect", {});
      check(binding.expiresAt);
      if (raw === null) return null;
      const g = this.grant(raw, ownerId);
      if (
        g.endpointKind !== "browser" ||
        g.endpointId !== binding.deviceId ||
        g.credentialEpoch !== binding.credentialEpoch ||
        g.state !== "active"
      )
        throw invalid();
      return g;
    });
  }
  inspectEndpoint(raw: unknown) {
    const request = input(privateRelayEndpointLookupSchema, raw);
    return this.operation(async (ownerId, post, check) => {
      const result = parsed(
        privateRelayEndpointInspectionSchema,
        await post("permissions/endpoint", request),
      );
      const e = result.endpoint;
      if (
        e.ownerId !== ownerId ||
        e.endpointId !== request.endpointId ||
        e.endpointKind !== request.endpointKind ||
        e.credentialEpoch !== request.credentialEpoch
      )
        throw invalid();
      check(e.expiresAt);
      if (result.permission) this.grant(result.permission, ownerId);
      return result;
    });
  }
  inspect(id: string) {
    return this.lookup(
      "inspect",
      input(z.strictObject({ id: z.uuid() }), { id }),
    );
  }
  inspectOperation(operationId: string) {
    return this.lookup(
      "operation",
      input(z.strictObject({ operationId: z.uuid() }), { operationId }),
    );
  }
  private lookup(
    path: "inspect" | "operation",
    request: { id?: string; operationId?: string },
  ) {
    return this.operation(async (ownerId, post) => {
      const g = this.grant(await post("permissions/" + path, request), ownerId);
      if (
        (request.id && g.id !== request.id) ||
        (request.operationId && g.operationId !== request.operationId)
      )
        throw invalid();
      return g;
    });
  }
  list(raw: unknown) {
    const request = input(privateRelayPermissionPageSchema, raw);
    return this.operation(async (ownerId, post) => {
      const result = parsed(
        z.strictObject({
          items: z.array(privateRelayGrantSchema).max(50),
          nextCursor: z.uuid().nullable(),
        }),
        await post("permissions/list", request),
      );
      if (
        result.items.length > request.limit ||
        (result.nextCursor && result.items.length !== request.limit)
      )
        throw invalid();
      let previous = request.after;
      for (const item of result.items) {
        this.grant(item, ownerId);
        if (previous && item.id <= previous) throw invalid();
        previous = item.id;
      }
      if (result.nextCursor && result.nextCursor !== previous) throw invalid();
      return result;
    });
  }
  enableBrowser(raw: unknown) {
    return this.approve("browser", raw);
  }
  approveMac(raw: unknown) {
    return this.approve("mac", raw);
  }
  private approve(kind: "browser" | "mac", raw: unknown) {
    const request = input(privateRelayApprovalSchema, raw);
    return this.operation(async (ownerId, post, check) => {
      check(request.expiresAt);
      const g = this.grant(
        await post(
          kind === "browser" ? "permission/enable" : "mac/approve",
          request,
        ),
        ownerId,
      );
      check(request.expiresAt);
      if (
        g.operationId !== request.operationId ||
        g.endpointKind !== kind ||
        g.endpointId !== request.deviceId ||
        g.credentialEpoch !== request.credentialEpoch ||
        g.expiresAt !== request.expiresAt ||
        g.revision !== 1 ||
        g.id === request.expected?.id ||
        g.state !== (kind === "browser" ? "active" : "pending") ||
        (g.approvalExpiresAt !== null &&
          g.approvalExpiresAt > Math.min(g.createdAt + 120000, g.expiresAt))
      )
        throw invalid();
      return g;
    });
  }
  revoke(raw: unknown) {
    const request = input(privateRelayRevisionSchema, raw);
    return this.operation(async (ownerId, post) => {
      const g = this.grant(await post("permissions/revoke", request), ownerId);
      if (
        g.id !== request.id ||
        g.state !== "revoked" ||
        ![request.expectedRevision, request.expectedRevision + 1].includes(
          g.revision,
        )
      )
        throw invalid();
      return g;
    });
  }
}
