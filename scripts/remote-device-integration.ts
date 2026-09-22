import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { RemoteDeviceStore } from "../modules/remote/devices.js";
import { RemoteStatusStore } from "../modules/remote/status-store.js";

export async function checkRemoteDevices(pool: Pool) {
  let now = Date.now();
  const owner = randomUUID(),
    other = randomUUID();
  const devices = new RemoteDeviceStore(pool, 3600000, () => now);
  const status = new RemoteStatusStore(pool, 86400000, () => now);
  // RFC7636 appendix B test vector: uses the specified S256 construction.
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  const wrong = randomBytes(32).toString("base64url");
  const pairing = await devices.begin(challenge);
  await assert.rejects(devices.redeem(pairing.id, verifier, owner), /DENIED/);
  await assert.rejects(devices.approve(owner, pairing.id, wrong), /DENIED/);
  await devices.approve(owner, pairing.id, pairing.approvalCode);
  await assert.rejects(
    devices.approve(other, pairing.id, pairing.approvalCode),
    /DENIED/,
  );
  await assert.rejects(devices.cancel(other, pairing.id), /DENIED/);
  await assert.rejects(devices.redeem(pairing.id, wrong, owner), /DENIED/);
  await assert.rejects(devices.redeem(pairing.id, verifier, other), /DENIED/);
  const concurrent = await Promise.allSettled([
    devices.redeem(pairing.id, verifier, owner),
    devices.redeem(pairing.id, verifier, owner),
  ]);
  assert.equal(concurrent.filter((r) => r.status === "fulfilled").length, 1);
  const success = concurrent.find((r) => r.status === "fulfilled")!;
  assert.equal(success.status, "fulfilled");
  if (success.status !== "fulfilled") throw Error("Expected credential");
  const issued = success.value;
  const rejected = concurrent.find((r) => r.status === "rejected")!;
  if (rejected.status === "rejected")
    assert.match(String(rejected.reason), /DENIED/);
  assert.equal(issued.scope, "status:publish");
  assert.equal(issued.expiresAt, now + 3600000);
  assert.equal(
    (
      await pool.query("SELECT count(*) FROM remote_pairings WHERE id=$1", [
        pairing.id,
      ])
    ).rows[0].count,
    "0",
  );
  const stored = (
    await pool.query("SELECT * FROM remote_devices WHERE id=$1", [
      issued.deviceId,
    ])
  ).rows[0];
  assert.equal(
    stored.credential_hash,
    createHash("sha256").update(issued.credential).digest("hex"),
  );
  assert.ok(!JSON.stringify(stored).includes(issued.credential));
  const auth = await new RemoteDeviceStore(
    pool,
    3600000,
    () => now,
  ).authenticate(issued.credential);
  assert.deepEqual(auth, {
    ownerId: owner,
    deviceId: issued.deviceId,
    epoch: 1,
  });
  await assert.rejects(devices.authenticate(wrong), /DENIED/);
  await assert.rejects(devices.authenticate("malformed"), /DENIED/);
  const item = {
    id: randomUUID(),
    deviceId: issued.deviceId,
    status: "queued",
    revision: 1,
    updatedAt: new Date(now).toISOString(),
  };
  await status.publish(auth, { sequence: 1, items: [item] });
  assert.equal((await status.list(owner, issued.deviceId)).length, 1);
  // Rotation keeps the approved lease and the existing status/sequence checkpoint.
  now += 1000;
  const rotations = await Promise.allSettled([
    devices.rotate(issued.credential),
    devices.rotate(issued.credential),
  ]);
  assert.equal(rotations.filter((r) => r.status === "fulfilled").length, 1);
  const rotated = rotations.find((r) => r.status === "fulfilled")!;
  if (rotated.status !== "fulfilled") throw Error("Expected rotation");
  const current = rotated.value;
  assert.notEqual(current.credential, issued.credential);
  assert.equal(current.deviceId, issued.deviceId);
  assert.equal(current.ownerId, owner);
  assert.equal(current.epoch, 2);
  assert.equal(current.expiresAt, issued.expiresAt);
  assert.equal(current.scope, "status:publish");
  await assert.rejects(devices.authenticate(issued.credential), /DENIED/);
  await assert.rejects(devices.rotate(issued.credential), /DENIED/);
  await assert.rejects(
    status.publish(auth, { sequence: 2, items: [item] }),
    /DENIED/,
  );
  const currentAuth = await devices.authenticate(current.credential);
  assert.equal(currentAuth.epoch, 2);
  assert.equal((await status.list(owner, issued.deviceId))[0]!.revision, 1);
  // An exact pre-rotation delivery can be retried with the new credential.
  assert.equal(
    (await status.publish(currentAuth, { sequence: 1, items: [item] }))
      .duplicate,
    true,
  );
  await status.publish(currentAuth, {
    sequence: 2,
    items: [{ ...item, revision: 2 }],
  });
  const rotatedRow = (
    await pool.query(
      "SELECT credential_hash,last_sequence,epoch FROM remote_devices WHERE id=$1",
      [issued.deviceId],
    )
  ).rows[0];
  assert.equal(
    rotatedRow.credential_hash,
    createHash("sha256").update(current.credential).digest("hex"),
  );
  assert.equal(Number(rotatedRow.last_sequence), 2);
  await status.revoke(owner, issued.deviceId);
  await assert.rejects(devices.authenticate(current.credential), /DENIED/);
  await assert.rejects(devices.rotate(current.credential), /DENIED/);
  // Current-epoch identity authenticated before revocation must also fail.
  await assert.rejects(
    status.publish(currentAuth, { sequence: 3, items: [item] }),
    /DENIED/,
  );

  const cancelled = await devices.begin(challenge);
  await devices.approve(owner, cancelled.id, cancelled.approvalCode);
  await devices.cancel(owner, cancelled.id);
  await assert.rejects(devices.redeem(cancelled.id, verifier, owner), /DENIED/);
  const expired = await devices.begin(challenge);
  await devices.approve(owner, expired.id, expired.approvalCode);
  const pending = await devices.begin(challenge);
  now += 300000;
  await assert.rejects(devices.redeem(expired.id, verifier, owner), /DENIED/);
  await assert.rejects(
    devices.approve(owner, pending.id, pending.approvalCode),
    /DENIED/,
  );
  assert.equal(await devices.purgeExpired(), 2);

  // Approval cannot be transferred: concurrent owners produce exactly one binding.
  const contested = await devices.begin(challenge);
  const approvals = await Promise.allSettled([
    devices.approve(owner, contested.id, contested.approvalCode),
    devices.approve(other, contested.id, contested.approvalCode),
  ]);
  assert.equal(approvals.filter((r) => r.status === "fulfilled").length, 1);
  const winner = approvals[0]!.status === "fulfilled" ? owner : other;
  const lease = await devices.redeem(contested.id, verifier, winner);
  now += 3600000;
  await assert.rejects(devices.authenticate(lease.credential), /DENIED/);
  await assert.rejects(devices.rotate(lease.credential), /DENIED/);

  // Mid-rotation expiry must preserve the old hash and epoch, not half-rotate.
  const rotationPair = await devices.begin(challenge);
  await devices.approve(owner, rotationPair.id, rotationPair.approvalCode);
  const rotationLease = await devices.redeem(rotationPair.id, verifier, owner);
  let rotationTicks = 0;
  const expiringRotation = new RemoteDeviceStore(
    pool,
    3600000,
    () => now + (rotationTicks++ === 0 ? 0 : 3600000),
  );
  await assert.rejects(
    expiringRotation.rotate(rotationLease.credential),
    /DENIED/,
  );
  const rollbackRow = (
    await pool.query(
      "SELECT credential_hash,epoch,expires_at FROM remote_devices WHERE id=$1",
      [rotationLease.deviceId],
    )
  ).rows[0];
  assert.equal(rollbackRow.epoch, 1);
  assert.equal(
    rollbackRow.credential_hash,
    createHash("sha256").update(rotationLease.credential).digest("hex"),
  );
  assert.equal(Number(rollbackRow.expires_at), rotationLease.expiresAt);
  await pool.query("UPDATE remote_devices SET epoch=2147483647 WHERE id=$1", [
    rotationLease.deviceId,
  ]);
  await assert.rejects(devices.rotate(rotationLease.credential), /DENIED/);
  await assert.rejects(devices.rotate(wrong), /DENIED/);
  await assert.rejects(devices.rotate("invalid"), /DENIED/);

  // If expiry occurs during redemption, both insertion and consumption roll back.
  const late = await devices.begin(challenge);
  await devices.approve(owner, late.id, late.approvalCode);
  let ticks = 0;
  const lateStore = new RemoteDeviceStore(
    pool,
    3600000,
    () => now + (ticks++ === 0 ? 0 : 300000),
  );
  const countBefore = (await pool.query("SELECT count(*) FROM remote_devices"))
    .rows[0].count;
  await assert.rejects(lateStore.redeem(late.id, verifier, owner), /DENIED/);
  assert.equal(
    (await pool.query("SELECT count(*) FROM remote_devices")).rows[0].count,
    countBefore,
  );
  assert.equal(
    (
      await pool.query("SELECT count(*) FROM remote_pairings WHERE id=$1", [
        late.id,
      ])
    ).rows[0].count,
    "1",
  );
  await devices.cancel(owner, late.id);
  for (const bad of ["", "a".repeat(42), "=".repeat(43)])
    await assert.rejects(devices.begin(bad), /INVALID_INPUT/);
  assert.throws(() => new RemoteDeviceStore(pool, 0), /INVALID_INPUT/);
  assert.throws(
    () => new RemoteDeviceStore(pool, 31 * 86400000),
    /INVALID_INPUT/,
  );
}
