import {
  mountBrowserKeys,
  type BrowserKeyViewContext,
} from "../../../apps/remote-web/browser-keys.js";
import { BrowserKeyLifecycle } from "../../../modules/remote/browser-key-lifecycle.js";
import { newBrowserRecoveryCode } from "../../../modules/remote/browser-key-recovery.js";
import type { PrivateBinding } from "../../../modules/remote/private-peer-contracts.js";
let lifecycle: BrowserKeyLifecycle,
  view: ReturnType<typeof mountBrowserKeys> | undefined,
  owner = "",
  binding: PrivateBinding | null = null,
  fresh = true,
  now = Date.now(),
  identity = "session-1",
  holdName = "",
  release: (() => void) | undefined,
  failStatus = false;
const calls: string[] = [],
  urls = new Set<string>();
const create = URL.createObjectURL.bind(URL),
  revoke = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = (blob) => {
  const u = create(blob);
  urls.add(u);
  return u;
};
URL.revokeObjectURL = (u) => {
  urls.delete(u);
  revoke(u);
};
async function invoke<T>(name: string, fn: () => Promise<T>) {
  calls.push(name);
  if (name === "status" && failStatus) {
    failStatus = false;
    throw Error("STORAGE_UNAVAILABLE");
  }
  const result = await fn();
  if (name === holdName) {
    holdName = "";
    await new Promise<void>((r) => {
      release = r;
    });
  }
  return result;
}
const context = (): BrowserKeyViewContext => ({
  scope: identity,
  localOwner: owner,
  binding,
  freshRegistration: fresh,
});
const api = {
  async init(o: string, b: PrivateBinding, time: number) {
    view?.destroy();
    lifecycle?.close();
    owner = o;
    binding = b;
    now = time;
    fresh = true;
    lifecycle = await BrowserKeyLifecycle.open(
      owner,
      () => binding,
      () => fresh,
      () => now,
    );
    document.body.replaceChildren();
    const root = document.createElement("main");
    document.body.append(root);
    view = mountBrowserKeys(
      root,
      {
        status: () => invoke("status", () => lifecycle.status()),
        begin: (raw) => invoke("begin", () => lifecycle.begin(raw)),
        prepareRecovery: (raw, code) =>
          invoke("prepare", () => lifecycle.prepareRecovery(raw, code)),
        activatePrepared: (raw, code, kit) =>
          invoke("activate", () => lifecycle.activatePrepared(raw, code, kit)),
        recovery: (raw) => invoke("export", () => lifecycle.recovery(raw)),
        revoke: (raw) => invoke("revoke", () => lifecycle.revoke(raw)),
        remove: (raw) => invoke("remove", () => lifecycle.remove(raw)),
        clear: (raw) => invoke("clear", () => lifecycle.clear(raw)),
        reset: (raw) => invoke("reset", () => lifecycle.reset(raw)),
        invalidate: () => lifecycle.invalidate(),
      },
      context,
      () => now,
    );
  },
  status: () => lifecycle.status(),
  async resolve() {
    return (await lifecycle.resolve()).proof;
  },
  set(b: PrivateBinding | null, f = fresh) {
    binding = b;
    fresh = f;
    view?.invalidate();
  },
  scope(s: string) {
    identity = s;
    view?.invalidate();
  },
  time(t: number) {
    now = t;
  },
  hold(name: string) {
    holdName = name;
  },
  held() {
    return !!release;
  },
  release() {
    release?.();
    release = undefined;
  },
  failStatus() {
    failStatus = true;
  },
  calls() {
    return [...calls];
  },
  urls() {
    return urls.size;
  },
  code: () => newBrowserRecoveryCode(),
  async replace() {
    const other = await BrowserKeyLifecycle.open(
      owner,
      () => binding,
      () => fresh,
      () => now,
    );
    try {
      return await other.begin({
        expectedRevision: (await other.status()).revision,
        confirmed: true,
      });
    } finally {
      other.close();
    }
  },
  prepare: (raw: unknown, code: string) => lifecycle.prepareRecovery(raw, code),
  activate: (raw: unknown, code: string, kit: unknown) =>
    lifecycle.activatePrepared(raw, code, kit),
  kit: (keyId: string) => lifecycle.recovery({ keyId, confirmed: true }),
  destroy() {
    view?.destroy();
  },
};
declare global {
  interface Window {
    browserKeyControlsTest: typeof api;
  }
}
window.browserKeyControlsTest = api;
