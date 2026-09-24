const legacyModuleUrl = "/legacy-keys.js";
import {
  BrowserKeyLifecycle,
  browserReplayCoverageMatches,
  type BrowserKeyProof,
} from "../../../modules/remote/browser-key-lifecycle.js";
import {
  BrowserEndpointKeys,
  type BrowserKeyAuthority,
} from "../../../modules/remote/browser-endpoint-keys.js";
import {
  newBrowserRecoveryCode,
  browserRecoveryKey,
  openBrowserKeyRecovery,
} from "../../../modules/remote/browser-key-recovery.js";
import {
  browserKeyDatabaseName,
  browserKeyScope,
  openBrowserKeyDatabase,
} from "../../../modules/remote/browser-key-state.js";
import type { PrivateBinding } from "../../../modules/remote/private-peer-contracts.js";
let lifecycle: BrowserKeyLifecycle,
  owner = "",
  binding: PrivateBinding | null = null,
  fresh = false,
  now = Date.now(),
  held = false,
  release: (() => void) | undefined;
const api = {
  async init(o: string, b: PrivateBinding | null, f: boolean, time: number) {
    lifecycle?.close();
    owner = o;
    binding = b;
    fresh = f;
    now = time;
    lifecycle = await BrowserKeyLifecycle.open(
      owner,
      () => binding,
      (b) => fresh && JSON.stringify(b) === JSON.stringify(binding),
      () => now,
    );
  },
  async reopen() {
    lifecycle.close();
    lifecycle = await BrowserKeyLifecycle.open(
      owner,
      () => binding,
      (b) => fresh && JSON.stringify(b) === JSON.stringify(binding),
      () => now,
    );
  },
  set(b: PrivateBinding | null, f = fresh, invalidate = true) {
    binding = b;
    fresh = f;
    if (invalidate) lifecycle.invalidate();
  },
  time(value: number) {
    now = value;
  },
  status() {
    return lifecycle.status();
  },
  begin(raw: unknown) {
    return lifecycle.begin(raw);
  },
  provision(raw: unknown, code: string) {
    return lifecycle.provision(raw, code);
  },
  code() {
    return newBrowserRecoveryCode();
  },
  async resolve() {
    const key = await lifecycle.resolve();
    return {
      proof: key.proof,
      publicKey: key.publicKey,
      privateExtractable: key.pair.privateKey.extractable,
    };
  },
  async stable() {
    const a = await lifecycle.resolve(),
      b = await lifecycle.resolve();
    return (
      a.pair.privateKey === b.pair.privateKey &&
      a.pair.publicKey === b.pair.publicKey
    );
  },
  coverage(proof: BrowserKeyProof) {
    return lifecycle.validateReplayCoverage(proof);
  },
  prepareRecovery(raw: unknown, code: string) {
    return lifecycle.prepareRecovery(raw, code);
  },
  activatePrepared(raw: unknown, code: string, kit: unknown) {
    return lifecycle.activatePrepared(raw, code, kit);
  },
  async boundarySnapshot(proof?: BrowserKeyProof, change?: string) {
    const scope = await browserKeyScope(owner),
      db = await openBrowserKeyDatabase();
    try {
      return await new Promise<{
        version: number;
        covered: boolean;
        markers: (string | null)[];
        publicKeys: (string | null)[];
      }>((resolve, reject) => {
        const tx = db.transaction(
          ["lifecycle", "slots"],
          change ? "readwrite" : "readonly",
        );
        let result: {
          version: number;
          covered: boolean;
          markers: (string | null)[];
          publicKeys: (string | null)[];
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () =>
          reject(Error("fixture transaction failed"));
        const state = tx.objectStore("lifecycle").get(scope);
        state.onsuccess = () => {
          const slots = tx.objectStore("slots"),
            records = slots.index("scope").getAll(scope);
          records.onsuccess = () => {
            const selected = records.result.find(
              (v) => v.keyId === proof?.keyId,
            );
            if (change && selected) {
              if (change === "missing") delete selected.incomingReplayBoundary;
              else selected.incomingReplayBoundary = "unsupported";
              slots.put(selected);
            }
            result = {
              version: db.version,
              covered:
                !!binding &&
                browserReplayCoverageMatches(state.result, selected, proof, {
                  localOwner: owner,
                  scope,
                  binding,
                  now,
                }),
              markers: records.result.map(
                (v) => v.incomingReplayBoundary ?? null,
              ),
              publicKeys: records.result.map((v) => v.publicKey),
            };
          };
        };
      });
    } finally {
      db.close();
    }
  },
  async legacyBoundarySeed(
    o: string,
    b: PrivateBinding,
    time: number,
    code: string,
    mode: "active" | "prepared" | "empty",
  ) {
    lifecycle?.close();
    owner = o;
    binding = b;
    fresh = true;
    now = time;
    const url = "/legacy-key-boundary/index.js";
    const legacy = await import(/* @vite-ignore */ url);
    const old = await legacy.BrowserKeyLifecycle.open(
      owner,
      () => binding,
      () => true,
      () => now,
    );
    try {
      const slot = await old.begin({ expectedRevision: 0, confirmed: true });
      const command = {
        keyId: slot.keyId,
        expectedRevision: slot.revision,
        confirmed: true,
      };
      let proof = null,
        prepared = null;
      if (mode === "prepared")
        prepared = await old.prepareRecovery(command, code);
      if (mode === "active")
        proof = await old.provision({ ...command, recoverySaved: true }, code);
      const kit =
        mode === "empty"
          ? null
          : await old.recovery({ keyId: slot.keyId, confirmed: true });
      const status = await old.status();
      const version = await new Promise<number>((resolve, reject) => {
        const request = indexedDB.open(browserKeyDatabaseName, 11);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const version = db.version;
          db.close();
          resolve(version);
        };
      });
      return { slot, proof, prepared, kit, status, version };
    } finally {
      old.close();
    }
  },
  async legacyBoundaryOpen() {
    const url = "/legacy-key-boundary/index.js";
    const legacy = await import(/* @vite-ignore */ url);
    const old = await legacy.BrowserKeyLifecycle.open(
      owner,
      () => binding,
      () => true,
      () => now,
    );
    old.close();
  },
  validate(proof: BrowserKeyProof) {
    return lifecycle.validate(proof);
  },
  revoke(raw: unknown) {
    return lifecycle.revoke(raw);
  },
  remove(raw: unknown) {
    return lifecycle.remove(raw);
  },
  clear(raw: unknown) {
    return lifecycle.clear(raw);
  },
  reset(raw: unknown) {
    return lifecycle.reset(raw);
  },
  recovery(id: string) {
    return lifecycle.recovery({ keyId: id, confirmed: true });
  },
  async recover(kit: unknown, code: string) {
    const result = await openBrowserKeyRecovery(
      kit,
      await browserRecoveryKey(code),
    );
    return {
      identity: result.identity,
      publicKey: result.publicKey,
      privateExtractable: result.pair.privateKey.extractable,
    };
  },
  async unmanaged(a: BrowserKeyAuthority) {
    const p = await BrowserEndpointKeys.open(
      owner,
      () => a,
      () => now,
    );
    try {
      return (await p.resolve()).publicKey;
    } finally {
      p.close();
    }
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
  async legacySeed(a: BrowserKeyAuthority, code: string) {
    const legacy = await import(/* @vite-ignore */ legacyModuleUrl);
    const provider = await legacy.BrowserEndpointKeys.open(
      a.localOwner,
      () => a,
      () => now,
    );
    try {
      const made = await provider.create(
        { keyId: a.keyId, keyEpoch: a.keyEpoch, confirmed: true },
        await browserRecoveryKey(code),
      );
      const kit = await provider.recovery({ keyId: a.keyId, confirmed: true });
      return { made, kit };
    } finally {
      provider.close();
    }
  },
  async legacyOpen(a: BrowserKeyAuthority) {
    const legacy = await import(/* @vite-ignore */ legacyModuleUrl);
    const p = await legacy.BrowserEndpointKeys.open(
      a.localOwner,
      () => a,
      () => now,
    );
    p.close();
  },
  async legacyRecover(kit: unknown, code: string) {
    const legacy = await import(/* @vite-ignore */ legacyModuleUrl);
    const reopened = await legacy.openBrowserKeyRecovery(
      kit,
      await browserRecoveryKey(code),
    );
    return { identity: reopened.identity, publicKey: reopened.publicKey };
  },
  close() {
    lifecycle.close();
  },
};
declare global {
  interface Window {
    browserLifecycleTest: typeof api;
  }
}
window.browserLifecycleTest = api;
