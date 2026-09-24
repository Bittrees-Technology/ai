import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { privateEndpoints } from "./helpers/private-endpoints.js";
import { PrivatePeerEnrollment } from "../modules/remote/private-peers.js";
import {
  sealPrivateEnvelope,
  type PrivateHeader,
} from "../modules/remote/private-envelope.js";
type Fixture = Awaited<ReturnType<typeof privateEndpoints>>;
type Endpoint = Fixture["a"];
const confirmed = (id: string) => ({ id, confirmed: true });
const replay = (e: Endpoint) => e.store.exportPrivateIncomingReplay(e.owner);
const checks = (e: Endpoint) => e.store.exportPrivatePeerChecks(e.owner);
const counters = (e: Endpoint) =>
  e.store.db
    .prepare("SELECT * FROM private_send_channels ORDER BY channel_hash")
    .all();
async function seal(
  f: Fixture,
  source: Endpoint,
  target: Endpoint,
  header: PrivateHeader,
  content: unknown,
) {
  return source.remote.withVerifiedDevice(async (scope) => {
    const key = await source.keys(scope.current).resolve();
    const peer = await new PrivatePeerEnrollment(
      source.store,
      source.vault,
      source.owner,
      scope.current,
      f.clock,
    ).resolve(target.grant.deviceId, header.recipientKeyEpoch);
    return sealPrivateEnvelope(
      header,
      new TextEncoder().encode(JSON.stringify(content)),
      { senderKey: key.pair, recipientPublicKey: peer.publicKey },
      f.clock,
    );
  });
}
async function exchange(f: Fixture) {
  const status = f.a.controls.peerStatus();
  const start = await f.a.controls.beginPeerCheck({
    peerId: f.b.grant.deviceId,
    expectedKeyRevision: status.keyRevision,
    expectedPeerRevision: status.revision,
    confirmed: true,
  });
  const challenge = await f.a.controls.peerCheckEnvelope(confirmed(start.id));
  const response = await f.b.controls.respondPeerCheck({
    envelope: challenge,
    confirmed: true,
  });
  return {
    start,
    challenge,
    response,
    envelope: await f.b.controls.peerCheckEnvelope(confirmed(response.id)),
  };
}
async function receipt(f: Fixture) {
  const task = await f.submit();
  await f.b.controls.receiveTask(task.envelope);
  const result = await f.prepare(task.envelope);
  return {
    task,
    envelope: await f.b.controls.taskResponseEnvelope(confirmed(result.id)),
  };
}

test("real task and device-challenge receivers reject each other's accepted message IDs and channel sequences", async () => {
  const f = await privateEndpoints();
  try {
    const old = checks(f.a).find((e) => e.role === "challenge")!.value
      .envelope!;
    const task = await f.submit(),
      before = replay(f.b);
    for (const reused of [
      { messageId: old.header.messageId },
      { sequence: old.header.sequence },
    ]) {
      const wire = await seal(
        f,
        f.a,
        f.b,
        { ...task.envelope.header, ...reused },
        {
          version: 1,
          type: "task.submit",
          kind: "query",
          prompt: "Synthetic conflict",
        },
      );
      await assert.rejects(f.b.controls.receiveTask(wire), /CONFLICT/);
      assert.equal(f.b.store.export(f.b.owner).length, 0);
      assert.deepEqual(replay(f.b), before);
    }
    await f.b.controls.receiveTask(task.envelope);
    const saved = checks(f.b),
      sequenceBefore = counters(f.b),
      afterTask = replay(f.b);
    for (const reused of [
      { messageId: task.envelope.header.messageId },
      { sequence: task.envelope.header.sequence },
    ]) {
      const header = {
        ...task.envelope.header,
        operationId: randomUUID(),
        messageId: randomUUID(),
        sequence: 900,
        ...reused,
        expiresAt: f.clock() + 60000,
      };
      const wire = await seal(f, f.a, f.b, header, {
        version: 1,
        type: "peer.key.challenge",
        challenge: randomBytes(32).toString("base64url"),
      });
      await assert.rejects(
        f.b.controls.respondPeerCheck({ envelope: wire, confirmed: true }),
        /CONFLICT/,
      );
      assert.deepEqual(checks(f.b), saved);
      assert.deepEqual(counters(f.b), sequenceBefore);
      assert.deepEqual(replay(f.b), afterTask);
    }
    const fresh = await exchange(f);
    assert.equal(fresh.response.state, "pending");
    assert.equal(replay(f.b).length, afterTask.length + 1);
  } finally {
    f.close();
  }
});

test("real acceptance and device-response receivers share replay protection and preserve exact originals through reopen", async () => {
  const f = await privateEndpoints();
  try {
    const old = checks(f.b).find((e) => e.role === "response")!.value.envelope!;
    const accepted = await receipt(f),
      content = await f.open(accepted.envelope),
      before = replay(f.a);
    for (const reused of [
      { messageId: old.header.messageId },
      { sequence: old.header.sequence },
    ]) {
      const wire = await seal(
        f,
        f.b,
        f.a,
        { ...accepted.envelope.header, ...reused },
        content,
      );
      await assert.rejects(
        f.withOutbox((o) => o.acceptReceipt(wire)),
        /CONFLICT/,
      );
      assert.equal(
        f.a.store.exportPrivateTaskOutbox(f.a.owner)[0]!.value.receipt,
        null,
      );
      assert.deepEqual(replay(f.a), before);
    }
    const first = await f.withOutbox((o) => o.acceptReceipt(accepted.envelope));
    f.a.reopen();
    const second = await f.withOutbox((o) =>
      o.acceptReceipt(accepted.envelope),
    );
    assert.deepEqual(second, first);
    const changed = await seal(
      f,
      f.b,
      f.a,
      { ...accepted.envelope.header, messageId: randomUUID(), sequence: 800 },
      content,
    );
    await assert.rejects(
      f.withOutbox((o) => o.acceptReceipt(changed)),
      /CONFLICT/,
    );
    const check = await exchange(f),
      responseContent = await f.open(check.envelope),
      afterReceipt = replay(f.a),
      checkBefore = checks(f.a);
    for (const reused of [
      { messageId: accepted.envelope.header.messageId },
      { sequence: accepted.envelope.header.sequence },
    ]) {
      const wire = await seal(
        f,
        f.b,
        f.a,
        { ...check.envelope.header, ...reused },
        responseContent,
      );
      await assert.rejects(
        f.a.controls.completePeerCheck({ envelope: wire, confirmed: true }),
        /CONFLICT/,
      );
      assert.deepEqual(replay(f.a), afterReceipt);
      assert.deepEqual(checks(f.a), checkBefore);
    }
    const completed = await f.a.controls.completePeerCheck({
      envelope: check.envelope,
      confirmed: true,
    });
    assert.equal(completed.state, "verified");
    assert.deepEqual(
      await f.a.controls.completePeerCheck({
        envelope: check.envelope,
        confirmed: true,
      }),
      completed,
    );
  } finally {
    f.close();
  }
});

test("failed shared replay insertion rolls back challenge response reservation and outgoing sequence", async () => {
  const f = await privateEndpoints(false);
  try {
    const status = f.a.controls.peerStatus();
    const start = await f.a.controls.beginPeerCheck({
      peerId: f.b.grant.deviceId,
      expectedKeyRevision: status.keyRevision,
      expectedPeerRevision: status.revision,
      confirmed: true,
    });
    const wire = await f.a.controls.peerCheckEnvelope(confirmed(start.id)),
      before = counters(f.b);
    f.b.store.db.exec(
      "CREATE TRIGGER fail_incoming BEFORE INSERT ON private_incoming_replay BEGIN SELECT RAISE(ABORT,'synthetic replay failure'); END",
    );
    await assert.rejects(
      f.b.controls.respondPeerCheck({ envelope: wire, confirmed: true }),
    );
    assert.deepEqual(checks(f.b), []);
    assert.deepEqual(replay(f.b), []);
    assert.deepEqual(counters(f.b), before);
    f.b.store.db.exec("DROP TRIGGER fail_incoming");
    const first = await f.b.controls.respondPeerCheck({
      envelope: wire,
      confirmed: true,
    });
    assert.deepEqual(
      await f.b.controls.respondPeerCheck({ envelope: wire, confirmed: true }),
      first,
    );
    assert.equal(replay(f.b).length, 1);
  } finally {
    f.close();
  }
});

test("later check/receipt write failures roll back replay consumption and allow the original message to succeed once", async () => {
  const f = await privateEndpoints();
  try {
    const check = await exchange(f),
      before = replay(f.a),
      pending = checks(f.a);
    f.a.store.db.exec(
      "CREATE TRIGGER fail_check BEFORE UPDATE ON private_peer_checks BEGIN SELECT RAISE(ABORT,'synthetic check failure'); END",
    );
    await assert.rejects(
      f.a.controls.completePeerCheck({
        envelope: check.envelope,
        confirmed: true,
      }),
    );
    assert.deepEqual(replay(f.a), before);
    assert.deepEqual(checks(f.a), pending);
    f.a.store.db.exec("DROP TRIGGER fail_check");
    await f.a.controls.completePeerCheck({
      envelope: check.envelope,
      confirmed: true,
    });
    const accepted = await receipt(f),
      beforeReceipt = replay(f.a),
      outbox = f.a.store.exportPrivateTaskOutbox(f.a.owner);
    f.a.store.db.exec(
      "CREATE TRIGGER fail_receipt BEFORE UPDATE ON private_task_outbox BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END",
    );
    await assert.rejects(
      f.withOutbox((o) => o.acceptReceipt(accepted.envelope)),
    );
    assert.deepEqual(replay(f.a), beforeReceipt);
    assert.deepEqual(f.a.store.exportPrivateTaskOutbox(f.a.owner), outbox);
    f.a.store.db.exec("DROP TRIGGER fail_receipt");
    const done = await f.withOutbox((o) => o.acceptReceipt(accepted.envelope));
    assert.equal(done.value.state, "accepted");
    assert.deepEqual(
      await f.withOutbox((o) => o.acceptReceipt(accepted.envelope)),
      done,
    );
    assert.equal(replay(f.a).length, beforeReceipt.length + 1);
  } finally {
    f.close();
  }
});

test("expiry while sealing replay evidence rolls back every Mac receiver before commit", async () => {
  for (const kind of ["task", "challenge", "response", "receipt"] as const) {
    const f = await privateEndpoints();
    try {
      let target = f.b;
      let run: () => Promise<unknown>;
      let expiresAt: number;
      if (kind === "task") {
        const task = await f.submit();
        expiresAt = task.envelope.header.expiresAt;
        run = () => f.b.controls.receiveTask(task.envelope);
      } else if (kind === "challenge") {
        const s = f.a.controls.peerStatus();
        const started = await f.a.controls.beginPeerCheck({
          peerId: f.b.grant.deviceId,
          expectedKeyRevision: s.keyRevision,
          expectedPeerRevision: s.revision,
          confirmed: true,
        });
        const envelope = await f.a.controls.peerCheckEnvelope(
          confirmed(started.id),
        );
        expiresAt = envelope.header.expiresAt;
        run = () =>
          f.b.controls.respondPeerCheck({ envelope, confirmed: true });
      } else if (kind === "response") {
        const check = await exchange(f);
        target = f.a;
        expiresAt = check.envelope.header.expiresAt;
        run = () =>
          f.a.controls.completePeerCheck({
            envelope: check.envelope,
            confirmed: true,
          });
      } else {
        const accepted = await receipt(f);
        target = f.a;
        expiresAt = accepted.envelope.header.expiresAt;
        run = () => f.withOutbox((o) => o.acceptReceipt(accepted.envelope));
      }
      const snapshot = () => ({
        replay: replay(target),
        checks: checks(target),
        tasks: target.store.export(target.owner),
        receipts: target.store.exportPrivateTaskReceipts(target.owner),
        outbox: target.store.exportPrivateTaskOutbox(target.owner),
        counters: counters(target),
      });
      const before = snapshot(),
        original = target.vault.seal.bind(target.vault);
      let crossed = false;
      target.vault.seal = (value, purpose) => {
        const sealed = original(value, purpose);
        if (purpose.includes('"private-incoming-replay:v1"')) {
          crossed = true;
          f.advance(expiresAt - f.clock());
        }
        return sealed;
      };
      await assert.rejects(run(), /DENIED/, kind);
      assert.equal(crossed, true, kind);
      assert.deepEqual(snapshot(), before, kind);
    } finally {
      f.close();
    }
  }
});
