import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { localApi } from "../apps/companion/http.js";
import { CompanionPrivateTasks } from "../apps/companion/private-tasks.js";
import { privateEndpoints as fixture } from "./helpers/private-endpoints.js";

test("accepted task metadata survives reopen and recovers response targets without reading remote identity or exporting content", async () => {
  const f = await fixture();
  try {
    const wire = await f.submit(),
      receipt = await f.b.controls.receiveTask(wire.envelope);
    const before = f.b.identities();
    const status = f.b.controls.taskStatus();
    assert.equal(f.b.identities(), before);
    assert.deepEqual(status.acceptedTasks, [
      {
        operationId: wire.envelope.header.operationId,
        taskId: receipt.taskId,
        peerId: wire.envelope.header.senderId,
        peerKeyEpoch: wire.envelope.header.senderKeyEpoch,
        acceptedAt: f.clock(),
      },
    ]);
    assert.doesNotMatch(
      JSON.stringify(status),
      /Synthetic private|prompt|ciphertext|publicKey|credential|sourceRefs|model|fingerprint/,
    );
    assert.equal(status.responses.length, 0);
    f.b.reopen();
    assert.deepEqual(
      f.b.controls.taskStatus().acceptedTasks,
      status.acceptedTasks,
    );
    assert.deepEqual(
      f.b.build(false).taskStatus().acceptedTasks,
      status.acceptedTasks,
    );
    const target = status.acceptedTasks[0]!;
    const prepared = await f.b.controls.prepareTaskResponse({
      operationId: target.operationId,
      peerId: target.peerId,
      kind: "accepted",
      confirmed: true,
    });
    assert.equal(prepared.operationId, target.operationId);
    assert.equal(prepared.peerId, target.peerId);
    assert.equal(prepared.attempts, 0);
    assert.equal(f.b.identities(), before + 1);
  } finally {
    f.close();
  }
});

test("accepted task metadata is local-owner isolated and corrupt retained receipts fail closed", async () => {
  const f = await fixture();
  try {
    const wire = await f.submit();
    await f.b.controls.receiveTask(wire.envelope);
    for (const owner of [
      { ...f.b.owner, userId: randomUUID() },
      { ...f.b.owner, tenantId: randomUUID() },
    ]) {
      const other = new CompanionPrivateTasks(
        f.b.store,
        f.b.vault,
        owner,
        () => {
          throw Error("Key access forbidden");
        },
      );
      assert.deepEqual(other.status().acceptedTasks, []);
    }
    const count = f.b.identities();
    f.b.store.db
      .prepare(
        "UPDATE private_task_receipts SET payload=? WHERE user_id=? AND tenant_id=?",
      )
      .run(Buffer.from("corrupt"), f.b.owner.userId, f.b.owner.tenantId);
    assert.throws(() => f.b.controls.taskStatus());
    assert.equal(f.b.identities(), count);
  } finally {
    f.close();
  }
});

test("accepted task metadata is available only through the authenticated local task-status route", async () => {
  const f = await fixture();
  const server = createServer();
  try {
    const wire = await f.submit();
    await f.b.controls.receiveTask(wire.envelope);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port,
      token = "m".repeat(64),
      url = `http://127.0.0.1:${port}/v1/private-tasks`;
    server.on(
      "request",
      localApi({
        store: f.b.store,
        owner: f.b.owner,
        port,
        token,
        privateKeys: f.b.controls,
      }),
    );
    const denied = await fetch(url);
    assert.notEqual(denied.status, 200);
    assert.doesNotMatch(
      await denied.text(),
      new RegExp(wire.envelope.header.operationId),
    );
    const allowed = await fetch(url, {
      headers: { Authorization: "Bearer " + token },
    });
    assert.equal(allowed.status, 200);
    const status = await allowed.json();
    assert.deepEqual(
      status.acceptedTasks,
      f.b.controls.taskStatus().acceptedTasks,
    );
    assert.doesNotMatch(
      JSON.stringify(status),
      /Synthetic private|prompt|ciphertext|publicKey|credential/,
    );
  } finally {
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((r) => server.close(() => r()));
    f.close();
  }
});
