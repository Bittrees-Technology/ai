import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { privateEndpoints } from "./helpers/private-endpoints.js";
import { Store } from "../modules/storage/store.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
import { CompanionPrivateKeys } from "../apps/companion/private-keys.js";
import { localApi } from "../apps/companion/http.js";
import { PrivatePeerEnrollment } from "../modules/remote/private-peers.js";
import {
  openPrivateEnvelope,
  sealPrivateEnvelope,
  type PrivateEnvelope,
} from "../modules/remote/private-envelope.js";
type Fixture = Awaited<ReturnType<typeof privateEndpoints>>;
const confirmed = (id: string) => ({ id, confirmed: true });
async function begin(f: Fixture, source = f.a, dest = f.b) {
  const s = source.controls.peerStatus();
  return source.controls.beginPeerCheck({
    peerId: dest.grant.deviceId,
    expectedKeyRevision: s.keyRevision,
    expectedPeerRevision: s.revision,
    confirmed: true,
  });
}
async function exchange(f: Fixture) {
  const start = await begin(f),
    challenge = await f.a.controls.peerCheckEnvelope(confirmed(start.id)),
    response = await f.b.controls.respondPeerCheck({
      envelope: challenge,
      confirmed: true,
    }),
    envelope = await f.b.controls.peerCheckEnvelope(confirmed(response.id));
  return { start, challenge, response, envelope };
}
async function rewriteResponse(
  f: Fixture,
  envelope: PrivateEnvelope,
  patch: Record<string, unknown>,
  headerPatch = {},
) {
  const content = await f.open(envelope);
  return f.b.remote.withVerifiedDevice(async (scope) => {
    const key = await f.b.keys(scope.current).resolve(),
      peer = await new PrivatePeerEnrollment(
        f.b.store,
        f.b.vault,
        f.b.owner,
        scope.current,
        f.clock,
      ).resolve(f.a.grant.deviceId, 1);
    return sealPrivateEnvelope(
      { ...envelope.header, messageId: randomUUID(), ...headerPatch },
      new TextEncoder().encode(JSON.stringify({ ...content, ...patch })),
      { senderKey: key.pair, recipientPublicKey: peer.publicKey },
      f.clock,
    );
  });
}
test("Reviewed pins alone grant nothing; each endpoint must finish its own challenge before separately approving task permission", async () => {
  const f = await privateEndpoints(false);
  try {
    await assert.rejects(f.grant(f.a, f.b, false), /DENIED/);
    await assert.rejects(f.grant(f.b, f.a, true), /DENIED/);
    const { start, challenge, response, envelope } = await exchange(f);
    assert.equal(f.b.controls.peerCheckStatus().checks[0]!.state, "pending");
    await assert.rejects(f.grant(f.b, f.a, true), /DENIED/);
    const before = f.a.identities(),
      done = await f.a.controls.completePeerCheck({
        envelope,
        confirmed: true,
      });
    assert.equal(f.a.identities(), before + 1);
    assert.equal(done.state, "verified");
    assert.equal(done.id, start.id);
    assert.deepEqual(
      await f.a.controls.completePeerCheck({ envelope, confirmed: true }),
      done,
    );
    assert.deepEqual(
      await f.b.controls.respondPeerCheck({
        envelope: challenge,
        confirmed: true,
      }),
      response,
    );
    assert.deepEqual(
      await f.b.controls.peerCheckEnvelope(confirmed(response.id)),
      envelope,
    );
    assert.equal(f.a.controls.permissionStatus().grants.length, 0);
    await f.grant(f.a, f.b, false);
    await assert.rejects(f.grant(f.b, f.a, true), /DENIED/);
    await f.verify(f.b, f.a);
    await f.grant(f.b, f.a, true);
    // Check payloads cannot enter the task queue even after separate task consent.
    await assert.rejects(f.b.controls.receiveTask(challenge), /DENIED/);
    assert.equal(f.b.store.export(f.b.owner).length, 0);
    const task = await f.submit();
    assert.ok(task.envelope.header.sequence > challenge.header.sequence);
    f.a.reopen();
    f.b.reopen();
    assert.equal(
      f.a.controls.peerCheckStatus().checks.find((c) => c.id === start.id)!
        .state,
      "verified",
    );
    assert.equal(
      (await f.b.controls.receiveTask(task.envelope)).status,
      "accepted-locally",
    );
  } finally {
    f.close();
  }
});
test("Possession checks reject altered transcript, nonce, origin, key epochs and unexpected message types without marking verification", async () => {
  const f = await privateEndpoints(false);
  try {
    const { start, challenge, envelope } = await exchange(f);
    for (const patch of [
      { challenge: "A".repeat(43) },
      { requestHash: "0".repeat(64) },
      { type: "task.submit" },
    ]) {
      const changed = await rewriteResponse(f, envelope, patch);
      await assert.rejects(
        f.a.controls.completePeerCheck({ envelope: changed, confirmed: true }),
        /DENIED/,
      );
    }
    for (const patch of [
      { recipientId: randomUUID() },
      { senderKeyEpoch: 2 },
      { ownerId: randomUUID() },
    ]) {
      const changed = structuredClone(envelope);
      Object.assign(changed.header, patch);
      await assert.rejects(
        f.a.controls.completePeerCheck({ envelope: changed, confirmed: true }),
        /DENIED/,
      );
    }
    await assert.rejects(
      f.a.controls.completePeerCheck({ envelope: challenge, confirmed: true }),
      /DENIED/,
    );
    assert.equal(f.a.controls.peerCheckStatus().checks[0]!.state, "pending");
    await assert.rejects(
      f.a.controls.completePeerCheck({ envelope, confirmed: false }),
      /DENIED/,
    );
    const done = await f.a.controls.completePeerCheck({
      envelope,
      confirmed: true,
    });
    assert.equal(done.id, start.id);
    // Even a valid re-encryption cannot replace the exact accepted response.
    await assert.rejects(
      f.a.controls.completePeerCheck({
        envelope: await rewriteResponse(f, envelope, {}),
        confirmed: true,
      }),
      /CONFLICT/,
    );
    const unrelated = f.a.build(true, true, {
      tenantId: "synthetic",
      userId: "other",
    });
    assert.deepEqual(unrelated.peerCheckStatus().checks, []);
    await assert.rejects(
      unrelated.completePeerCheck({ envelope, confirmed: true }),
      /DENIED/,
    );
  } finally {
    f.close();
  }
});
test("Pending checks expire, stop offline and share revision/exclusion boundaries; key rotation requires a fresh check", async () => {
  const f = await privateEndpoints(false);
  try {
    const one = await begin(f),
      calls = f.a.identities();
    const offline = f.a.build(false, false);
    await assert.rejects(
      offline.stopPeerCheck({
        id: one.id,
        expectedRevision: one.revision - 1,
        confirmed: true,
      }),
      /CONFLICT/,
    );
    assert.equal(
      (
        await offline.stopPeerCheck({
          id: one.id,
          expectedRevision: one.revision,
          confirmed: true,
        })
      ).state,
      "stopped",
    );
    assert.equal(f.a.identities(), calls);
    await assert.rejects(
      f.a.controls.peerCheckEnvelope(confirmed(one.id)),
      /DENIED/,
    );
    assert.equal(
      (await f.a.controls.resumePeerCheck(confirmed(one.id))).state,
      "stopped",
    );
    const { envelope } = await exchange(f);
    f.advance(300001);
    await assert.rejects(
      f.a.controls.completePeerCheck({ envelope, confirmed: true }),
      /DENIED/,
    );
  } finally {
    f.close();
  }
  const g = await privateEndpoints();
  try {
    const fresh = await g.a.controls.prepare({
      action: "replace",
      expectedRevision: g.a.controls.status().state.revision,
    });
    await g.a.controls.confirm({
      reviewId: fresh.id,
      confirmed: true,
      acknowledged: true,
    });
    await assert.rejects(g.grant(g.a, g.b, false), /DENIED/);
    await assert.rejects(g.submit(), /DENIED/);
  } finally {
    g.close();
  }
});
test("Possession completion checks proofs and original deadline under the commit lock, and logout fences native reads", async () => {
  for (const mode of ["revoke", "expiry", "logout"]) {
    const f = await privateEndpoints(false);
    try {
      const { envelope } = await exchange(f);
      if (mode === "logout") {
        let entered!: () => void, release!: () => void;
        const reached = new Promise<void>((r) => (entered = r)),
          held = new Promise<void>((r) => (release = r));
        [...f.a.slots.values()][0]!.key.beforeRead = async () => {
          entered();
          await held;
        };
        const pending = f.a.controls.completePeerCheck({
          envelope,
          confirmed: true,
        });
        await reached;
        await assert.rejects(f.a.controls.clearAll(), /BUSY/);
        f.a.controls.invalidate();
        release();
        await assert.rejects(pending);
      } else {
        const original = f.a.store.db.transaction.bind(f.a.store.db);
        let injected = false;
        f.a.store.db.transaction = ((fn: any) => {
          const tx = original(fn),
            immediate = tx.immediate.bind(tx),
            wrapped = (...args: any[]) => tx(...args);
          wrapped.immediate = (...args: any[]) => {
            if (!injected) {
              injected = true;
              f.a.store.db.transaction = original;
              if (mode === "expiry") f.advance(300001);
              else
                new PrivatePeerEnrollment(
                  f.a.store,
                  f.a.vault,
                  f.a.owner,
                  () => null,
                  f.clock,
                ).revoke({
                  peerId: f.b.grant.deviceId,
                  expectedRevision: f.a.controls.peerStatus().revision,
                  confirmed: true,
                });
            }
            return immediate(...args);
          };
          return wrapped;
        }) as any;
        await assert.rejects(
          f.a.controls.completePeerCheck({ envelope, confirmed: true }),
        );
        assert.equal(injected, true);
      }
      assert.equal(f.a.controls.peerCheckStatus().checks[0]!.state, "pending");
      assert.equal(f.a.controls.permissionStatus().grants.length, 0);
    } finally {
      f.close();
    }
  }
});
test("A failed check publication resumes the same reservation and lost responses preserve exact ciphertext across restart", async () => {
  const f = await privateEndpoints(false);
  try {
    f.a.store.db.exec(
      "CREATE TEMP TRIGGER fail_check BEFORE UPDATE ON private_peer_checks BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    );
    await assert.rejects(begin(f));
    const pending = f.a.controls.peerCheckStatus().checks[0]!;
    assert.equal(pending.state, "preparing");
    f.a.store.db.exec("DROP TRIGGER fail_check");
    f.a.reopen();
    const ready = await f.a.controls.resumePeerCheck(confirmed(pending.id));
    assert.equal(ready.id, pending.id);
    const challenge = await f.a.controls.peerCheckEnvelope(confirmed(ready.id));
    const response = await f.b.controls.respondPeerCheck({
      envelope: challenge,
      confirmed: true,
    });
    const wire = await f.b.controls.peerCheckEnvelope(confirmed(response.id));
    f.b.reopen();
    assert.deepEqual(
      await f.b.controls.peerCheckEnvelope(confirmed(response.id)),
      wire,
    );
    assert.deepEqual(
      await f.b.controls.respondPeerCheck({
        envelope: challenge,
        confirmed: true,
      }),
      response,
    );
    const reads = f.a.reads();
    f.a.readHook(() => {
      if (f.a.reads() === reads + 3) f.a.controls.invalidate();
    });
    await assert.rejects(
      f.a.controls.completePeerCheck({ envelope: wire, confirmed: true }),
    );
    f.a.readHook();
    const recorded = f.a.controls.peerCheckStatus().checks[0]!;
    assert.equal(recorded.state, "verified");
    assert.deepEqual(
      await f.a.controls.completePeerCheck({ envelope: wire, confirmed: true }),
      recorded,
    );
    assert.equal(f.a.controls.peerCheckStatus().checks.length, 1);
  } finally {
    f.close();
  }
});
test("Proof history is encrypted per owner, exported on request, locked by restore and removed by deletion; schema18 permissions require fresh review", async () => {
  const f = await privateEndpoints();
  let restored: Store | undefined;
  try {
    const entries = f.b.store.exportPrivatePeerChecks(f.b.owner);
    assert.equal(entries.length, 2);
    const raw = f.b.store.db
      .prepare("SELECT payload FROM private_peer_checks")
      .all() as { payload: Buffer }[];
    for (const row of raw)
      assert.doesNotMatch(
        row.payload.toString(),
        /peer.key.challenge|peer.key.response/,
      );
    f.b.store.db
      .prepare(
        "INSERT INTO private_peer_checks SELECT 'other',tenant_id,id,role,operation_hash,revision,locked,payload FROM private_peer_checks WHERE user_id=?",
      )
      .run(f.b.owner.userId);
    assert.throws(
      () =>
        f.b.store.exportPrivatePeerChecks({ ...f.b.owner, userId: "other" }),
      /STORAGE_UNAVAILABLE/,
    );
    f.b.store.db
      .prepare("DELETE FROM private_peer_checks WHERE user_id='other'")
      .run();
    const backup = join(f.dir, "check.aib"),
      copy = join(f.dir, "restored.db");
    await encryptedBackup(f.b.store, f.b.vault, backup);
    await restoreBackup(backup, f.b.vault, copy);
    restored = new Store(copy, f.b.vault, f.clock);
    assert.ok(
      restored.exportPrivatePeerChecks(f.b.owner).every((e) => e.locked),
    );
    const controls = new CompanionPrivateKeys(
      restored,
      f.b.vault,
      f.b.owner,
      f.b.entries,
      f.b.remote,
      true,
      f.clock,
      true,
    );
    await assert.rejects(controls.resumePeerCheck(confirmed(entries[0]!.id)));
    const preserved = f.b.store.create(
      f.b.owner,
      {
        conversationId: randomUUID(),
        kind: "query",
        prompt: "prior-schema-task",
        modelProfileId: "local",
      },
      randomUUID(),
    );
    // Simulate the actual previous schema: saved permission, no possession table.
    f.b.store.db.exec("DROP TABLE private_peer_checks; PRAGMA user_version=18");
    f.b.reopen();
    assert.equal(f.b.store.db.pragma("user_version", { simple: true }), 21);
    assert.equal(
      f.b.store.get(f.b.owner, preserved.id).input.prompt,
      "prior-schema-task",
    );
    assert.equal(
      f.b.controls.permissionStatus().grants[0]!.state,
      "needs-review",
    );
    assert.equal(f.b.controls.peerCheckStatus().checks.length, 0);
    await assert.rejects(f.b.controls.receiveTask((await f.submit()).envelope));
    await f.verify(f.b, f.a);
    // A new proof alone cannot reactivate permissions retained from schema18.
    await assert.rejects(f.b.controls.receiveTask((await f.submit()).envelope));
    await f.grant(f.b, f.a, true);
    assert.equal(
      (await f.b.controls.receiveTask((await f.submit()).envelope)).status,
      "accepted-locally",
    );
    f.b.store.deleteAll(f.b.owner);
    assert.equal(f.b.controls.peerCheckStatus().checks.length, 0);
  } finally {
    restored?.close();
    f.close();
  }
});
test("Authenticated Mac possession routes disclose metadata/ciphertext only and preserve session, origin and explicit-action boundaries", async () => {
  const f = await privateEndpoints(false),
    server = createServer();
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port,
      base = `http://127.0.0.1:${port}`,
      token = "t".repeat(64);
    server.on(
      "request",
      localApi({
        store: f.b.store,
        owner: f.b.owner,
        privateKeys: f.b.controls,
        port,
        token,
      }),
    );
    const post = (
      path: string,
      body: unknown,
      headers: Record<string, string> = {},
    ) =>
      fetch(base + "/v1/private-peer-checks/" + path, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      });
    const s = f.b.controls.peerStatus(),
      input = {
        peerId: f.a.grant.deviceId,
        expectedKeyRevision: s.keyRevision,
        expectedPeerRevision: s.revision,
        confirmed: true,
      };
    assert.equal(
      (await post("begin", input, { Authorization: "" })).status,
      401,
    );
    assert.equal(
      (await post("begin", input, { Origin: "https://evil.invalid" })).status,
      403,
    );
    assert.equal(
      (await post("begin", { ...input, publicKey: "chosen-by-request" }))
        .status,
      400,
    );
    const started = await (await post("begin", input)).json();
    assert.equal(started.state, "pending");
    assert.equal("content" in started, false);
    const challenge = await (
      await post("envelope", confirmed(started.id))
    ).json();
    assert.deepEqual(Object.keys(challenge).sort(), [
      "ciphertext",
      "enc",
      "header",
    ]);
    const response = await f.a.controls.respondPeerCheck({
        envelope: challenge,
        confirmed: true,
      }),
      wire = await f.a.controls.peerCheckEnvelope(confirmed(response.id));
    const done = await post("complete", { envelope: wire, confirmed: true });
    assert.equal(done.status, 200);
    assert.equal(done.headers.get("cache-control"), "no-store");
    assert.equal((await done.json()).state, "verified");
    const exported = await (
      await fetch(base + "/v1/export", {
        headers: { Authorization: "Bearer " + token },
      })
    ).json();
    assert.equal(exported.privatePeerChecks[0].value.state, "verified");
    const calls = f.b.identities(),
      status = await (
        await fetch(base + "/v1/private-peer-checks", {
          headers: { Authorization: "Bearer " + token },
        })
      ).json();
    assert.equal(f.b.identities(), calls);
    assert.equal("content" in status.checks[0], false);
    assert.equal("envelope" in status.checks[0], false);
    assert.equal(f.b.controls.permissionStatus().grants.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    f.close();
  }
});
