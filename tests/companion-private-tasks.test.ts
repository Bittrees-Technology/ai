import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { localApi } from "../apps/companion/http.js";
import { privateEndpoints as fixture } from "./helpers/private-endpoints.js";
const confirmed = (id: string) => ({ id, confirmed: true });
async function api(f: Awaited<ReturnType<typeof fixture>>) {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port,
    base = `http://127.0.0.1:${port}`,
    token = "t".repeat(64);
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
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return {
    base,
    token,
    post,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
test("Mac dispatcher connects actual retained keys, consent, encrypted admission, worker, receipt and result across restart", async () => {
  const f = await fixture();
  try {
    const wire = await f.submit(),
      before = f.b.identities();
    const receipt = await f.b.controls.receiveTask(wire.envelope);
    assert.equal(f.b.identities(), before + 1);
    assert.equal(receipt.status, "accepted-locally");
    assert.deepEqual(Object.keys(receipt).sort(), [
      "operationId",
      "status",
      "taskId",
    ]);
    assert.deepEqual(await f.b.controls.receiveTask(wire.envelope), receipt);
    assert.equal(f.b.store.export(f.b.owner).length, 1);
    const task = f.b.store.get(f.b.owner, receipt.taskId);
    assert.deepEqual(task.input.sourceRefs, []);
    assert.equal(task.input.memoryIds, undefined);
    assert.equal(task.input.modelProfileId, "local");
    const prepared = await f.prepare(wire.envelope);
    assert.equal(prepared.state, "pending");
    assert.equal(prepared.attempts, 0);
    assert.doesNotMatch(
      JSON.stringify(prepared),
      /Synthetic private|recipientKey|permission|content|envelope/,
    );
    const envelope = await f.b.controls.taskResponseEnvelope(
      confirmed(prepared.id),
    );
    const accepted = await f.withOutbox((o) => o.acceptReceipt(envelope));
    assert.equal(accepted.value.receipt?.taskId, receipt.taskId);
    f.b.reopen();
    assert.deepEqual(
      await f.b.controls.taskResponseEnvelope(confirmed(prepared.id)),
      envelope,
    );
    assert.deepEqual(await f.b.controls.receiveTask(wire.envelope), receipt);
    await f.work();
    const result = await f.prepare(wire.envelope, "result"),
      encrypted = await f.b.controls.taskResponseEnvelope(confirmed(result.id));
    assert.equal(
      (await f.open(encrypted)).task.output,
      "Synthetic private result",
    );
    assert.doesNotMatch(JSON.stringify(encrypted), /Synthetic private result/);
    const calls = f.b.identities(),
      status = f.b.controls.taskStatus();
    assert.equal(f.b.identities(), calls);
    assert.equal(status.responses.length, 2);
    assert.equal(status.transportActive, false);
    assert.doesNotMatch(
      JSON.stringify(status),
      /Synthetic private|model|publicKey|fingerprint|content/,
    );
  } finally {
    f.close();
  }
});
test("Mac dispatcher remains off by default and rechecks separate permissions, current identity and expired scope per operation", async () => {
  const f = await fixture();
  try {
    const wire = await f.submit(),
      off = f.b.build(false),
      before = f.b.identities();
    await assert.rejects(off.receiveTask(wire.envelope), /DENIED/);
    assert.equal(f.b.identities(), before);
    await f.grant(f.b, f.a, true, { sendReceipts: false, sendResults: false });
    await f.b.controls.receiveTask(wire.envelope);
    await assert.rejects(f.prepare(wire.envelope), /DENIED/);
    await f.grant(f.b, f.a, true, { sendResults: false });
    // New permission cannot release an older admission.
    await assert.rejects(f.prepare(wire.envelope), /DENIED/);
    const second = await f.submit();
    await f.b.controls.receiveTask(second.envelope);
    await f.prepare(second.envelope);
    await f.work();
    await f.work();
    await assert.rejects(f.prepare(second.envelope, "result"), /DENIED/);
    const prepared = await f.prepare(second.envelope);
    f.b.deny();
    await assert.rejects(
      f.b.controls.taskResponseEnvelope(confirmed(prepared.id)),
    );
    assert.equal(f.b.controls.taskStatus().responses[0]!.attempts, 0);
  } finally {
    f.close();
  }
  const g = await fixture();
  try {
    const wire = await g.submit();
    g.advance(900001);
    await assert.rejects(g.b.controls.receiveTask(wire.envelope), /DENIED/);
    assert.equal(g.b.store.export(g.b.owner).length, 0);
  } finally {
    g.close();
  }
});
test("Mac response retry returns the same ciphertext and offline stop is revision-bound without cancelling accepted work", async () => {
  const f = await fixture();
  try {
    const wire = await f.submit();
    const receipt = await f.b.controls.receiveTask(wire.envelope),
      prepared = await f.prepare(wire.envelope);
    const first = await f.b.controls.taskResponseEnvelope(
      confirmed(prepared.id),
    );
    const again = await f.b.controls.taskResponseEnvelope(
      confirmed(prepared.id),
    );
    assert.deepEqual(again, first);
    const resumed = await f.b.controls.resumeTaskResponse(
      confirmed(prepared.id),
    );
    assert.equal(resumed.attempts, 2);
    const calls = f.b.identities(),
      offline = f.b.build(false, false);
    await assert.rejects(
      offline.stopTaskResponse({
        id: prepared.id,
        expectedRevision: prepared.revision,
        confirmed: true,
      }),
      /CONFLICT/,
    );
    const stopped = await offline.stopTaskResponse({
      id: prepared.id,
      expectedRevision: resumed.revision,
      confirmed: true,
    });
    assert.equal(stopped.state, "stopped");
    assert.equal(f.b.identities(), calls);
    assert.equal(f.b.store.get(f.b.owner, receipt.taskId).status, "queued");
    await assert.rejects(
      f.b.controls.taskResponseEnvelope(confirmed(prepared.id)),
      /DENIED/,
    );
    assert.equal(
      (await f.b.controls.resumeTaskResponse(confirmed(prepared.id))).state,
      "stopped",
    );
    await assert.rejects(
      f.b
        .build(true, true, { userId: "another", tenantId: "synthetic" })
        .taskResponseEnvelope(confirmed(prepared.id)),
      /DENIED/,
    );
  } finally {
    f.close();
  }
});
test("Mac dispatch excludes concurrent key/deletion work and logout or lease expiry during native reads admits nothing", async () => {
  for (const reason of ["logout", "expiry"]) {
    const f = await fixture();
    try {
      const wire = await f.submit();
      let entered!: () => void, release!: () => void;
      const reached = new Promise<void>((r) => (entered = r)),
        held = new Promise<void>((r) => (release = r));
      [...f.b.slots.values()][0]!.key.beforeRead = async () => {
        entered();
        await held;
      };
      const pending = f.b.controls.receiveTask(wire.envelope);
      await reached;
      assert.equal(f.b.controls.busy, true);
      await assert.rejects(f.b.controls.clearAll(), /BUSY/);
      await assert.rejects(
        f.b.controls.prepare({
          action: "replace",
          expectedRevision: f.b.controls.status().state.revision,
        }),
        /BUSY/,
      );
      if (reason === "logout") f.b.controls.invalidate();
      else f.advance(30001);
      release();
      await assert.rejects(pending);
      assert.equal(f.b.store.export(f.b.owner).length, 0);
      assert.equal(f.b.controls.busy, false);
    } finally {
      f.close();
    }
  }
});
test("Mac admission lost acknowledgement preserves exact retry and response handoff never leaks after final scope invalidation", async () => {
  const f = await fixture();
  try {
    const wire = await f.submit();
    let reads = f.b.reads();
    f.b.readHook(() => {
      if (f.b.reads() === reads + 3) f.b.controls.invalidate();
    });
    await assert.rejects(f.b.controls.receiveTask(wire.envelope));
    assert.equal(f.b.store.export(f.b.owner).length, 1);
    f.b.readHook();
    const receipt = await f.b.controls.receiveTask(wire.envelope);
    assert.equal(f.b.store.export(f.b.owner).length, 1);
    const prepared = await f.prepare(wire.envelope);
    reads = f.b.reads();
    f.b.readHook(() => {
      if (f.b.reads() === reads + 3) f.b.controls.invalidate();
    });
    await assert.rejects(
      f.b.controls.taskResponseEnvelope(confirmed(prepared.id)),
    );
    f.b.readHook();
    assert.equal(f.b.controls.taskStatus().responses[0]!.attempts, 1);
    const delivered = await f.b.controls.taskResponseEnvelope(
      confirmed(prepared.id),
    );
    assert.equal((await f.open(delivered)).receipt.taskId, receipt.taskId);
  } finally {
    f.close();
  }
});
test("Authenticated private-task HTTP routes accept bounded ciphertext, deny unpaired/origin/authority input and expose no plaintext", async () => {
  const f = await fixture(),
    server = await api(f);
  try {
    const wire = await f.submit("é".repeat(31000));
    assert.ok(JSON.stringify(wire.envelope).length > 65536);
    assert.equal(
      (
        await server.post("/v1/private-tasks/receive", wire.envelope, {
          Authorization: "",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await server.post("/v1/private-tasks/receive", wire.envelope, {
          Origin: "https://evil.invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await server.post("/v1/private-tasks/receive", {
          ...wire.envelope,
          modelProfileId: "remote-selected",
        })
      ).status,
      400,
    );
    const corrupt = structuredClone(wire.envelope);
    corrupt.ciphertext =
      (corrupt.ciphertext[0] === "A" ? "B" : "A") + corrupt.ciphertext.slice(1);
    const rejected = await server.post("/v1/private-tasks/receive", corrupt);
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error, "DENIED");
    const admitted = await server.post(
      "/v1/private-tasks/receive",
      wire.envelope,
    );
    assert.equal(admitted.status, 200);
    const input = {
      operationId: wire.envelope.header.operationId,
      peerId: f.a.grant.deviceId,
      kind: "accepted",
      confirmed: true,
    };
    const prepared = await (
      await server.post("/v1/private-tasks/responses/prepare", input)
    ).json();
    assert.equal(prepared.state, "pending");
    assert.equal(
      (
        await server.post("/v1/private-tasks/responses/envelope", {
          ...confirmed(prepared.id),
          peerId: randomUUID(),
        })
      ).status,
      400,
    );
    const response = await server.post(
      "/v1/private-tasks/responses/envelope",
      confirmed(prepared.id),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const encrypted = await response.json();
    assert.deepEqual(Object.keys(encrypted).sort(), [
      "ciphertext",
      "enc",
      "header",
    ]);
    const resumed = await (
      await server.post(
        "/v1/private-tasks/responses/resume",
        confirmed(prepared.id),
      )
    ).json();
    assert.equal(
      (
        await server.post("/v1/private-tasks/responses/stop", {
          id: prepared.id,
          expectedRevision: resumed.revision,
          confirmed: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await server.post("/v1/private-tasks/receive", {
          ciphertext: "x".repeat(100000),
        })
      ).status,
      413,
    );
    assert.equal(
      (
        await server.post("/v1/private-tasks/responses/prepare", {
          content: "x".repeat(70000),
        })
      ).status,
      413,
    );
    const status = await (
      await fetch(server.base + "/v1/private-tasks", {
        headers: { Authorization: "Bearer " + server.token },
      })
    ).json();
    assert.equal(status.responses[0].state, "stopped");
    assert.doesNotMatch(
      JSON.stringify(status),
      /é|Synthetic private|ciphertext|recipientKey/,
    );
    const removed = await fetch(server.base + "/v1/data", {
      method: "DELETE",
      headers: {
        Authorization: "Bearer " + server.token,
        "Content-Type": "application/json",
        "X-Confirm-Delete": "all-local-task-data",
      },
      body: JSON.stringify({ confirmed: true }),
    });
    assert.equal(removed.status, 204);
    assert.equal(f.b.controls.taskStatus().responses.length, 0);
    assert.equal(
      (await server.post("/v1/private-tasks/receive", wire.envelope)).status,
      400,
    );
  } finally {
    await server.close();
    f.close();
  }
});

test("Mac response preparation resumes its durable reservation after a write fault and cannot outlive revoked consent", async () => {
  const f = await fixture();
  try {
    const wire = await f.submit();
    await f.b.controls.receiveTask(wire.envelope);
    f.b.store.db.exec(
      "CREATE TEMP TRIGGER fail_response BEFORE UPDATE ON private_task_responses BEGIN SELECT RAISE(ABORT,'synthetic write fault'); END",
    );
    await assert.rejects(f.prepare(wire.envelope));
    const pending = f.b.controls.taskStatus().responses[0]!;
    assert.equal(pending.state, "preparing");
    assert.equal(pending.attempts, 0);
    f.b.store.db.exec("DROP TRIGGER fail_response");
    f.b.reopen();
    const resumed = await f.b.controls.resumeTaskResponse(
      confirmed(pending.id),
    );
    assert.equal(resumed.id, pending.id);
    assert.equal(resumed.state, "pending");
    assert.equal(f.b.controls.taskStatus().responses.length, 1);
    const r = await f.b.controls.preparePermission({
      action: "revoke",
      peerId: f.a.grant.deviceId,
      expectedRevision: f.b.controls.permissionStatus().revision,
    });
    await f.b.controls.confirmPermission({
      reviewId: r.id,
      confirmed: true,
      acknowledged: true,
    });
    await assert.rejects(
      f.b.controls.taskResponseEnvelope(confirmed(pending.id)),
      /DENIED/,
    );
    await assert.rejects(
      f.b.controls.resumeTaskResponse(confirmed(pending.id)),
      /DENIED/,
    );
    assert.equal(f.b.controls.taskStatus().responses[0]!.attempts, 0);
  } finally {
    f.close();
  }
});
