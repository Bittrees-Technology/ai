import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { CompanionPrivateRelay } from "../apps/companion/private-relay.js";
import { PrivateRelayPanelState } from "../apps/dashboard/private-relay-state.js";
import { RemoteClient } from "../modules/remote/client.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { localApi } from "../apps/companion/http.js";
class Slot {
  value?: Uint8Array;
  afterAdd?: () => Promise<void>;
  failDelete = false;
  async getSecret() {
    return this.value ? Uint8Array.from(this.value) : undefined;
  }
  async addSecretIfAbsent(value: Uint8Array) {
    if (this.value) return false;
    this.value = Uint8Array.from(value);
    await this.afterAdd?.();
    return true;
  }
  async deleteCredential() {
    if (this.failDelete) throw Error("SENSITIVE_OS_FAILURE");
    const found = !!this.value;
    this.value = undefined;
    return found;
  }
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
function fixture() {
  let now = 1800000000000,
    mono = 1,
    calls = 0,
    acceptances = 0;
  const owner = { userId: "synthetic", tenantId: "personal" },
    vault = new Vault(randomBytes(32)),
    store = new Store(":memory:", vault);
  const status = {
    ownerId: randomUUID(),
    deviceId: randomUUID(),
    epoch: 1,
    credential: randomBytes(32).toString("base64url"),
    expiresAt: now + 3600000,
    scope: "status:publish",
  };
  let saved = Buffer.from(
    JSON.stringify({
      localOwner: owner.userId,
      grant: status,
      mode: "active",
      sequence: 1,
    }),
  );
  const credential = randomBytes(32).toString("base64url");
  let grant = {
    id: randomUUID(),
    ownerId: status.ownerId,
    endpointKind: "mac",
    endpointId: status.deviceId,
    credentialEpoch: 1,
    operationId: randomUUID(),
    revision: 1,
    state: "pending",
    createdAt: now - 1,
    expiresAt: now + 1800000,
    approvalExpiresAt: (now + 60000) as number | null,
    revokedAt: null as number | null,
  };
  const control = {
    loseRevoke: false,
    afterAdd: undefined as undefined | (() => Promise<void>),
  };
  const remote = new RemoteClient(
    owner.userId,
    {
      async getSecret() {
        return saved.slice();
      },
      async setSecret(v) {
        saved = Buffer.from(v);
      },
      async deleteCredential() {
        return true;
      },
    },
    async (url, init) => {
      calls++;
      const path = String(url).split("/device/")[1]!;
      if (path === "identity")
        return Response.json({
          version: 1,
          ownerId: status.ownerId,
          deviceId: status.deviceId,
          credentialEpoch: 1,
          expiresAt: status.expiresAt,
        });
      const bearer = new Headers(init?.headers).get("authorization");
      if (path === "relay/approval/inspect") {
        assert.equal(bearer, "Bearer " + status.credential);
        return Response.json(grant);
      }
      if (path === "relay/permission/accept") {
        assert.equal(bearer, "Bearer " + status.credential);
        assert.equal(grant.state, "pending");
        acceptances++;
        grant = {
          ...grant,
          state: "active",
          revision: 2,
          approvalExpiresAt: null,
        };
        return Response.json({ grant, credential, scope: "private:relay" });
      }
      if (path === "relay/permission/revoke") {
        assert.equal(bearer, "Bearer " + credential);
        grant = { ...grant, state: "revoked", revision: 3, revokedAt: now };
        if (control.loseRevoke)
          throw Error("lost response containing SENSITIVE_SECRET");
        return Response.json(grant);
      }
      throw Error("Unexpected route");
    },
    () => now,
    undefined,
    undefined,
    () => mono,
  );
  const slots = new Map<string, { key: Slot; attempt: Slot; deleted: Slot }>();
  const entries = {
    forSlot(_o: unknown, id: string) {
      let value = slots.get(id);
      if (!value) {
        const key = new Slot();
        key.afterAdd = () => control.afterAdd?.() ?? Promise.resolve();
        value = { key, attempt: new Slot(), deleted: new Slot() };
        slots.set(id, value);
      }
      return value;
    },
  };
  const build = (online = true, enabled = true) =>
    new CompanionPrivateRelay(
      store,
      vault,
      owner,
      entries,
      online ? remote : undefined,
      enabled,
      () => now,
      () => mono,
    );
  const controls = build();
  const confirm = (reviewId: string, c = controls) =>
    c.confirm({ reviewId, confirmed: true, acknowledged: true });
  const activate = async () =>
    confirm(
      (await controls.prepare({ action: "accept", permissionId: grant.id })).id,
    );
  const reviewRecord = (action: string, c = controls) => {
    const row = c.status().state.items[0]!;
    return c.prepare({ action, id: row.id, expectedRevision: row.revision });
  };
  return {
    owner,
    vault,
    store,
    remote,
    grant: () => grant,
    credential,
    control,
    slots,
    build,
    controls,
    confirm,
    activate,
    reviewRecord,
    calls: () => calls,
    acceptances: () => acceptances,
    advance: (ms: number) => {
      now += ms;
      mono += ms;
    },
    close: () => store.close(),
  };
}
test("Relay controls perform no constructor/status I/O and require one-use reviewed opt-in", async () => {
  const f = fixture();
  try {
    f.controls.status();
    assert.equal(f.calls(), 0);
    assert.equal(f.slots.size, 0);
    await assert.rejects(
      f
        .build(true, false)
        .prepare({ action: "accept", permissionId: f.grant().id }),
      /DENIED/,
    );
    const review = await f.controls.prepare({
      action: "accept",
      permissionId: f.grant().id,
    });
    assert.equal(f.slots.size, 0);
    await assert.rejects(
      f.controls.confirm({
        reviewId: review.id,
        confirmed: true,
        acknowledged: false,
      }),
    );
    assert.equal(f.acceptances(), 0);
    await assert.rejects(f.confirm(review.id), /DENIED/);
    const fresh = await f.controls.prepare({
      action: "accept",
      permissionId: f.grant().id,
    });
    const saved = await f.confirm(fresh.id);
    assert.equal(saved.state.items[0]!.phase, "active");
    assert.equal(saved.transportActive, false);
    assert.ok(!JSON.stringify(saved).includes(f.credential));
    await assert.rejects(f.confirm(review.id), /DENIED/);
    assert.equal(f.acceptances(), 1);
  } finally {
    f.close();
  }
});
test("Relay control reviews expire and require the exact saved revision", async () => {
  const f = fixture();
  try {
    const review = await f.controls.prepare({
      action: "accept",
      permissionId: f.grant().id,
    });
    f.advance(60000);
    await assert.rejects(f.confirm(review.id), /DENIED/);
    assert.equal(f.acceptances(), 0);
  } finally {
    f.close();
  }
  const g = fixture();
  try {
    await g.activate();
    const stale = await g.reviewRecord("remove"),
      second = g.build();
    await g.confirm((await g.reviewRecord("stop", second)).id, second);
    await assert.rejects(g.confirm(stale.id), /CONFLICT/);
    assert.equal(g.controls.status().state.items[0]!.phase, "stopped");
  } finally {
    g.close();
  }
});
test("Cancelling a relay review during native storage cannot activate its delayed result", async () => {
  const f = fixture(),
    entered = latch(),
    release = latch();
  try {
    f.control.afterAdd = async () => {
      entered.resolve();
      await release.promise;
    };
    const review = await f.controls.prepare({
      action: "accept",
      permissionId: f.grant().id,
    });
    const rejected = assert.rejects(f.confirm(review.id), /DENIED/);
    await entered.promise;
    f.controls.invalidate();
    release.resolve();
    await rejected;
    assert.equal(f.controls.status().state.items[0]!.phase, "storing");
    assert.equal(f.acceptances(), 1);
  } finally {
    release.resolve();
    f.close();
  }
});
test("Offline controls stop and clean credentials without claiming remote revocation", async () => {
  const f = fixture();
  try {
    await f.activate();
    const offline = f.build(false, false),
      before = f.calls();
    const stopped = await f.confirm(
      (await f.reviewRecord("stop", offline)).id,
      offline,
    );
    assert.equal((stopped.result as any).remoteRevocationConfirmed, false);
    const id = stopped.state.items[0]!.id;
    f.slots.get(id)!.key.failDelete = true;
    await assert.rejects(
      f.confirm((await f.reviewRecord("remove", offline)).id, offline),
      /STORAGE_UNAVAILABLE/,
    );
    assert.equal(offline.status().state.items[0]!.phase, "deleting");
    f.slots.get(id)!.key.failDelete = false;
    const cleaned = await f.confirm(
      (await offline.prepare({ action: "cleanup", after: null })).id,
      offline,
    );
    assert.equal(cleaned.state.items[0]!.phase, "deleted");
    assert.equal(f.slots.get(id)!.key.value, undefined);
    assert.equal(f.calls(), before);
  } finally {
    f.close();
  }
});
test("Lost remote revocation never produces a success receipt and can be reconciled explicitly", async () => {
  const f = fixture();
  try {
    await f.activate();
    f.control.loseRevoke = true;
    await assert.rejects(
      f.confirm((await f.reviewRecord("revoke")).id),
      /^Error: UNAVAILABLE$/,
    );
    assert.equal(f.controls.status().state.items[0]!.phase, "stopped");
    const confirmed = await f.confirm((await f.reviewRecord("revoke")).id);
    assert.equal((confirmed.result as any).remoteRevocationConfirmed, true);
  } finally {
    f.close();
  }
});
test("Authenticated relay routes redact secrets and global deletion drains native cleanup", async () => {
  const f = fixture(),
    server = createServer();
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port,
      token = randomBytes(32).toString("hex");
    server.on(
      "request",
      localApi({
        store: f.store,
        owner: f.owner,
        token,
        port,
        privateRelay: f.controls,
      }),
    );
    const call = (
      path: string,
      method = "GET",
      body?: unknown,
      extra: Record<string, string> = {},
    ) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    assert.equal(
      (await call("/v1/private-relay", "GET", undefined, { Authorization: "" }))
        .status,
      401,
    );
    assert.equal(
      (
        await call("/v1/private-relay", "GET", undefined, {
          Origin: "https://evil.invalid",
        })
      ).status,
      403,
    );
    const review = await (
      await call("/v1/private-relay/review", "POST", {
        action: "accept",
        permissionId: f.grant().id,
      })
    ).json();
    const saved = await call("/v1/private-relay/confirm", "POST", {
      reviewId: review.id,
      confirmed: true,
      acknowledged: true,
    });
    assert.equal(saved.status, 200);
    assert.ok(!(await saved.text()).includes(f.credential));
    const row = f.controls.status().state.items[0]!,
      slot = f.slots.get(row.id)!;
    slot.key.failDelete = true;
    const failed = await call("/v1/data", "DELETE", undefined, {
      "X-Confirm-Delete": "all-local-task-data",
    });
    assert.equal(failed.status, 503);
    assert.ok(!(await failed.text()).includes("SENSITIVE"));
    slot.key.failDelete = false;
    assert.equal(
      (
        await call("/v1/data", "DELETE", undefined, {
          "X-Confirm-Delete": "all-local-task-data",
        })
      ).status,
      204,
    );
    assert.equal(slot.key.value, undefined);
    assert.equal(f.controls.status().state.items[0]!.phase, "deleted");
    assert.equal(f.controls.status().state.items[0]!.permission, null);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    f.close();
  }
});
test("Global deletion refuses to overlap relay enrollment", async () => {
  const f = fixture(),
    server = createServer(),
    entered = latch(),
    release = latch();
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port,
      token = randomBytes(32).toString("hex");
    server.on(
      "request",
      localApi({
        store: f.store,
        owner: f.owner,
        token,
        port,
        privateRelay: f.controls,
      }),
    );
    const review = await f.controls.prepare({
      action: "accept",
      permissionId: f.grant().id,
    });
    f.control.afterAdd = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = f.confirm(review.id);
    await entered.promise;
    const response = await fetch(`http://127.0.0.1:${port}/v1/data`, {
      method: "DELETE",
      headers: {
        Authorization: "Bearer " + token,
        "X-Confirm-Delete": "all-local-task-data",
      },
    });
    assert.equal(response.status, 409);
    release.resolve();
    await pending;
  } finally {
    release.resolve();
    await new Promise<void>((r) => server.close(() => r()));
    f.close();
  }
});
test("Relay panel ignores delayed review after focus loss and sends a host cancellation fence", async () => {
  const held = latch(),
    entered = latch(),
    calls: string[] = [];
  const panel = new PrivateRelayPanelState(
    async (path) => {
      calls.push(path);
      if (path.endsWith("/cancel-review")) return;
      entered.resolve();
      await held.promise;
      return {
        id: randomUUID(),
        action: "accept",
        expiresAt: Date.now() + 60000,
      };
    },
    () => {},
  );
  const pending = panel.prepare("accept", undefined, randomUUID());
  await entered.promise;
  panel.hide();
  held.resolve();
  await pending;
  assert.equal(panel.state.review, null);
  assert.ok(calls.includes("/v1/private-relay/cancel-review"));
});
test("Relay panel never retries failed confirmation or claims unconfirmed remote revocation", async () => {
  let confirmations = 0;
  const panel = new PrivateRelayPanelState(
    async (path) => {
      if (path.endsWith("/review"))
        return {
          id: randomUUID(),
          action: "revoke",
          expiresAt: Date.now() + 60000,
          permission: null,
          binding: null,
          record: null,
          cleanupAfter: null,
        };
      confirmations++;
      throw Error("UNAVAILABLE");
    },
    () => {},
  );
  await panel.prepare("revoke");
  await panel.confirm(false);
  assert.equal(confirmations, 0);
  await panel.confirm(true);
  await panel.confirm(true);
  assert.equal(confirmations, 1);
  assert.equal(panel.state.review, null);
  assert.match(panel.state.error, /remote revocation is not confirmed/);
});
test("Global deletion refuses to skip retained relay credentials when the native provider is unavailable", async () => {
  const f = fixture(),
    server = createServer();
  try {
    await f.activate();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port,
      token = randomBytes(32).toString("hex");
    server.on(
      "request",
      localApi({ store: f.store, owner: f.owner, token, port }),
    );
    const response = await fetch(`http://127.0.0.1:${port}/v1/data`, {
      method: "DELETE",
      headers: {
        Authorization: "Bearer " + token,
        "X-Confirm-Delete": "all-local-task-data",
      },
    });
    assert.equal(response.status, 409);
    assert.equal(f.controls.status().state.items[0]!.phase, "active");
    assert.ok(f.slots.values().next().value!.key.value);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    f.close();
  }
});
test("Relay panel rejects malformed status without exposing response details or inventing availability", async () => {
  const panel = new PrivateRelayPanelState(
    async () => ({ secret: "SENSITIVE_RESPONSE" }),
    () => {},
  );
  await panel.refresh();
  assert.equal(panel.state.status, null);
  assert.ok(panel.state.error.length > 0);
  assert.ok(!panel.state.error.includes("SENSITIVE_RESPONSE"));
});
test("Actual relay controls round-trip through the frontend projection without exposing credentials", async () => {
  const f = fixture();
  try {
    const panel = new PrivateRelayPanelState(
      async (path, _method, body) => {
        if (path === "/v1/private-relay") return f.controls.status();
        if (path.endsWith("/review")) return f.controls.prepare(body);
        if (path.endsWith("/confirm")) return f.controls.confirm(body);
        if (path.endsWith("/cancel-review")) {
          f.controls.invalidate();
          return;
        }
        throw Error("Unexpected route");
      },
      () => {},
      () => 1800000000000,
    );
    await panel.refresh();
    await panel.prepare("accept", undefined, f.grant().id);
    assert.equal(panel.state.review?.permission?.id, f.grant().id);
    await panel.confirm(true);
    assert.equal(panel.state.error, "");
    assert.match(panel.state.notice, /Connection saved/);
    assert.equal(panel.state.status?.state.items[0]!.phase, "active");
    assert.ok(!JSON.stringify(panel.state).includes(f.credential));
    await panel.prepare("revoke", panel.state.status!.state.items[0]);
    await panel.confirm(true);
    assert.equal(panel.state.error, "");
    assert.match(panel.state.notice, /Remote revocation confirmed/);
    assert.equal(
      panel.state.status?.state.items[0]!.permission!.state,
      "revoked",
    );
  } finally {
    f.close();
  }
});
