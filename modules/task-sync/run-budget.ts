import { z } from "zod";
import { canonical } from "../contracts/canonical-json.js";

const kinds = [
  "source",
  "connect",
  "execute",
  "preview",
  "owner",
  "attestation",
  "status",
] as const;
export type TaskSyncRequestKind = (typeof kinds)[number];
const count = z.int().min(1).max(20000);
export const taskSyncBudgetReview = z
  .strictObject({
    version: z.literal(1),
    confirmed: z.literal(true),
    runId: z.uuid(),
    scopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
    issuedAt: z.int().positive(),
    expiresAt: z.int().positive(),
    maxWorkAttempts: count,
    maxRequests: count,
    maxRequestBytes: z
      .int()
      .positive()
      .max(16 * 1024 * 1024),
    maxResponseBytes: z
      .int()
      .positive()
      .max(512 * 1024 * 1024),
    requestsByKind: z.strictObject(
      Object.fromEntries(
        kinds.map((k) => [k, z.int().min(0).max(20000)]),
      ) as unknown as Record<TaskSyncRequestKind, z.ZodNumber>,
    ),
  })
  .refine(
    (r) => r.expiresAt > r.issuedAt && r.expiresAt - r.issuedAt <= 3600000,
    "A nonrenewable deadline of at most one hour is required",
  );
type Review = z.infer<typeof taskSyncBudgetReview>;
const nonnegative = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const stateSchema = z
  .strictObject({
    review: taskSyncBudgetReview,
    lastAt: nonnegative,
    attempts: nonnegative,
    requests: nonnegative,
    requestBytes: nonnegative,
    responseBytes: nonnegative,
    byKind: z.strictObject(
      Object.fromEntries(
        kinds.map((k) => [k, nonnegative]),
      ) as unknown as Record<TaskSyncRequestKind, z.ZodNumber>,
    ),
    held: z.string().min(1).max(256).nullable(),
  })
  .refine(
    (s) =>
      s.lastAt >= s.review.issuedAt &&
      s.attempts <= s.review.maxWorkAttempts &&
      s.requests <= s.review.maxRequests &&
      s.requestBytes <= s.review.maxRequestBytes &&
      s.responseBytes <= s.review.maxResponseBytes &&
      kinds.reduce((n, k) => n + s.byKind[k], 0) === s.requests &&
      kinds.every((k) => s.byKind[k] <= s.review.requestsByKind[k]),
    "Invalid budget continuity",
  );
type State = z.infer<typeof stateSchema>;
export class TaskSyncBudgetHeld extends Error {}

/** Own encrypted state and an IMMEDIATE transaction must be supplied by the
 * native owner. A budget bounds work; it never supplies source/role authority.
 * No default allowance, clock extension, refund, replacement or reset API. */
export class TaskSyncRunBudget {
  constructor(
    private store: {
      read(): unknown;
      write(state: State): void;
      atomic<T>(f: () => T): T;
    },
    private now = Date.now,
  ) {}
  bind(raw: unknown) {
    const review = taskSyncBudgetReview.parse(raw);
    this.store.atomic(() => {
      const old = this.read();
      if (old) {
        if (canonical(old.review) !== canonical(review))
          throw new TaskSyncBudgetHeld(
            "Existing run budget cannot be replaced or extended",
          );
        return;
      }
      const at = this.now();
      if (
        !Number.isSafeInteger(at) ||
        at < review.issuedAt ||
        at >= review.expiresAt
      )
        throw new TaskSyncBudgetHeld("Budget review is not current");
      this.store.write({
        review,
        lastAt: at,
        attempts: 0,
        requests: 0,
        requestBytes: 0,
        responseBytes: 0,
        byKind: Object.fromEntries(kinds.map((k) => [k, 0])) as State["byKind"],
        held: null,
      });
    });
  }
  private read(): State | null {
    let raw: unknown;
    try {
      raw = this.store.read();
    } catch {
      throw new TaskSyncBudgetHeld(
        "Run budget state unavailable; reconciliation required",
      );
    }
    if (raw === null) return null;
    const parsed = stateSchema.safeParse(raw);
    if (!parsed.success)
      throw new TaskSyncBudgetHeld(
        "Run budget state invalid; reconciliation required",
      );
    return parsed.data;
  }
  snapshot() {
    return structuredClone(this.read());
  }
  private update(scope: string, change: (state: State) => string | void) {
    let failure: string | undefined;
    const state = this.store.atomic(() => {
      const s = this.read();
      if (!s)
        throw new TaskSyncBudgetHeld(
          "A separately reviewed run budget is required",
        );
      const at = this.now();
      failure =
        s.held ||
        (s.review.scopeDigest !== scope
          ? "Run budget scope changed"
          : !Number.isSafeInteger(at) || at < s.lastAt || at < s.review.issuedAt
            ? "Run budget clock continuity lost"
            : at >= s.review.expiresAt
              ? "Run budget deadline reached"
              : undefined);
      if (!failure) {
        s.lastAt = at;
        failure = change(s) || undefined;
      }
      if (failure) s.held = failure;
      this.store.write(s);
      return s;
    });
    if (failure) throw new TaskSyncBudgetHeld(failure);
    return state;
  }
  assertCurrent(scope: string) {
    return this.update(scope, () => {});
  }
  beginWork(scope: string) {
    this.update(scope, (s) => {
      if (s.attempts >= s.review.maxWorkAttempts)
        return "Run work-attempt budget exhausted";
      s.attempts++;
    });
  }
  reserve(scope: string, kind: TaskSyncRequestKind, bytes: number) {
    return this.update(scope, (s) => {
      if (!kinds.includes(kind)) return "Run request kind invalid";
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 64000)
        return "Run request size invalid";
      if (
        s.requests >= s.review.maxRequests ||
        s.byKind[kind] >= s.review.requestsByKind[kind]
      )
        return "Run request budget exhausted";
      if (s.requestBytes + bytes > s.review.maxRequestBytes)
        return "Run request-byte budget exhausted";
      s.requests++;
      s.byKind[kind]++;
      s.requestBytes += bytes;
    });
  }
  received(scope: string, bytes: number) {
    this.update(scope, (s) => {
      if (
        !Number.isSafeInteger(bytes) ||
        bytes < 0 ||
        s.responseBytes + bytes > s.review.maxResponseBytes
      )
        return "Run response-byte budget exhausted";
      s.responseBytes += bytes;
    });
  }
  signal(scope: string, parent?: AbortSignal | null) {
    const s = this.assertCurrent(scope);
    return AbortSignal.any([
      ...(parent ? [parent] : []),
      AbortSignal.timeout(
        Math.max(1, Math.min(20000, s.review.expiresAt - this.now())),
      ),
    ]);
  }
  private size(value: unknown) {
    try {
      const json = JSON.stringify(value);
      if (typeof json !== "string") throw Error();
      return Buffer.byteLength(json);
    } catch {
      throw new TaskSyncBudgetHeld("Run value is not a bounded JSON response");
    }
  }
  async value<T>(
    scope: string,
    kind: TaskSyncRequestKind,
    input: unknown,
    action: (signal: AbortSignal) => Promise<T>,
    parent?: AbortSignal,
  ) {
    this.reserve(scope, kind, this.size(input));
    const signal = this.signal(scope, parent);
    const result = await this.bounded(action, signal);
    this.received(scope, this.size(result));
    return result;
  }
  private async bounded<T>(
    action: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ) {
    let cancel = () => {};
    try {
      signal.throwIfAborted();
      const aborted = new Promise<never>((_, reject) => {
        const stop = () =>
          reject(
            new TaskSyncBudgetHeld(
              "Run request interrupted or deadline reached; reconcile original operation",
            ),
          );
        signal.addEventListener("abort", stop, { once: true });
        cancel = () => signal.removeEventListener("abort", stop);
      });
      return await Promise.race([action(signal), aborted]);
    } finally {
      cancel();
    }
  }
  fetch(
    request: typeof fetch,
    scope: () => string,
    classify: (url: string, init?: RequestInit) => TaskSyncRequestKind,
  ): typeof fetch {
    return async (input, init) => {
      if (typeof input !== "string")
        throw new TaskSyncBudgetHeld("Explicit fixed destination required");
      const url = input,
        kind = classify(url, init),
        binding = scope();
      const headers = new Headers(init?.headers);
      const bytes = Buffer.byteLength(
        url + JSON.stringify([...headers]) + String(init?.body ?? ""),
      );
      this.reserve(binding, kind, bytes);
      const signal = this.signal(binding, init?.signal);
      signal.throwIfAborted();
      const response = await this.bounded(
        () => request(input, { ...init, redirect: "error", signal }),
        signal,
      );
      this.received(
        binding,
        Buffer.byteLength(JSON.stringify([...response.headers])),
      );
      this.assertCurrent(scope());
      if (!response.body) return response;
      const reader = response.body.getReader();
      let finished = false;
      let cleanup = () => {};
      const stop = () => {
        void reader.cancel().catch(() => {});
      };
      const body = new ReadableStream<Uint8Array>(
        {
          start: (controller) => {
            const abort = () => {
              if (!finished) {
                finished = true;
                cleanup();
                stop();
                controller.error(
                  new TaskSyncBudgetHeld(
                    "Run response interrupted; reconcile original operation",
                  ),
                );
              }
            };
            signal.addEventListener("abort", abort, { once: true });
            cleanup = () => signal.removeEventListener("abort", abort);
            if (signal.aborted) abort();
          },
          pull: async (controller) => {
            if (finished) return;
            try {
              const r = await reader.read();
              if (finished) return;
              if (r.done) {
                this.assertCurrent(scope());
                finished = true;
                cleanup();
                controller.close();
                return;
              }
              this.assertCurrent(scope());
              this.received(binding, r.value.byteLength);
              controller.enqueue(r.value);
            } catch (error) {
              if (!finished) {
                finished = true;
                cleanup();
                stop();
                controller.error(error);
              }
            }
          },
          cancel: () => {
            finished = true;
            cleanup();
            stop();
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
  }
}
