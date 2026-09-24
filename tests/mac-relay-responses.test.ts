import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { localApi } from "../apps/companion/http.js";
import { macRelayFixture as fixture } from "./helpers/mac-relay.js";
type Fixture = Awaited<ReturnType<typeof fixture>>;
function connection(g: Fixture) {
  const { id, expectedRevision } = g.input();
  return { id, expectedRevision };
}
function prepareInput(g: Fixture, kind: "accepted" | "result" = "accepted") {
  return {
    connection: connection(g),
    response: {
      operationId: g.wire.envelope.header.operationId,
      peerId: g.f.a.grant.deviceId,
      kind,
      confirmed: true,
    },
    confirmed: true,
  };
}
function sendInput(g: Fixture, id: string, revision?: number) {
  const current = g.f.b.controls
    .taskStatus()
    .responses.find((r) => r.id === id)!;
  return {
    connection: connection(g),
    response: {
      id,
      expectedRevision: revision ?? current.revision,
      confirmed: true,
    },
    confirmed: true,
  };
}
const prepare = (g: Fixture, kind: "accepted" | "result" = "accepted") =>
  g.f.b.controls.prepareRelayedResponse(g.relay, prepareInput(g, kind));
const send = (g: Fixture, id: string, revision?: number) =>
  g.f.b.controls.sendRelayedResponse(g.relay, sendInput(g, id, revision));

test("Native relay responses cap both leases and deliver authenticated acceptance and source-free result without exposing ciphertext in local API metadata", async () => {
  const g = await fixture();
  try {
    const admitted = await g.check();
    const accepted = await prepare(g);
    assert.equal(accepted.expiresAt, g.control.recipientExpiresAt);
    assert.equal(accepted.attempts, 0);
    assert.equal((await prepare(g)).id, accepted.id);
    assert.equal(g.outgoing.size, 0);
    const stored = await send(g, accepted.id);
    assert.equal(stored.transportOnly, true);
    assert.equal(stored.receipt.state, "stored");
    const encrypted = g.outgoing.get(stored.receipt.messageId)!.envelope;
    const browser = await g.f.withOutbox((o) => o.acceptReceipt(encrypted));
    assert.equal(browser.value.receipt?.taskId, admitted.received!.taskId);
    await g.f.work();
    const result = await prepare(g, "result"),
      resultSent = await send(g, result.id);
    const wire = g.outgoing.get(resultSent.receipt.messageId)!.envelope;
    assert.equal(
      (await g.f.open(wire)).task.output,
      "Synthetic private result",
    );
    assert.equal(g.outgoing.size, 2);
    assert.doesNotMatch(
      JSON.stringify({ accepted, stored, result, resultSent }),
      /Synthetic private|ciphertext|publicKey|credential"/,
    );
  } finally {
    g.close();
  }
});

test("A lost native submission reply preserves the exact response across restart and requires the latest saved revision for explicit retry", async () => {
  const g = await fixture();
  try {
    await g.check();
    const prepared = await prepare(g);
    g.control.loseSubmit = true;
    await assert.rejects(send(g, prepared.id));
    assert.equal(g.outgoing.size, 1);
    const original = structuredClone([...g.outgoing.values()][0]!);
    g.reopen();
    g.control.loseSubmit = false;
    const calls = g.control.calls.length;
    await assert.rejects(send(g, prepared.id, prepared.revision), /CONFLICT/);
    assert.equal(g.control.calls.length, calls);
    const retried = await send(g, prepared.id);
    assert.equal(retried.duplicate, true);
    assert.deepEqual(g.outgoing.get(retried.receipt.messageId), original);
    assert.equal(g.f.b.controls.taskStatus().responses[0]!.attempts, 2);
    assert.equal(g.outgoing.size, 1);
    assert.equal((await prepare(g)).id, prepared.id);
  } finally {
    g.close();
  }
});

test("A shorter or revoked browser relay permission cannot reseal or extend a retained native response", async () => {
  const g = await fixture();
  try {
    await g.check();
    const prepared = await prepare(g);
    g.control.recipientExpiresAt -= 1000;
    await assert.rejects(send(g, prepared.id), /DENIED/);
    await assert.rejects(prepare(g), /DENIED/);
    const status = g.f.b.controls.taskStatus().responses[0]!;
    assert.equal(status.expiresAt, prepared.expiresAt);
    assert.equal(status.attempts, 0);
    assert.equal(status.revision, prepared.revision);
    assert.equal(g.outgoing.size, 0);
    g.control.denyRecipient = true;
    await assert.rejects(send(g, prepared.id), /DENIED/);
    assert.equal(g.outgoing.size, 0);
  } finally {
    g.close();
  }
});

test("Native result sending needs separate current consent and disabled relay/task setup cannot contact the recipient", async () => {
  const g = await fixture();
  try {
    await g.f.grant(g.f.b, g.f.a, true, { sendResults: false });
    await g.check();
    await g.f.work();
    await assert.rejects(prepare(g, "result"), /DENIED/);
    const accepted = await prepare(g);
    assert.equal(accepted.kind, "accepted");
    const calls = g.control.calls.length;
    await assert.rejects(
      g.f.b.build(false).prepareRelayedResponse(g.relay, prepareInput(g)),
      /DENIED/,
    );
    await assert.rejects(
      g.f.b.controls.sendRelayedResponse(
        g.build(false),
        sendInput(g, accepted.id),
      ),
      /DENIED/,
    );
    assert.equal(g.control.calls.length, calls);
    const state = g.f.b.controls.permissionStatus();
    const review = await g.f.b.controls.preparePermission({
      action: "revoke",
      peerId: g.f.a.grant.deviceId,
      expectedRevision: state.revision,
    });
    await g.f.b.controls.confirmPermission({
      reviewId: review.id,
      confirmed: true,
      acknowledged: true,
    });
    await assert.rejects(send(g, accepted.id), /DENIED/);
    assert.equal(g.outgoing.size, 0);
  } finally {
    g.close();
  }
});

test("Stopping during native response recipient inspection sends nothing and serializes against deletion", async () => {
  const g = await fixture();
  let release!: () => void;
  try {
    await g.check();
    const prepared = await prepare(g);
    let entered!: () => void;
    const reached = new Promise<void>((r) => (entered = r)),
      held = new Promise<void>((r) => (release = r));
    g.control.beforeRecipient = async () => {
      entered();
      await held;
    };
    const pending = send(g, prepared.id),
      denied = assert.rejects(pending);
    await Promise.race([
      reached,
      pending.then(() => {
        throw Error("Expected held inspection");
      }),
    ]);
    assert.equal(g.relay.busy, true);
    assert.equal(g.f.b.controls.busy, true);
    await assert.rejects(g.f.b.controls.clearAll(), /BUSY/);
    g.relay.invalidate();
    release();
    await denied;
    assert.equal(g.outgoing.size, 0);
    assert.equal(g.f.b.controls.taskStatus().responses[0]!.attempts, 0);
  } finally {
    release?.();
    g.close();
  }
});

test("Response HTTP routes preserve local authorization and explicit input and return only bounded metadata", async () => {
  const g = await fixture(),
    server = createServer();
  await g.check();
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
  const post = (action: "prepare" | "send", body: unknown, headers = {}) =>
    fetch(`http://127.0.0.1:${port}/v1/private-relay/responses/${action}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (await post("prepare", prepareInput(g), { Authorization: "" })).status,
      401,
    );
    assert.equal(
      (
        await post("prepare", prepareInput(g), {
          Origin: "https://evil.invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (await post("prepare", { ...prepareInput(g), confirmed: false })).status,
      400,
    );
    const prepared = await post("prepare", prepareInput(g));
    assert.equal(prepared.status, 200);
    const entry = await prepared.json();
    assert.equal(
      (
        await post("send", {
          ...sendInput(g, entry.id),
          credential: "injected",
        })
      ).status,
      400,
    );
    const sent = await post("send", sendInput(g, entry.id));
    assert.equal(sent.status, 200);
    const value = await sent.json();
    assert.equal(value.transportOnly, true);
    assert.doesNotMatch(
      JSON.stringify(value),
      /ciphertext|publicKey|Synthetic private|credential"/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    g.close();
  }
});

test("Native response delivery rechecks the exact revision and delivery deadline after an asynchronous key read", async () => {
  for (const reason of ["revision", "deadline"]) {
    const g = await fixture();
    try {
      await g.check();
      if (reason === "deadline")
        g.control.recipientExpiresAt = g.f.clock() + 500;
      const prepared = await prepare(g);
      let changed = false;
      [...g.f.b.slots.values()][0]!.key.beforeRead = async () => {
        if (changed) return;
        changed = true;
        if (reason === "deadline") g.f.advance(501);
        else
          g.f.b.store.db
            .prepare(
              "UPDATE private_task_responses SET revision=revision+1 WHERE user_id=? AND tenant_id=? AND id=?",
            )
            .run(g.f.b.owner.userId, g.f.b.owner.tenantId, prepared.id);
      };
      await assert.rejects(
        send(g, prepared.id),
        reason === "revision" ? /CONFLICT/ : /DENIED/,
      );
      assert.equal(changed, true);
      assert.equal(g.outgoing.size, 0);
      assert.equal(g.f.b.controls.taskStatus().responses[0]!.attempts, 0);
    } finally {
      g.close();
    }
  }
});
