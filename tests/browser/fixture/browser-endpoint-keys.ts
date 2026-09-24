import { openBrowserKeyRecovery } from "../../../modules/remote/browser-key-recovery.js";
import {
  BrowserEndpointKeys,
  type BrowserKeyAuthority,
} from "../../../modules/remote/browser-endpoint-keys.js";
import {
  openPrivateEnvelope,
  sealPrivateEnvelope,
  type PrivateEnvelope,
  type PrivateHeader,
} from "../../../modules/remote/private-envelope.js";
let recoveryKey: CryptoKey;
let provider: BrowserEndpointKeys,
  authority: BrowserKeyAuthority | null,
  clock = Date.now(),
  owner = "";
let held = false,
  release: (() => void) | undefined;
const harness = {
  async init(value: BrowserKeyAuthority, now: number) {
    provider?.close();
    recoveryKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(32).fill(7),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    authority = value;
    clock = now;
    owner = value.localOwner;
    provider = await BrowserEndpointKeys.open(
      owner,
      () => authority,
      () => clock,
    );
  },
  async reopen() {
    provider.close();
    provider = await BrowserEndpointKeys.open(
      owner,
      () => authority,
      () => clock,
    );
  },
  set(value: BrowserKeyAuthority | null, invalidate = true) {
    authority = value;
    if (invalidate) provider.invalidate();
  },
  time(now: number) {
    clock = now;
  },
  create(raw?: unknown) {
    return provider.create(
      raw ?? {
        keyId: authority!.keyId,
        keyEpoch: authority!.keyEpoch,
        confirmed: true,
      },
      recoveryKey,
    );
  },
  async recovery(keyId = authority!.keyId) {
    const kit = await provider.recovery({
      keyId,
      confirmed: true,
    });
    const recovered = await openBrowserKeyRecovery(kit, recoveryKey);
    return {
      kit,
      identity: recovered.identity,
      publicKey: recovered.publicKey,
      privateExtractable: recovered.pair.privateKey.extractable,
    };
  },
  async resolve() {
    const a = await provider.resolve();
    let denied = false;
    try {
      await crypto.subtle.exportKey("pkcs8", a.pair.privateKey);
    } catch {
      denied = true;
    }
    return {
      keyId: a.keyId,
      keyEpoch: a.keyEpoch,
      publicKey: a.publicKey,
      privateExportDenied: denied,
      privateExtractable: a.pair.privateKey.extractable,
    };
  },
  async stable() {
    const a = await provider.resolve(),
      b = await provider.resolve();
    return (
      a.pair.privateKey === b.pair.privateKey &&
      a.pair.publicKey === b.pair.publicKey
    );
  },
  remove(keyId: string, confirmed = true) {
    return provider.remove({ keyId, confirmed });
  },
  invitation(recipientId: string) {
    return provider.invitation({ recipientId, confirmed: true });
  },
  close() {
    provider.close();
  },
  holdGenerate() {
    const original = crypto.subtle.generateKey.bind(crypto.subtle);
    crypto.subtle.generateKey = (async (...args: any[]) => {
      crypto.subtle.generateKey = original;
      held = true;
      await new Promise<void>((r) => (release = r));
      return (original as any)(...args);
    }) as typeof crypto.subtle.generateKey;
  },
  held() {
    return held;
  },
  release() {
    release?.();
    release = undefined;
    held = false;
  },
  async open(envelope: PrivateEnvelope, peer: string) {
    const key = await provider.resolve();
    const sender = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(atob(peer), (c) => c.charCodeAt(0)),
      { name: "ECDH", namedCurve: "P-256" },
      true,
      [],
    );
    return new TextDecoder().decode(
      (
        await openPrivateEnvelope(
          envelope,
          envelope.header,
          { recipientKey: key.pair, senderPublicKey: sender },
          () => clock,
        )
      ).plaintext,
    );
  },
  async seal(header: PrivateHeader, peer: string, text: string) {
    const key = await provider.resolve();
    const recipient = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(atob(peer), (c) => c.charCodeAt(0)),
      { name: "ECDH", namedCurve: "P-256" },
      true,
      [],
    );
    return sealPrivateEnvelope(
      header,
      new TextEncoder().encode(text),
      { senderKey: key.pair, recipientPublicKey: recipient },
      () => clock,
    );
  },
  async records() {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("org.bittrees.ai.browser-endpoint-keys");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      return await new Promise<any[]>((resolve, reject) => {
        const tx = db.transaction("slots", "readonly"),
          r = tx.objectStore("slots").getAll();
        tx.oncomplete = () =>
          resolve(
            r.result.map((x) => ({
              keyId: x.keyId,
              state: x.state,
              publicKey: x.publicKey,
              hasPrivate: !!x.privateHandle,
              hasPublic: !!x.publicHandle,
            })),
          );
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  },
};
declare global {
  interface Window {
    browserEndpointTest: typeof harness;
  }
}
window.browserEndpointTest = harness;
