import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { localApi } from "../apps/companion/http.js";
import type { PrivateBinding } from "../modules/remote/private-peer-contracts.js";

import { macRelayFixture as fixture } from "./helpers/mac-relay.js";

test("Mac relay pull admits before acknowledging, recovers a lost reply across SQLite reopen and never claims a browser task receipt", async () => {
  const g = await fixture();
  try {
    g.control.loseAck = true;
    await assert.rejects(g.check());
    const saved = g.f.b.store.export(g.f.b.owner);
    assert.equal(saved.length, 1);
    const first = saved[0]!;
    g.reopen();
    g.control.loseAck = false;
    const result = await g.check();
    assert.equal(result.received?.taskId, first.id);
    assert.equal(result.received?.status, "accepted-locally");
    assert.equal(result.transport?.transportOnly, true);
    assert.equal(result.transport?.receipt.state, "received");
    assert.equal(g.f.b.store.export(g.f.b.owner).length, 1);
    assert.equal(g.f.b.controls.taskStatus().responses.length, 0);
    const task = g.f.b.store.get(g.f.b.owner, first.id);
    assert.equal(task.input.modelProfileId, "local");
    assert.deepEqual(task.input.sourceRefs, []);
    assert.equal(task.input.memoryIds, undefined);
    assert.doesNotMatch(
      JSON.stringify(result),
      /Synthetic private prompt|credential|publicKey|ciphertext/,
    );
    assert.deepEqual(await g.check(), { received: null, nextCursor: null });
    assert.equal(
      g.control.calls.filter((p) => p.endsWith("acknowledge")).length,
      2,
    );
    await g.f.work();
    assert.equal(g.f.b.store.get(g.f.b.owner, first.id).status, "completed");
  } finally {
    g.close();
  }
});

test("Mac relay pull denies disabled task or relay access, stale revisions, forged authority and unauthenticated ciphertext without acknowledging", async () => {
  const g = await fixture();
  try {
    const calls = g.control.calls.length;
    await assert.rejects(
      g.f.b.build(false).checkRelayedTask(g.relay, g.input()),
      /DENIED/,
    );
    await assert.rejects(
      g.f.b.controls.checkRelayedTask(g.build(false), g.input()),
      /DENIED/,
    );
    assert.equal(g.control.calls.length, calls);
    await assert.rejects(
      g.f.b.controls.checkRelayedTask(g.relay, {
        ...g.input(),
        expectedRevision: 999,
      }),
      /CONFLICT/,
    );
    assert.throws(() =>
      g.f.b.controls.checkRelayedTask(g.relay, {
        ...g.input(),
        current: g.f.b.grant,
      }),
    );
    await g.tamper();
    await assert.rejects(g.check(), /DENIED/);
    assert.equal(g.f.b.store.export(g.f.b.owner).length, 0);
    assert.equal(
      g.control.calls.filter((p) => p.endsWith("acknowledge")).length,
      0,
    );
  } finally {
    g.close();
  }
  const h = await fixture();
  try {
    const state = h.f.b.controls.permissionStatus();
    const grant = state.grants[0]!;
    const review = await h.f.b.controls.preparePermission({
      action: "revoke",
      peerId: grant.choices.peerId,
      expectedRevision: state.revision,
    });
    await h.f.b.controls.confirmPermission({
      reviewId: review.id,
      confirmed: true,
      acknowledged: true,
    });
    await assert.rejects(h.check(), /DENIED/);
    assert.equal(h.f.b.store.export(h.f.b.owner).length, 0);
    assert.equal(
      h.control.calls.filter((p) => p.endsWith("acknowledge")).length,
      0,
    );
  } finally {
    h.close();
  }
});

test("Mac relay scope fences stop or expiry during a native read while excluding concurrent mutation and deletion", async () => {
  for (const reason of ["stop", "expiry"]) {
    const g = await fixture();
    let release!: () => void;
    try {
      let entered!: () => void;
      const reached = new Promise<void>((r) => (entered = r)),
        held = new Promise<void>((r) => (release = r));
      [...g.f.b.slots.values()][0]!.key.beforeRead = async () => {
        entered();
        await held;
      };
      const pending = g.check();
      const rejected = assert.rejects(pending);
      await Promise.race([
        reached,
        pending.then(() => {
          throw Error("Expected a held native read");
        }),
      ]);
      assert.equal(g.relay.busy, true);
      assert.equal(g.f.b.controls.busy, true);
      await assert.rejects(g.check(), /BUSY/);
      await assert.rejects(g.f.b.controls.clearAll(), /BUSY/);
      await assert.rejects(
        g.relay.prepare({
          action: "stop",
          id: g.input().id,
          expectedRevision: g.input().expectedRevision,
        }),
        /BUSY/,
      );
      if (reason === "stop") g.relay.invalidate();
      else g.f.advance(30001);
      release();
      await rejected;
      assert.equal(g.f.b.store.export(g.f.b.owner).length, 0);
      assert.equal(
        g.control.calls.filter((p) => p.endsWith("acknowledge")).length,
        0,
      );
      assert.equal(g.relay.busy, false);
      assert.equal(g.f.b.controls.busy, false);
    } finally {
      release?.();
      g.close();
    }
  }
});

test("Mac relay metadata authority and transport cannot escape their native callback", async () => {
  const g = await fixture();
  try {
    let retained: (() => PrivateBinding | null) | undefined;
    let retainedClient: any;
    const { id, expectedRevision } = g.input();
    await g.relay.withTransport(
      { id, expectedRevision },
      async (client, current) => {
        retained = current;
        retainedClient = client;
        assert.equal(current()?.deviceId, g.f.b.grant.deviceId);
        assert.doesNotMatch(
          JSON.stringify(current()),
          /credential"|private:relay/,
        );
      },
    );
    assert.equal(retained!(), null);
    await assert.rejects(
      retainedClient.poll({ after: null, limit: 1 }),
      /DENIED/,
    );
  } finally {
    g.close();
  }
});

test("Mac relay receive HTTP route enforces loopback authentication, origin and exact explicit input", async () => {
  const g = await fixture(),
    server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port,
    token = "t".repeat(64);
  server.on(
    "request",
    localApi({
      store: g.f.b.store,
      owner: g.f.b.owner,
      port,
      token,
      privateKeys: g.f.b.controls,
      privateRelay: g.relay,
    }),
  );
  const post = (body: unknown, headers = {}) =>
    fetch(`http://127.0.0.1:${port}/v1/private-relay/check-task`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post(g.input(), { Authorization: "" })).status, 401);
    assert.equal(
      (await post(g.input(), { Origin: "https://evil.invalid" })).status,
      403,
    );
    assert.equal((await post({ ...g.input(), confirmed: false })).status, 400);
    assert.equal(
      (await post({ ...g.input(), modelProfileId: "server-selected" })).status,
      400,
    );
    assert.equal(g.f.b.store.export(g.f.b.owner).length, 0);
    const response = await post(g.input());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).received.status, "accepted-locally");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    g.close();
  }
});

test("A saved acknowledgement with a lost reply leaves exactly one inspectable local task and a persisted stop blocks later pulls", async () => {
  const g = await fixture();
  try {
    g.control.loseAck = true;
    g.control.ackAfterSave = true;
    await assert.rejects(g.check());
    assert.equal(g.f.b.store.export(g.f.b.owner).length, 1);
    g.reopen();
    g.control.loseAck = false;
    assert.deepEqual(await g.check(), { received: null, nextCursor: null });
    assert.equal(g.f.b.store.export(g.f.b.owner).length, 1);
    const { id, expectedRevision } = g.input();
    const review = await g.relay.prepare({
      action: "stop",
      id,
      expectedRevision,
    });
    await g.relay.confirm({
      reviewId: review.id,
      confirmed: true,
      acknowledged: true,
    });
    g.reopen();
    const before = g.control.calls.length;
    await assert.rejects(g.check(), /DENIED/);
    assert.equal(g.control.calls.length, before);
    assert.equal(g.f.b.controls.taskStatus().responses.length, 0);
  } finally {
    g.close();
  }
});
