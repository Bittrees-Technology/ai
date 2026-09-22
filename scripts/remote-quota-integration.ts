import assert from "node:assert/strict";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { RemoteDeviceStore } from "../modules/remote/devices.js";
import { RemoteStatusStore } from "../modules/remote/status-store.js";
import { cleanupRemote } from "../modules/remote/maintenance.js";
export async function checkRemoteQuotas(pool: Pool) {
  const now = Date.now(),
    owner = randomUUID();
  const verifier = randomBytes(32).toString("base64url"),
    challenge = createHash("sha256").update(verifier).digest("base64url");
  const baseline = Number(
    (await pool.query("SELECT count(*) FROM remote_pairings")).rows[0].count,
  );
  const limited = new RemoteDeviceStore(pool, 3600000, () => now, {
    pendingPairings: baseline + 1,
    devicesPerOwner: 1,
  });
  const attempts = await Promise.allSettled([
    limited.begin(challenge),
    limited.begin(challenge),
  ]);
  assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 1);
  const rejected = attempts.find(
    (a) => a.status === "rejected",
  ) as PromiseRejectedResult;
  assert.match(rejected.reason.message, /CAPACITY/);
  const issued = (
    attempts.find((a) => a.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof limited.begin>>
    >
  ).value;
  await pool.query("UPDATE remote_pairings SET expires_at=$2 WHERE id=$1", [
    issued.id,
    now - 1,
  ]);
  await assert.rejects(limited.begin(challenge), /CAPACITY/);
  await cleanupRemote(pool, 1000, now);
  await limited.begin(challenge); // Cleanup, not a new request, releases stored-row capacity.
  const devices = new RemoteDeviceStore(pool, 3600000, () => now, {
    pendingPairings: 1000,
    devicesPerOwner: 1,
  });
  const pairings = await Promise.all([
    devices.begin(challenge),
    devices.begin(challenge),
  ]);
  for (const pair of pairings)
    await devices.approve(owner, pair.id, pair.approvalCode);
  const redeemed = await Promise.allSettled(
    pairings.map((p) => devices.redeem(p.id, verifier, owner)),
  );
  assert.equal(redeemed.filter((a) => a.status === "fulfilled").length, 1);
  assert.match(
    (redeemed.find((a) => a.status === "rejected") as PromiseRejectedResult)
      .reason.message,
    /CAPACITY/,
  );
  const grant = (
    redeemed.find((a) => a.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof devices.redeem>>
    >
  ).value;
  const remaining =
    pairings[redeemed.findIndex((a) => a.status === "rejected")]!;
  assert.equal(
    (
      await pool.query("SELECT id FROM remote_pairings WHERE id=$1", [
        remaining.id,
      ])
    ).rowCount,
    1,
  );
  const store = new RemoteStatusStore(pool, 86400000, () => now, 2);
  const auth = { ownerId: owner, deviceId: grant.deviceId, epoch: 1 };
  const item = {
    id: randomUUID(),
    deviceId: grant.deviceId,
    status: "queued",
    revision: 1,
    updatedAt: new Date(now).toISOString(),
  };
  await store.publish(auth, { sequence: 1, items: [item] });
  const extra = { ...item, id: randomUUID() },
    third = { ...item, id: randomUUID() };
  await assert.rejects(
    store.publish(auth, {
      sequence: 2,
      items: [{ ...item, revision: 2 }, extra, third],
    }),
    /CAPACITY/,
  );
  assert.deepEqual(await store.list(owner, grant.deviceId), [item]);
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT last_sequence FROM remote_devices WHERE id=$1",
          [grant.deviceId],
        )
      ).rows[0].last_sequence,
    ),
    1,
  );
  const batch = { sequence: 2, items: [item, extra] };
  await store.publish(auth, batch);
  assert.equal((await store.publish(auth, batch)).duplicate, true);
  await pool.query(
    "UPDATE remote_status SET expires_at=$3 WHERE device_id=$1 AND id=$2",
    [grant.deviceId, extra.id, now - 1],
  );
  await assert.rejects(
    store.publish(auth, { sequence: 3, items: [third] }),
    /CAPACITY/,
  );
  await cleanupRemote(pool, 1000, now);
  await store.publish(auth, { sequence: 3, items: [third] });
  await store.publish(auth, { sequence: 4, items: [{ ...item, revision: 2 }] });
  assert.equal((await store.list(owner, grant.deviceId)).length, 2);
  // Device history counts even after revoke, so repeated pair/revoke cannot grow it indefinitely.
  await store.revoke(owner, grant.deviceId);
  await assert.rejects(
    devices.redeem(remaining.id, verifier, owner),
    /CAPACITY/,
  );
  const otherOwner = randomUUID(),
    otherPair = await devices.begin(challenge);
  await devices.approve(otherOwner, otherPair.id, otherPair.approvalCode);
  const otherGrant = await devices.redeem(otherPair.id, verifier, otherOwner);
  const one = new RemoteStatusStore(pool, 86400000, () => now, 1);
  const otherAuth = {
    ownerId: otherOwner,
    deviceId: otherGrant.deviceId,
    epoch: 1,
  };
  const writes = await Promise.allSettled(
    [1, 2].map(() =>
      one.publish(otherAuth, {
        sequence: 1,
        items: [{ ...item, id: randomUUID(), deviceId: otherGrant.deviceId }],
      }),
    ),
  );
  assert.equal(writes.filter((w) => w.status === "fulfilled").length, 1);
  assert.equal((await one.list(otherOwner, otherGrant.deviceId)).length, 1);
  for (const value of [0, -1, 1.5, NaN, 100001]) {
    assert.throws(
      () => new RemoteStatusStore(pool, 86400000, () => now, value),
      /INVALID_INPUT/,
    );
    assert.throws(
      () =>
        new RemoteDeviceStore(pool, 3600000, () => now, {
          pendingPairings: value,
          devicesPerOwner: 1,
        }),
      /INVALID_INPUT/,
    );
  }
}
