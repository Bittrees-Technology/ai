import { BrowserPeerEnrollment } from "../../../modules/remote/browser-peers.js";
import {
  BrowserKeyLifecycle,
  type BrowserKeyProof,
} from "../../../modules/remote/browser-key-lifecycle.js";
import { BrowserKeyHost } from "../../../modules/remote/browser-key-host.js";
import {
  newBrowserRecoveryCode,
  browserRecoveryKey,
  openBrowserKeyRecovery,
} from "../../../modules/remote/browser-key-recovery.js";
import type { PrivateBinding } from "../../../modules/remote/private-peer-contracts.js";
import {
  sealPrivateEnvelope,
  openPrivateEnvelope,
  type PrivateHeader,
} from "../../../modules/remote/private-envelope.js";
let keys: BrowserKeyLifecycle,
  peers: BrowserPeerEnrollment,
  host: BrowserKeyHost | null = null;
let owner = "",
  binding: PrivateBinding | null = null,
  current: BrowserKeyProof | null = null,
  now = Date.now(),
  mono = 0;
let hostOwner: string | null = null,
  hostScope = 0;
let release: (() => void) | undefined,
  held = false;
let identityCountdown = 0;
const context = () =>
  hostOwner ? { ownerId: hostOwner, scope: String(hostScope) } : null;
async function withKey<T>(fn: () => Promise<T>) {
  current = (await keys.resolve()).proof;
  try {
    return await fn();
  } finally {
    current = null;
  }
}
async function api(path: string, body: unknown) {
  const r = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "X-Bittrees-Request": "1",
      ...(hostOwner ? { "X-Bittrees-Account": hostOwner } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw Error("DENIED");
  return r.json();
}
async function mount(id: string) {
  host?.close();
  hostOwner = id;
  hostScope++;
  host = await BrowserKeyHost.open(context, async (...args) => {
    if (
      new URL(String(args[0]), location.origin).pathname ===
        "/browser/registration/identity" &&
      identityCountdown > 0 &&
      --identityCountdown === 0
    ) {
      held = true;
      await new Promise<void>((r) => (release = r));
    }
    return globalThis.fetch(...args);
  });
  await host.inspect();
}
const legacyUrl = "/legacy-lifecycle.js";
const fixture = {
  async init(o: string, b: PrivateBinding, time: number) {
    keys?.close();
    peers?.close();
    host?.close();
    host = null;
    owner = o;
    binding = b;
    now = time;
    mono = 0;
    current = null;
    keys = await BrowserKeyLifecycle.open(
      owner,
      () => binding,
      () => true,
      () => now,
    );
    peers = await BrowserPeerEnrollment.open(
      owner,
      () => current,
      () => now,
      () => mono,
    );
  },
  async activate() {
    const slot = await keys.begin({
      expectedRevision: (await keys.status()).revision,
      confirmed: true,
    });
    const code = newBrowserRecoveryCode();
    const proof = await keys.provision(
      {
        keyId: slot.keyId,
        expectedRevision: slot.revision,
        confirmed: true,
        recoverySaved: true,
      },
      code,
    );
    return proof;
  },
  keyStatus: () => keys.status(),
  recovery: (keyId: string) => keys.recovery({ keyId, confirmed: true }),
  async checkRecovery(kit: unknown, code: string) {
    const r = await openBrowserKeyRecovery(kit, await browserRecoveryKey(code));
    return {
      identity: r.identity,
      publicKey: r.publicKey,
      privateExtractable: r.pair.privateKey.extractable,
    };
  },
  async key() {
    const k = await keys.resolve();
    return {
      proof: k.proof,
      privateExtractable: k.pair.privateKey.extractable,
    };
  },
  keyRevoke: (raw: unknown) => keys.revoke(raw),
  keyReset: (raw: unknown) => keys.reset(raw),
  set(b: PrivateBinding | null) {
    binding = b;
    keys.invalidate();
    peers.invalidate();
    current = null;
  },
  time(wall: number, monotonic: number) {
    now = wall;
    mono = monotonic;
  },
  status: () => (host ? host.peerAPI.status() : peers.status()),
  invitation: (raw: unknown) =>
    host ? host.peerAPI.invitation(raw) : keys.invitation(raw),
  prepare: (raw: unknown) =>
    host ? host.peerAPI.prepare(raw) : withKey(() => peers.prepare(raw)),
  approve: (raw: unknown) =>
    host ? host.peerAPI.approve(raw) : withKey(() => peers.approve(raw)),
  reset: (raw: unknown) =>
    host ? host.peerAPI.reset(raw) : withKey(() => peers.reset(raw)),
  revoke: (raw: unknown) =>
    host ? host.peerAPI.revoke(raw) : peers.revoke(raw),
  clear: (raw: unknown) => (host ? host.peerAPI.clear(raw) : peers.clear(raw)),
  resolve: (id: string, epoch: number) =>
    withKey(async () => (await peers.resolve(id, epoch)).proof),
  async validate(proof: unknown) {
    try {
      return await withKey(() => peers.validate(proof));
    } catch {
      return false;
    }
  },
  invalidate() {
    peers?.invalidate();
    host?.peerAPI.invalidate();
  },
  async seal(id: string, epoch: number, header: PrivateHeader, text: string) {
    const k = await keys.resolve();
    current = k.proof;
    try {
      const p = await peers.resolve(id, epoch);
      return await sealPrivateEnvelope(
        header,
        new TextEncoder().encode(text),
        { senderKey: k.pair, recipientPublicKey: p.publicKey },
        () => now,
      );
    } finally {
      current = null;
    }
  },
  async open(id: string, epoch: number, envelope: unknown, expected: unknown) {
    const k = await keys.resolve();
    current = k.proof;
    try {
      const p = await peers.resolve(id, epoch);
      const result = await openPrivateEnvelope(
        envelope,
        expected,
        { recipientKey: k.pair, senderPublicKey: p.publicKey },
        () => now,
      );
      try {
        return new TextDecoder().decode(result.plaintext);
      } finally {
        result.plaintext.fill(0);
      }
    } finally {
      current = null;
    }
  },
  holdDigest() {
    const original = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = (async (
      ...args: Parameters<SubtleCrypto["digest"]>
    ) => {
      crypto.subtle.digest = original;
      held = true;
      await new Promise<void>((r) => (release = r));
      return original(...args);
    }) as SubtleCrypto["digest"];
  },
  holdImport() {
    const original = crypto.subtle.importKey.bind(crypto.subtle);
    crypto.subtle.importKey = (async (
      ...args: Parameters<SubtleCrypto["importKey"]>
    ) => {
      crypto.subtle.importKey = original;
      held = true;
      await new Promise<void>((r) => (release = r));
      return original(...args);
    }) as SubtleCrypto["importKey"];
  },
  holdSecondIdentity() {
    identityCountdown = 2;
  },
  held: () => held,
  release() {
    release?.();
    release = undefined;
    held = false;
  },
  async legacySeed(o: string, b: PrivateBinding, time: number) {
    const legacy = await import(/* @vite-ignore */ legacyUrl);
    const k = await legacy.BrowserKeyLifecycle.open(
      o,
      () => b,
      () => true,
      () => time,
    );
    try {
      const slot = await k.begin({ expectedRevision: 0, confirmed: true });
      const code = newBrowserRecoveryCode();
      const proof = await k.provision(
        {
          keyId: slot.keyId,
          expectedRevision: slot.revision,
          confirmed: true,
          recoverySaved: true,
        },
        code,
      );
      const kit = await k.recovery({ keyId: slot.keyId, confirmed: true });
      return { proof, code, kit };
    } finally {
      k.close();
    }
  },
  async legacyOpen(o: string, b: PrivateBinding, time: number) {
    const legacy = await import(/* @vite-ignore */ legacyUrl);
    const k = await legacy.BrowserKeyLifecycle.open(
      o,
      () => b,
      () => false,
      () => time,
    );
    try {
      return (await k.resolve()).proof;
    } finally {
      k.close();
    }
  },
  challenge: (address: string) => api("/browser/login/challenge", { address }),
  async login(message: string, signature: string) {
    const r = await api("/browser/login/verify", { message, signature });
    await mount(r.ownerId);
    return r.ownerId as string;
  },
  async resume() {
    const r = await api("/browser/session", {});
    await mount(r.ownerId);
  },
  register: (raw: unknown) => host!.register(raw),
  async hostActivate() {
    const slot = await host!.keyAPI.begin({
      expectedRevision: (await host!.keyAPI.status()).revision,
      confirmed: true,
    });
    const code = newBrowserRecoveryCode(),
      raw = {
        keyId: slot.keyId,
        expectedRevision: slot.revision,
        confirmed: true,
      };
    const prepared = await host!.keyAPI.prepareRecovery(raw, code);
    return host!.keyAPI.activatePrepared(
      { ...raw, recoverySaved: true },
      code,
      prepared.recovery,
    );
  },
  async logout() {
    await api("/browser/logout", {});
    hostOwner = null;
    hostScope++;
    host?.invalidate();
  },
  scopeChange() {
    hostScope++;
    host?.invalidate();
  },
  registerRevoke: (raw: unknown) => host!.revoke(raw),
  hostKeyRevoke: (raw: unknown) => host!.keyAPI.revoke(raw),
};
declare global {
  interface Window {
    browserPeersTest: typeof fixture;
  }
}
window.browserPeersTest = fixture;
