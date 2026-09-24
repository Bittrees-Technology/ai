import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { macRelayFixture } from "./helpers/mac-relay.js";
import { PrivateTaskResponses } from "../modules/remote/private-task-responses.js";
import { Store } from "../modules/storage/store.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
async function fixture() {
  const g = await macRelayFixture();
  await g.check();
  const connection = () => ({
    id: g.input().id,
    expectedRevision: g.input().expectedRevision,
  });
  const response = await g.f.b.controls.prepareRelayedResponse(g.relay, {
    connection: connection(),
    response: {
      operationId: g.wire.envelope.header.operationId,
      peerId: g.f.a.grant.deviceId,
      kind: "accepted",
      confirmed: true,
    },
    confirmed: true,
  });
  const status = () =>
    g.f.b.controls.taskStatus().responses.find((r) => r.id === response.id)!;
  const send = () =>
    g.f.b.controls.sendRelayedResponse(g.relay, {
      connection: connection(),
      response: {
        id: response.id,
        expectedRevision: status().revision,
        confirmed: true,
      },
      confirmed: true,
    });
  const records = () =>
    new PrivateTaskResponses(
      g.f.b.store,
      g.f.b.vault,
      g.f.b.owner,
      () => null,
      () => null,
      g.f.clock,
    );
  return { ...g, response, status, send, records };
}
test("relay acknowledgement survives restart, export and restore without granting sending authority", async () => {
  const g = await fixture();
  try {
    assert.equal(g.status().delivery, null);
    const sent = await g.send();
    const saved = g.status().delivery;
    assert.deepEqual(saved, {
      state: "stored",
      observedAt: g.f.clock(),
      attempt: 1,
    });
    g.reopen();
    assert.deepEqual(g.status().delivery, saved);
    const exported = g.f.b.store.exportPrivateTaskResponses(g.f.b.owner)[0]!;
    assert.equal(
      exported.delivery!.receipt.envelopeHash,
      sent.receipt.envelopeHash,
    );
    const backup = join(g.f.dir, "delivery.aib"),
      path = join(g.f.dir, "delivery-restored.db");
    await encryptedBackup(g.f.b.store, g.f.b.vault, backup);
    await restoreBackup(backup, g.f.b.vault, path);
    const restored = new Store(path, g.f.b.vault, g.f.clock);
    try {
      const r = restored.exportPrivateTaskResponses(g.f.b.owner)[0]!;
      assert.equal(r.locked, true);
      assert.deepEqual(r.delivery, exported.delivery);
      assert.throws(
        () =>
          new PrivateTaskResponses(
            restored,
            g.f.b.vault,
            g.f.b.owner,
            () => null,
            () => null,
            g.f.clock,
          ).delivery(r.id),
        /DENIED/,
      );
    } finally {
      restored.close();
    }
  } finally {
    g.close();
  }
});
test("lost replies retain uncertainty and a deliberate same-ciphertext retry records the acknowledged attempt", async () => {
  const g = await fixture();
  try {
    g.control.loseSubmit = true;
    await assert.rejects(g.send());
    assert.equal(g.status().delivery, null);
    const original = structuredClone([...g.outgoing.values()][0]!);
    g.reopen();
    g.control.loseSubmit = false;
    await g.send();
    assert.equal(g.status().delivery!.attempt, 2);
    assert.deepEqual([...g.outgoing.values()][0], original);
    const known = g.status().delivery;
    g.control.loseSubmit = true;
    await assert.rejects(g.send());
    assert.deepEqual(g.status().delivery, known);
    assert.equal(g.status().attempts, 3);
  } finally {
    g.close();
  }
});
test("transport history rejects foreign receipts, stale writes and server state regression", async () => {
  const g = await fixture();
  try {
    const sent = await g.send(),
      wire = [...g.outgoing.values()][0]!.envelope;
    const r = g.records(),
      revision = g.status().revision;
    await assert.rejects(
      r.recordDelivery(g.response.id, revision, wire, {
        ...sent.receipt,
        messageId: randomUUID(),
      }),
      /DENIED/,
    );
    await assert.rejects(
      r.recordDelivery(g.response.id, revision, wire, {
        ...sent.receipt,
        envelopeHash: "b".repeat(64),
      }),
      /DENIED/,
    );
    await assert.rejects(
      r.recordDelivery(g.response.id, revision - 1, wire, sent.receipt),
      /CONFLICT/,
    );
    await r.recordDelivery(g.response.id, revision, wire, {
      ...sent.receipt,
      revision: 2,
      state: "received",
    });
    await assert.rejects(
      r.recordDelivery(g.response.id, revision, wire, sent.receipt),
    );
    await assert.rejects(
      r.recordDelivery(g.response.id, revision, wire, {
        ...sent.receipt,
        revision: 3,
      }),
    );
    assert.equal(g.status().delivery!.state, "received");
    assert.equal(g.status().state, "pending");
    assert.equal(g.status().revision, revision);
  } finally {
    g.close();
  }
});
test("delivery evidence is owner isolated, encrypted, deletion-linked and cannot be written after stop", async () => {
  const g = await fixture();
  try {
    const sent = await g.send(),
      wire = [...g.outgoing.values()][0]!.envelope;
    const row = g.f.b.store.db
      .prepare("SELECT payload FROM private_response_delivery")
      .get() as { payload: Buffer };
    assert.doesNotMatch(
      row.payload.toString(),
      new RegExp(sent.receipt.messageId),
    );
    assert.deepEqual(
      g.f.b.store.exportPrivateTaskResponses({
        ...g.f.b.owner,
        userId: "different",
      }),
      [],
    );
    await g.f.b.controls.stopTaskResponse({
      id: g.response.id,
      expectedRevision: g.status().revision,
      confirmed: true,
    });
    await assert.rejects(
      g
        .records()
        .recordDelivery(g.response.id, g.status().revision, wire, sent.receipt),
      /DENIED/,
    );
    assert.equal(g.status().delivery!.state, "stored");
    g.f.b.store.deleteAll(g.f.b.owner);
    assert.equal(
      (
        g.f.b.store.db
          .prepare("SELECT COUNT(*) n FROM private_response_delivery")
          .get() as { n: number }
      ).n,
      0,
    );
  } finally {
    g.close();
  }
});
test("a failed acknowledgement journal write remains unconfirmed and reconciles only on explicit retry", async () => {
  const g = await fixture();
  try {
    g.f.b.store.db.exec(
      "CREATE TEMP TRIGGER fail_delivery BEFORE INSERT ON private_response_delivery BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    );
    await assert.rejects(g.send());
    assert.equal(g.outgoing.size, 1);
    assert.equal(g.status().delivery, null);
    assert.equal(g.status().attempts, 1);
    g.f.b.store.db.exec("DROP TRIGGER fail_delivery");
    await g.send();
    assert.equal(g.outgoing.size, 1);
    assert.equal(g.status().delivery!.attempt, 2);
    g.f.b.store.db
      .prepare("UPDATE private_response_delivery SET payload=?")
      .run(Buffer.from("corrupt"));
    assert.throws(g.status, /STORAGE_UNAVAILABLE/);
  } finally {
    g.close();
  }
});
