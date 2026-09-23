import { z } from "zod";
import {
  privateBindingSchema,
  type PrivateBinding,
} from "./private-peer-contracts.js";
import {
  browserDeviceInspectionSchema,
  browserDeviceIdentitySchema,
  browserDeviceRegisterSchema,
  browserDeviceRevokeSchema,
  browserDevicePageSchema,
  type BrowserDeviceIdentity,
  type VerifiedBrowserDeviceScope,
} from "./browser-device-contracts.js";
const contextSchema = z.strictObject({
  ownerId: z.uuid(),
  scope: z.string().min(1).max(1024),
});
export type BrowserDeviceContext = z.infer<typeof contextSchema>;
const origin = "https://ai.bittrees.org";
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
/** Explicit same-origin browser operations. Cookie credentials are HttpOnly and
 * never read by this client. The host must invalidate on logout/lock/scope change. */
export class BrowserDeviceClient {
  private generation = 0;
  private busy = false;
  private fresh: {
    binding: PrivateBinding;
    context: string;
    at: number;
    monotonicAt: number;
    until: number;
    monotonicUntil: number;
  } | null = null;
  constructor(
    private context: () => BrowserDeviceContext | null,
    private transport: typeof fetch = fetch,
    private now = Date.now,
    private monotonic = () => performance.now(),
  ) {}
  invalidate() {
    this.generation++;
    this.fresh = null;
  }
  private ctx() {
    const p = contextSchema.safeParse(this.context());
    if (!p.success) throw Error("DENIED");
    return p.data;
  }
  private async post(path: string, body: unknown, ownerId: string) {
    try {
      return await this.request(path, body, ownerId);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      throw Error(
        ["DENIED", "CONFLICT", "CAPACITY", "INVALID_RESPONSE"].includes(code)
          ? code
          : "UNAVAILABLE",
      );
    }
  }
  private async request(path: string, body: unknown, ownerId: string) {
    const response = await this.transport(
      origin + "/browser/registration/" + path,
      {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-Bittrees-Request": "1",
          "X-Bittrees-Account": ownerId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (
      (response.url &&
        response.url !== origin + "/browser/registration/" + path) ||
      response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    ) {
      await response.body?.cancel();
      throw Error("DENIED");
    }
    if (!response.ok) {
      await response.body?.cancel();
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
    const reader = response.body?.getReader();
    if (!reader) throw Error("INVALID_RESPONSE");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        size += r.value.length;
        if (size > 32768) throw Error("INVALID_RESPONSE");
        chunks.push(r.value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw Error("INVALID_RESPONSE");
    }
  }
  private async operation<T>(
    fn: (
      c: BrowserDeviceContext,
      guard: (until?: number) => boolean,
    ) => Promise<T>,
  ) {
    if (this.busy) throw Error("BUSY");
    this.busy = true;
    const g = ++this.generation,
      started = this.now(),
      monotonicStart = this.monotonic();
    try {
      const c = this.ctx(),
        stamp = JSON.stringify(c);
      const guard = (until = started + 30000) => {
        try {
          const n = this.now(),
            elapsed = this.monotonic() - monotonicStart;
          return (
            g === this.generation &&
            JSON.stringify(this.ctx()) === stamp &&
            Number.isSafeInteger(started) &&
            started > 0 &&
            Number.isSafeInteger(n) &&
            n >= started &&
            n < Math.min(until, started + 30000) &&
            Number.isFinite(elapsed) &&
            elapsed >= 0 &&
            elapsed < 30000
          );
        } catch {
          return false;
        }
      };
      if (!guard()) throw Error("DENIED");
      const result = await fn(c, guard);
      if (!guard()) throw Error("DENIED");
      return result;
    } catch (error) {
      this.fresh = null;
      throw error;
    } finally {
      this.generation++;
      this.busy = false;
    }
  }
  private identity(raw: unknown, owner: string) {
    const p = browserDeviceIdentitySchema.safeParse(raw);
    if (!p.success || p.data.binding.ownerId !== owner)
      throw Error("INVALID_RESPONSE");
    return p.data;
  }
  private deadline(v: BrowserDeviceIdentity) {
    return Math.min(v.binding.expiresAt, v.sessionExpiresAt);
  }
  inspect() {
    return this.operation(async (c, guard) => {
      const p = browserDeviceInspectionSchema.safeParse(
        await this.post("inspect", {}, c.ownerId),
      );
      if (
        !p.success ||
        p.data.ownerId !== c.ownerId ||
        (p.data.registration &&
          p.data.registration.binding.ownerId !== c.ownerId)
      )
        throw Error("INVALID_RESPONSE");
      if (!guard(p.data.sessionExpiresAt)) throw Error("DENIED");
      return p.data;
    });
  }
  async register(raw: unknown) {
    const input = browserDeviceRegisterSchema.parse(raw);
    return this.operation(async (c, guard) => {
      this.fresh = null;
      const made = this.identity(
        await this.post("create", input, c.ownerId),
        c.ownerId,
      );
      if (
        made.binding.credentialEpoch !== 1 ||
        made.binding.deviceId === input.expected?.deviceId ||
        !guard(this.deadline(made))
      )
        throw Error("DENIED");
      // The response alone does not prove the browser accepted the HttpOnly cookie.
      const checked = this.identity(
        await this.post("identity", {}, c.ownerId),
        c.ownerId,
      );
      if (!same(made, checked) || !guard(this.deadline(checked)))
        throw Error("DENIED");
      this.fresh = {
        binding: { ...checked.binding },
        context: JSON.stringify(c),
        at: this.now(),
        monotonicAt: this.monotonic(),
        until: Math.min(this.now() + 120000, this.deadline(checked)),
        monotonicUntil: this.monotonic() + 120000,
      };
      return checked;
    });
  }
  async list(raw: unknown = {}) {
    const input = z.strictObject({ after: z.uuid().optional() }).parse(raw);
    return this.operation(async (c) => {
      const p = browserDevicePageSchema.safeParse(
        await this.post("list", input, c.ownerId),
      );
      if (
        !p.success ||
        p.data.ownerId !== c.ownerId ||
        p.data.items.some((x) => x.binding.ownerId !== c.ownerId)
      )
        throw Error("INVALID_RESPONSE");
      return p.data;
    });
  }
  async revoke(raw: unknown) {
    const input = browserDeviceRevokeSchema.parse(raw);
    return this.operation(async (c) => {
      this.fresh = null;
      const p = z
        .strictObject({ revoked: z.literal(true), deviceId: z.uuid() })
        .safeParse(await this.post("revoke", input, c.ownerId));
      if (!p.success || p.data.deviceId !== input.deviceId)
        throw Error("INVALID_RESPONSE");
      return p.data;
    });
  }
  async withVerifiedDevice<T>(
    raw: unknown,
    action: (scope: VerifiedBrowserDeviceScope) => Promise<T>,
  ) {
    const expected = privateBindingSchema.parse(raw);
    return this.operation(async (c, guard) => {
      if (expected.ownerId !== c.ownerId) throw Error("DENIED");
      const first = this.identity(
        await this.post("identity", {}, c.ownerId),
        c.ownerId,
      );
      if (!same(first.binding, expected)) throw Error("DENIED");
      const current = () =>
        guard(this.deadline(first)) ? { ...expected } : null;
      const freshRegistration = (binding: PrivateBinding) => {
        const f = this.fresh;
        return (
          !!current() &&
          !!f &&
          f.context === JSON.stringify(c) &&
          this.now() >= f.at &&
          this.now() < f.until &&
          this.monotonic() >= f.monotonicAt &&
          this.monotonic() < f.monotonicUntil &&
          same(binding, f.binding) &&
          same(binding, expected)
        );
      };
      if (!current()) throw Error("DENIED");
      const result = await action(
        Object.freeze({ current, freshRegistration }),
      );
      if (!current()) throw Error("DENIED");
      const after = this.identity(
        await this.post("identity", {}, c.ownerId),
        c.ownerId,
      );
      if (!same(first, after) || !current()) throw Error("DENIED");
      return result;
    });
  }
}
