import { BrowserTaskConsent } from "./browser-task-consent.js";
import { z } from "zod";
import {
  BrowserDeviceClient,
  type BrowserDeviceContext,
} from "./browser-device-client.js";
import {
  BrowserKeyLifecycle,
  type BrowserKeyProof,
} from "./browser-key-lifecycle.js";
import { BrowserPeerChecks } from "./browser-peer-checks.js";
import { BrowserPeerEnrollment } from "./browser-peers.js";
import type { VerifiedBrowserDeviceScope } from "./browser-device-contracts.js";
import type { PrivateBinding } from "./private-peer-contracts.js";
const contextSchema = z.strictObject({
  ownerId: z.uuid(),
  scope: z.string().min(1).max(1024),
});
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
/** One trusted signed-in owner/session scope. Displayed identity is never an
 * offline grant: every online key operation obtains its own verified scope. */
export class BrowserKeyHost {
  private generation = 0;
  private closed = false;
  private busy = false;
  private binding: PrivateBinding | null = null;
  private freshUntil = 0;
  private sessionUntil = 0;
  private freshStarted = 0;
  private freshMono = 0;
  private active: VerifiedBrowserDeviceScope | null = null;
  private keys!: BrowserKeyLifecycle;
  private peers!: BrowserPeerEnrollment;
  private checks?: BrowserPeerChecks;
  private consents?: BrowserTaskConsent;
  private peerKey: BrowserKeyProof | null = null;
  private client: BrowserDeviceClient;
  readonly localOwner: string;
  private constructor(
    private original: BrowserDeviceContext,
    private context: () => BrowserDeviceContext | null,
    transport: typeof fetch,
    private now: () => number,
    private monotonic: () => number,
  ) {
    this.localOwner = "browser:" + original.ownerId;
    this.client = new BrowserDeviceClient(
      () => this.currentContext(),
      transport,
      now,
      monotonic,
    );
  }
  static async open(
    context: () => BrowserDeviceContext | null,
    transport: typeof fetch = (...args) => globalThis.fetch(...args),
    now = Date.now,
    monotonic = () => performance.now(),
  ) {
    const original = contextSchema.parse(context());
    const self = new BrowserKeyHost(
      original,
      context,
      transport,
      now,
      monotonic,
    );
    try {
      self.keys = await BrowserKeyLifecycle.open(
        self.localOwner,
        () => self.active?.current() ?? null,
        (b) => self.active?.freshRegistration(b) ?? false,
        now,
      );
      self.peers = await BrowserPeerEnrollment.open(
        self.localOwner,
        () =>
          self.peerKey &&
          self.currentContext() &&
          same(self.active?.current(), self.peerKey.binding)
            ? self.peerKey
            : null,
        now,
        monotonic,
      );
      if (!self.currentContext()) {
        self.close();
        throw Error("DENIED");
      }
      return self;
    } catch (e) {
      self.close();
      throw e;
    }
  }
  private currentContext() {
    if (this.closed) return null;
    try {
      const c = contextSchema.parse(this.context());
      return same(c, this.original) ? c : null;
    } catch {
      return null;
    }
  }
  /** View cancellation counter only; it supplies no key or identity authority. */
  reviewVersion() {
    return this.generation;
  }
  session() {
    return this.currentContext();
  }
  keyContext() {
    const c = this.currentContext();
    if (!c) return null;
    const n = this.now(),
      elapsed = this.monotonic() - this.freshMono;
    const binding =
      this.binding && this.binding.expiresAt > n && this.sessionUntil > n
        ? { ...this.binding }
        : null;
    return {
      localOwner: this.localOwner,
      scope: JSON.stringify(c),
      binding,
      freshRegistration:
        !!binding &&
        n >= this.freshStarted &&
        n < this.freshUntil &&
        Number.isFinite(elapsed) &&
        elapsed >= 0 &&
        elapsed < 120000,
    };
  }
  /** View cancellation invalidates in-flight key work, not an idle acknowledged
   * registration. Otherwise opening a key review would erase its own authority. */
  cancelKeys() {
    this.generation++;
    this.active = null;
    this.peerKey = null;
    this.keys?.invalidate();
    this.peers?.invalidate();
    this.checks?.invalidate();
    this.consents?.invalidate();
  }
  /** Trusted host calls this immediately on logout, lock or account/scope change. */
  invalidate() {
    this.cancelKeys();
    this.client.invalidate();
    this.binding = null;
    this.sessionUntil = 0;
    this.freshUntil = 0;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.invalidate();
    this.keys?.close();
    this.peers?.close();
    this.checks?.close();
    this.consents?.close();
  }
  private check(g: number) {
    if (g !== this.generation || !this.currentContext()) throw Error("DENIED");
  }
  private async operation<T>(fn: (g: number) => Promise<T>) {
    if (this.busy) throw Error("BUSY");
    this.busy = true;
    const g = this.generation;
    try {
      this.check(g);
      const result = await fn(g);
      this.check(g);
      return result;
    } finally {
      this.busy = false;
    }
  }
  async inspect() {
    return this.operation(async (g) => {
      try {
        const result = await this.client.inspect();
        this.check(g);
        this.sessionUntil = result.sessionExpiresAt;
        const next =
          result.registration?.revokedAt === null &&
          result.registration.binding.expiresAt > this.now()
            ? result.registration.binding
            : null;
        if (!same(next, this.binding)) {
          this.keys.invalidate();
          this.peers.invalidate();
          this.checks?.invalidate();
          this.consents?.invalidate();
          this.freshUntil = 0;
        }
        this.binding = next ? { ...next } : null;
        return result;
      } catch (e) {
        this.binding = null;
        this.freshUntil = 0;
        throw e;
      }
    });
  }
  async register(raw: unknown) {
    this.cancelKeys();
    return this.operation(async (g) => {
      this.binding = null;
      this.freshUntil = 0;
      const start = this.now(),
        mono = this.monotonic();
      try {
        const result = await this.client.register(raw);
        this.check(g);
        this.binding = { ...result.binding };
        this.sessionUntil = result.sessionExpiresAt;
        this.freshStarted = start;
        this.freshMono = mono;
        this.freshUntil = Math.min(
          start + 120000,
          result.binding.expiresAt,
          result.sessionExpiresAt,
        );
        return result;
      } catch (e) {
        this.client.invalidate();
        throw e;
      }
    });
  }
  list(raw: unknown = {}) {
    return this.operation(async () => {
      try {
        return await this.client.list(raw);
      } catch (e) {
        this.freshUntil = 0;
        throw e;
      }
    });
  }
  async revoke(raw: unknown) {
    this.cancelKeys();
    return this.operation(async (g) => {
      this.freshUntil = 0;
      try {
        const result = await this.client.revoke(raw);
        this.check(g);
        if (result.deviceId === this.binding?.deviceId) this.binding = null;
        return result;
      } catch (e) {
        this.binding = null;
        throw e;
      }
    });
  }
  private verified<T>(fn: () => Promise<T>) {
    return this.operation(async (g) => {
      const binding = this.binding ? { ...this.binding } : null;
      if (!binding) throw Error("DENIED");
      try {
        return await this.client.withVerifiedDevice(binding, async (scope) => {
          this.check(g);
          const current = () => {
            try {
              this.check(g);
              return scope.current();
            } catch {
              return null;
            }
          };
          const active = {
            current,
            freshRegistration: (b: PrivateBinding) =>
              !!current() && scope.freshRegistration(b),
          };
          this.active = active;
          try {
            if (!current()) throw Error("DENIED");
            return await fn();
          } finally {
            if (this.active === active) this.active = null;
          }
        });
      } catch (e) {
        this.freshUntil = 0;
        throw e;
      }
    });
  }
  /** No key handles leave this setup host. Separate peer/task consent is required
   * by future private-content callers; registration alone cannot supply it. */
  readonly keyAPI = {
    status: () => this.operation(() => this.keys.status()),
    begin: (raw: unknown) => this.verified(() => this.keys.begin(raw)),
    prepareRecovery: (raw: unknown, code: string) =>
      this.verified(() => this.keys.prepareRecovery(raw, code)),
    activatePrepared: (raw: unknown, code: string, kit: unknown) =>
      this.verified(() => this.keys.activatePrepared(raw, code, kit)),
    reset: (raw: unknown) => this.verified(() => this.keys.reset(raw)),
    revoke: (raw: unknown) => this.operation(() => this.keys.revoke(raw)),
    remove: (raw: unknown) => this.operation(() => this.keys.remove(raw)),
    clear: (raw: unknown) => this.operation(() => this.keys.clear(raw)),
    recovery: (raw: unknown) => this.operation(() => this.keys.recovery(raw)),
    invalidate: () => this.cancelKeys(),
  };
  private verifiedPeer<T>(fn: () => Promise<T>) {
    return this.verified(async () => {
      const key = await this.keys.resolve();
      this.peerKey = key.proof;
      try {
        return await fn();
      } finally {
        this.peerKey = null;
      }
    });
  }
  /** Public invitations/pins only. No private key handle, possession grant or task
   * consent is exposed by this API. Each enrollment step verifies online identity. */
  readonly peerAPI = {
    status: () => this.operation(() => this.peers.status()),
    invitation: (raw: unknown) =>
      this.verified(() => this.keys.invitation(raw)),
    prepare: (raw: unknown) => this.verifiedPeer(() => this.peers.prepare(raw)),
    approve: (raw: unknown) => this.verifiedPeer(() => this.peers.approve(raw)),
    reset: (raw: unknown) => this.verifiedPeer(() => this.peers.reset(raw)),
    revoke: (raw: unknown) => this.operation(() => this.peers.revoke(raw)),
    clear: (raw: unknown) => this.operation(() => this.peers.clear(raw)),
    invalidate: () => this.cancelKeys(),
  };
  // Lazy opening keeps ordinary key recovery usable when history needs repair.
  private async checkStore() {
    if (this.checks) return this.checks;
    const g = this.generation;
    const created = await BrowserPeerChecks.open(
      this.localOwner,
      () => this.active?.current() ?? null,
      this.keys,
      this.peers,
      this.now,
      this.monotonic,
    );
    try {
      this.check(g);
      this.checks = created;
      return created;
    } catch (e) {
      created.close();
      throw e;
    }
  }
  private async consentStore() {
    if (this.consents) return this.consents;
    const g = this.generation;
    const created = await BrowserTaskConsent.open(
      this.localOwner,
      () => this.active?.current() ?? null,
      this.keys,
      this.peers,
      this.now,
      this.monotonic,
    );
    try {
      this.check(g);
      this.consents = created;
      return created;
    } catch (e) {
      created.close();
      throw e;
    }
  }
  /** Saved permission choices are not a task route. Every online review obtains
   * fresh verified identity; offline metadata/revocation never grant authority. */
  readonly consentAPI = {
    status: () =>
      this.operation(async () => (await this.consentStore()).status()),
    prepare: (raw: unknown) =>
      this.verifiedPeer(async () => (await this.consentStore()).prepare(raw)),
    approve: (raw: unknown) =>
      this.verifiedPeer(async () => (await this.consentStore()).approve(raw)),
    revoke: (raw: unknown) =>
      this.operation(async () => (await this.consentStore()).revoke(raw)),
    clear: (raw: unknown) =>
      this.operation(async () => (await this.consentStore()).clear(raw)),
    reset: (raw: unknown) =>
      this.verified(async () => (await this.consentStore()).reset(raw)),
    invalidate: () => this.cancelKeys(),
  };
  /** Explicit manual device checks only. Public callers receive metadata and the
   * original encrypted envelope, never retained key handles or task permission. */
  readonly checkAPI = {
    status: () =>
      this.operation(async () => (await this.checkStore()).status()),
    begin: (raw: unknown) =>
      this.verifiedPeer(async () => (await this.checkStore()).begin(raw)),
    respond: (raw: unknown) =>
      this.verifiedPeer(async () => (await this.checkStore()).respond(raw)),
    complete: (raw: unknown) =>
      this.verifiedPeer(async () => (await this.checkStore()).complete(raw)),
    resume: (raw: unknown) =>
      this.verifiedPeer(async () => (await this.checkStore()).resume(raw)),
    envelope: (raw: unknown) =>
      this.verifiedPeer(async () => (await this.checkStore()).delivery(raw)),
    stop: (raw: unknown) =>
      this.operation(async () => (await this.checkStore()).stop(raw)),
    clear: (raw: unknown) =>
      this.operation(async () => (await this.checkStore()).clear(raw)),
    reset: (raw: unknown) =>
      this.verified(async () => (await this.checkStore()).reset(raw)),
    invalidate: () => this.cancelKeys(),
  };
}
