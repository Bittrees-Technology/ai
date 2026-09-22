import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
const moduleUrl = new URL("../apps/remote-web/controller.js", import.meta.url)
  .href;
const { RemoteWebController } = await import(moduleUrl);
const address = "0x" + "a".repeat(40),
  ownerId = randomUUID();
const account = {
  ownerId,
  address,
  chainId: 1,
  expiresAt: Date.now() + 3600000,
};
function wallet() {
  return {
    request: async ({ method }: any) =>
      method === "eth_chainId"
        ? "0x1"
        : method === "personal_sign"
          ? "signature"
          : [address],
  };
}
test("Hosted panel signs only on explicit login, checks wallet and keeps approval separate", async () => {
  const calls: any[] = [];
  const c = new RemoteWebController(
    async (path: string, body: any) => {
      calls.push({ path, body });
      if (path.endsWith("session")) return account;
      if (path.endsWith("challenge")) return { message: "server message" };
      return { ownerId };
    },
    wallet(),
    { chainId: 1 },
    () => {},
  );
  await c.refresh();
  assert.deepEqual(
    calls.map((x) => x.path),
    ["/browser/session"],
  );
  await c.login();
  assert.ok(calls.some((x) => x.path === "/browser/login/verify"));
  assert.ok(!calls.some((x) => x.path.includes("approve")));
  const details = randomUUID() + "." + randomBytes(32).toString("base64url");
  const before = calls.length;
  await c.approve(details, false);
  assert.equal(calls.length, before);
  await c.approve(details, true);
  assert.equal(c.state.confirmation, ownerId);
  c.hide();
  assert.equal(c.state.confirmation, "");
});
test("Hosted panel rejects wallet network mismatch and drops approval handoff after focus loss", async () => {
  const calls: string[] = [];
  const wrongWallet = {
    request: async ({ method }: any) =>
      method === "eth_chainId" ? "0x2" : [address],
  };
  const wrong = new RemoteWebController(
    async (path: string) => {
      calls.push(path);
    },
    wrongWallet,
    { chainId: 1 },
    () => {},
  );
  await wrong.login();
  assert.equal(calls.length, 0);
  assert.match(wrong.state.error, /network/);
  let resolve!: (value: any) => void;
  const pending = new Promise((r) => {
    resolve = r;
  });
  const c = new RemoteWebController(
    async (path: string) => (path.endsWith("session") ? account : pending),
    null,
    { chainId: 1 },
    () => {},
  );
  await c.refresh();
  const action = c.approve(
    randomUUID() + "." + randomBytes(32).toString("base64url"),
    true,
  );
  c.hide();
  resolve({ ownerId });
  await action;
  assert.equal(c.state.confirmation, "");
});
test("Hosted panel wallet changes clear identity and require server logout", async () => {
  const calls: string[] = [];
  const c = new RemoteWebController(
    async (path: string) => {
      calls.push(path);
      return account;
    },
    null,
    { chainId: 1 },
    () => {},
  );
  await c.refresh();
  assert.equal(c.state.account.ownerId, ownerId);
  await c.walletChanged();
  assert.equal(c.state.account, null);
  assert.equal(calls.at(-1), "/browser/logout");
});

test("Wallet change cannot restore an old account's late device list", async () => {
  let resolve!: (v: any) => void;
  const delayed = new Promise((r) => {
    resolve = r;
  });
  const c = new RemoteWebController(
    async (path: string) => (path === "/browser/devices" ? delayed : account),
    null,
    { chainId: 1 },
    () => {},
  );
  await c.refresh();
  const loading = c.devices();
  await c.walletChanged();
  resolve({ items: [{ id: "old-device" }], nextCursor: null });
  await loading;
  assert.equal(c.state.account, null);
  assert.deepEqual(c.state.devices, []);
});

test("Browser transport sends the displayed account and updates it between requests", async () => {
  const { browserApi } = await import(moduleUrl);
  let displayed: string | null = ownerId;
  const requests: any[] = [];
  const api = browserApi(
    async (path: string, init: any) => {
      requests.push({ path, ...init });
      return Response.json({});
    },
    () => displayed,
  );
  await api("/browser/devices", {});
  assert.equal(requests[0].headers["X-Bittrees-Account"], ownerId);
  assert.equal(requests[0].credentials, "same-origin");
  displayed = randomUUID();
  await api("/browser/controls/approve", {});
  assert.equal(requests[1].headers["X-Bittrees-Account"], displayed);
  displayed = null;
  await api("/browser/session", {});
  assert.equal(requests[2].headers["X-Bittrees-Account"], undefined);
});

test("Command review is explicit, retries a fixed intent and distinguishes receipt outcomes", async () => {
  const calls: any[] = [],
    deviceId = randomUUID(),
    taskId = randomUUID();
  let loseResponse = true;
  const c = new RemoteWebController(
    async (path: string, body: any) => {
      calls.push({ path, body: structuredClone(body) });
      if (path === "/browser/commands" && loseResponse) {
        loseResponse = false;
        throw Error("UNAVAILABLE");
      }
      if (path.endsWith("receipt"))
        return { state: "acknowledged", receipt: { outcome: "conflict" } };
      return {};
    },
    wallet(),
    { chainId: 1 },
    () => {},
  );
  c.set({
    account,
    devices: [
      {
        id: deviceId,
        epoch: 1,
        controlsEnabled: true,
        expiresAt: Date.now() + 60000,
        revoked: false,
      },
    ],
    deviceId,
    statuses: [{ id: taskId, status: "running", revision: 4 }],
  });
  await c.controls(deviceId, true, false);
  assert.equal(calls.length, 0);
  c.reviewCommand(taskId, "resume");
  assert.equal(c.state.commandReview, null);
  c.reviewCommand(taskId, "pause");
  const original = structuredClone(c.state.commandReview);
  assert.equal(calls.length, 0);
  await c.submitCommand(false);
  assert.equal(calls.length, 0);
  await c.submitCommand(true);
  assert.deepEqual(c.state.commandReview, original);
  await c.submitCommand(true);
  assert.deepEqual(calls[0].body, calls[1].body);
  assert.equal(c.state.commandResult.state, "pending");
  await c.commandReceipt();
  assert.equal(c.state.commandResult.receipt.outcome, "conflict");
  c.hide();
  assert.equal(c.state.commandResult, null);
  assert.equal(c.state.commandReview, null);
});

test("Control approval needs a current device and late command responses cannot restore hidden review", async () => {
  let resolve!: (v: any) => void;
  const pending = new Promise((r) => {
    resolve = r;
  });
  const calls: any[] = [],
    deviceId = randomUUID(),
    taskId = randomUUID();
  const c = new RemoteWebController(
    async (path: string, body: any) => {
      calls.push({ path, body });
      return path === "/browser/commands" ? pending : {};
    },
    wallet(),
    { chainId: 1 },
    () => {},
  );
  c.set({
    account,
    devices: [
      {
        id: deviceId,
        epoch: 3,
        controlsEnabled: true,
        expiresAt: Date.now() + 60000,
        revoked: false,
      },
    ],
    deviceId,
    statuses: [{ id: taskId, status: "running", revision: 2 }],
  });
  await c.controls(deviceId, true, true);
  assert.deepEqual(calls[0].body, {
    deviceId,
    expectedEpoch: 3,
    confirmed: true,
  });
  c.reviewCommand(taskId, "cancel");
  const submit = c.submitCommand(true);
  c.hide();
  resolve({});
  await submit;
  assert.equal(c.state.commandResult, null);
  assert.equal(c.state.commandReview, null);
  c.set({
    statuses: [{ id: taskId, status: "cancelled", revision: 3 }],
    deviceId,
  });
  c.reviewCommand(taskId, "cancel");
  assert.equal(c.state.commandReview, null);
});
