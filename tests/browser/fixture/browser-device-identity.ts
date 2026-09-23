import { BrowserDeviceClient } from "../../../modules/remote/browser-device-client.js";
import { BrowserKeyLifecycle } from "../../../modules/remote/browser-key-lifecycle.js";
import { newBrowserRecoveryCode } from "../../../modules/remote/browser-key-recovery.js";
import type { VerifiedBrowserDeviceScope } from "../../../modules/remote/browser-device-contracts.js";
import type { PrivateBinding } from "../../../modules/remote/private-peer-contracts.js";
let client: BrowserDeviceClient,
  keys: BrowserKeyLifecycle,
  owner: string | null = null,
  scopeId = 0,
  binding: PrivateBinding | null = null,
  active: VerifiedBrowserDeviceScope | null = null,
  entered = 0,
  held = false,
  release: (() => void) | undefined;
async function api(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "X-Bittrees-Request": "1",
      ...(owner ? { "X-Bittrees-Account": owner } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw Error("DENIED");
  return response.json();
}
async function host(id: string) {
  client?.invalidate();
  keys?.close();
  active = null;
  owner = id;
  scopeId++;
  client = new BrowserDeviceClient(() =>
    owner ? { ownerId: owner, scope: String(scopeId) } : null,
  );
  keys = await BrowserKeyLifecycle.open(
    "browser:" + id,
    () => active?.current() ?? null,
    (b) => active?.freshRegistration(b) ?? false,
  );
  const s = await client.inspect();
  binding = s.registration?.binding ?? null;
}
async function verified<T>(fn: () => Promise<T>) {
  if (!binding) throw Error("DENIED");
  return client.withVerifiedDevice(binding, async (s) => {
    entered++;
    active = s;
    try {
      return await fn();
    } finally {
      active = null;
    }
  });
}
const fixture = {
  challenge(address: string) {
    return api("/browser/login/challenge", { address });
  },
  async login(message: string, signature: string) {
    const result = await api("/browser/login/verify", { message, signature });
    await host(result.ownerId);
    return result.ownerId as string;
  },
  async resume() {
    const s = await api("/browser/session", {});
    await host(s.ownerId);
  },
  async register(raw: unknown) {
    const result = await client.register(raw);
    binding = result.binding;
    keys.invalidate();
    return result;
  },
  inspect: () => client.inspect(),
  list: () => client.list(),
  binding: () => binding,
  code: () => newBrowserRecoveryCode(),
  begin(raw: unknown) {
    return verified(() => keys.begin(raw));
  },
  prepare(raw: unknown, code: string) {
    return verified(() => keys.prepareRecovery(raw, code));
  },
  activate(raw: unknown, code: string, kit: unknown) {
    return verified(() => keys.activatePrepared(raw, code, kit));
  },
  resolve() {
    return verified(async () => (await keys.resolve()).proof);
  },
  status: () => keys.status(),
  async fresh() {
    return verified(async () => active!.freshRegistration(binding!));
  },
  async revoke(raw: unknown) {
    return client.revoke(raw);
  },
  async logout() {
    await api("/browser/logout", {});
    fixture.invalidate();
    owner = null;
  },
  invalidate() {
    scopeId++;
    client.invalidate();
    keys.invalidate();
    active = null;
  },
  entered: () => entered,
  async holdVerified() {
    return verified(async () => {
      held = true;
      await new Promise<void>((r) => {
        release = r;
      });
      held = false;
      return "must not survive revoked verification";
    });
  },
  held: () => held,
  release() {
    release?.();
    release = undefined;
  },
};
declare global {
  interface Window {
    browserDeviceIdentityTest: typeof fixture;
  }
}
window.browserDeviceIdentityTest = fixture;
