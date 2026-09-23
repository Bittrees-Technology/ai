import { BrowserKeyHost } from "../../../modules/remote/browser-key-host.js";
import { mountBrowserSetup } from "../../../apps/remote-web/browser-setup.js";
let owner: string | null = null,
  scope = 0,
  offset = 0,
  host: BrowserKeyHost,
  view: ReturnType<typeof mountBrowserSetup> | undefined;
const transportCalls: string[] = [];
const context = () => (owner ? { ownerId: owner, scope: String(scope) } : null);
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
async function mount(id: string) {
  view?.destroy();
  host?.close();
  owner = id;
  scope++;
  offset = 0;
  transportCalls.length = 0;
  host = await BrowserKeyHost.open(
    context,
    (...args) => {
      transportCalls.push(new URL(String(args[0])).pathname);
      return globalThis.fetch(...args);
    },
    () => Date.now() + offset,
    () => performance.now() + offset,
  );
  document.body.replaceChildren();
  const root = document.createElement("main");
  document.body.append(root);
  view = mountBrowserSetup(
    root,
    host,
    () => Date.now() + offset,
    () => performance.now() + offset,
  );
}
const fixture = {
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
  async logout() {
    await api("/browser/logout", {});
    owner = null;
    scope++;
    view?.invalidate();
  },
  changeScope() {
    scope++;
    view?.invalidate();
  },
  blur() {
    window.dispatchEvent(new Event("blur"));
  },
  advance(ms: number) {
    offset += ms;
  },
  context: () => host.keyContext(),
  transportCalls: () => [...transportCalls],
  status: () => host.keyAPI.status(),
  begin: (raw: unknown) => host.keyAPI.begin(raw),
  inspect: () => host.inspect(),
  list: () => host.list(),
  register: (raw: unknown) => host.register(raw),
  revoke: (raw: unknown) => host.revoke(raw),
  destroy() {
    view?.destroy();
  },
};
declare global {
  interface Window {
    browserSetupTest: typeof fixture;
  }
}
window.browserSetupTest = fixture;
