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
  await status.revoke(owner, issued.deviceId);
  await assert.rejects(devices.authenticate(issued.credential), /DENIED/);
  // Previously authenticated identity cannot survive revocation at publication.
  await assert.rejects(
    status.publish(auth, { sequence: 2, items: [item] }),
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
