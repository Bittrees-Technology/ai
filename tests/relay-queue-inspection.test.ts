import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { localApi } from "../apps/companion/http.js";
import { macRelayFixture as fixture } from "./helpers/mac-relay.js";

test("Mac queue inspection reports bounded transport metadata without opening or accepting bad ciphertext", async () => {
  const g = await fixture();
  try {
    await g.tamper();
    let reads = 0;
    for (const slot of g.f.b.slots.values())
      slot.key.beforeRead = async () => {
        reads++;
      };
    const result = await g.f.b.controls.inspectRelayedTask(g.relay, g.input());
    assert.equal(result.transportOnly, true);
    assert.equal(
      result.item!.selection.messageId,
      g.wire.envelope.header.messageId,
    );
    assert.deepEqual(result.item!.cursor, {
      messageId: result.item!.selection.messageId,
      storedAt: result.item!.selection.storedAt,
    });
    assert.equal(reads, 0);
    assert.equal(g.f.b.store.export(g.f.b.owner).length, 0);
    assert.doesNotMatch(
      JSON.stringify(result),
      /ciphertext|credential|publicKey|Synthetic private prompt|senderId/,
    );
    await assert.rejects(g.check(), /DENIED/);
    assert.equal(
      g.control.calls.filter((p) => p.endsWith("acknowledge")).length,
      0,
    );
  } finally {
    g.close();
  }
});

test("Mac selected queue check rejects changed or disappeared selections before admission and accepts only the exact current item", async () => {
  const g = await fixture();
  try {
    const selected = (
      await g.f.b.controls.inspectRelayedTask(g.relay, g.input())
    ).item!;
    for (const selection of [
      { ...selected.selection, messageId: randomUUID() },
      { ...selected.selection, envelopeHash: "f".repeat(64) },
      { ...selected.selection, revision: selected.selection.revision + 1 },
      { ...selected.selection, storedAt: selected.selection.storedAt + 1 },
    ])
      await assert.rejects(
        g.f.b.controls.checkRelayedTask(g.relay, { ...g.input(), selection }),
        /CONFLICT/,
      );
    await assert.rejects(
      g.f.b.controls.checkRelayedTask(g.relay, {
        ...g.input(),
        after: selected.cursor,
        selection: selected.selection,
      }),
      /CONFLICT/,
    );
    assert.equal(g.f.b.store.export(g.f.b.owner).length, 0);
    assert.equal(
      g.control.calls.filter((p) => p.endsWith("acknowledge")).length,
      0,
    );
    const received = await g.f.b.controls.checkRelayedTask(g.relay, {
      ...g.input(),
      selection: selected.selection,
    });
    assert.equal(received.received!.messageId, selected.selection.messageId);
    assert.equal(g.f.b.store.export(g.f.b.owner).length, 1);
  } finally {
    g.close();
  }
});

test("Mac queue inspection requires enabled current custody and rejects forged authority or unbounded page inputs", async () => {
  const g = await fixture();
  try {
    const calls = g.control.calls.length;
    await assert.rejects(
      g.f.b.build(false).inspectRelayedTask(g.relay, g.input()),
      /DENIED/,
    );
    await assert.rejects(
      g.f.b.controls.inspectRelayedTask(g.build(false), g.input()),
      /DENIED/,
    );
    assert.equal(g.control.calls.length, calls);
    await assert.rejects(
      g.f.b.controls.inspectRelayedTask(g.relay, {
        ...g.input(),
        expectedRevision: 999,
      }),
      /CONFLICT/,
    );
    for (const extra of [
      { limit: 20 },
      { current: g.f.b.grant },
      { confirmed: false },
    ])
      assert.throws(() =>
        g.f.b.controls.inspectRelayedTask(g.relay, { ...g.input(), ...extra }),
      );
    assert.equal(g.f.b.store.export(g.f.b.owner).length, 0);
  } finally {
    g.close();
  }
});

test("Mac queue metadata cannot escape a cancelled or expired native poll scope", async () => {
  for (const reason of ["stop", "expiry"]) {
    const g = await fixture();
    try {
      g.control.beforePoll = async () => {
        if (reason === "stop") g.relay.invalidate();
        else g.f.advance(30001);
      };
      await assert.rejects(
        g.f.b.controls.inspectRelayedTask(g.relay, g.input()),
      );
      assert.equal(g.f.b.store.export(g.f.b.owner).length, 0);
      assert.equal(
        g.control.calls.filter((p) => p.endsWith("acknowledge")).length,
        0,
      );
    } finally {
      g.close();
    }
  }
});

test("Mac queue inspection local HTTP requires loopback authentication and explicit bounded input", async () => {
  const g = await fixture(),
    server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port,
    token = "q".repeat(64);
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
    fetch(`http://127.0.0.1:${port}/v1/private-relay/inspect-task`, {
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
    assert.equal((await post({ ...g.input(), limit: 20 })).status, 400);
    const response = await post(g.input());
    assert.equal(response.status, 200);
    assert.equal(
      (await response.json()).item.selection.messageId,
      g.wire.envelope.header.messageId,
    );
    const inspected = await g.f.b.controls.inspectRelayedTask(
      g.relay,
      g.input(),
    );
    const conflict = await fetch(
      `http://127.0.0.1:${port}/v1/private-relay/check-task`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...g.input(),
          selection: { ...inspected.item!.selection, messageId: randomUUID() },
        }),
      },
    );
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error, "CONFLICT");
    assert.equal(g.f.b.store.export(g.f.b.owner).length, 0);
    assert.equal(
      g.control.calls.filter((p) => p.endsWith("acknowledge")).length,
      0,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    g.close();
  }
});
