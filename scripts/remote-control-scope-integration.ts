import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { RemoteDeviceStore } from "../modules/remote/devices.js";
export async function checkRemoteControlScope(pool: Pool) {
  let now = Date.now();
  const devices = new RemoteDeviceStore(pool, 3600000, () => now);
  const ownerId = randomUUID(),
    verifier = randomBytes(32).toString("base64url");
  const pair = await devices.begin(
    createHash("sha256").update(verifier).digest("base64url"),
  );
  await devices.approve(ownerId, pair.id, pair.approvalCode);
  const status = await devices.redeem(pair.id, verifier, ownerId);
  await devices.approveControls(ownerId, status.deviceId, 1);
  now += 300001;
  await assert.rejects(devices.enableControls(status.credential), /DENIED/);
  assert.equal((await devices.authenticate(status.credential)).epoch, 1);
  await devices.approveControls(ownerId, status.deviceId, 1);
  await devices.disableControls(ownerId, status.deviceId);
  await assert.rejects(devices.enableControls(status.credential), /DENIED/);
  await devices.approveControls(ownerId, status.deviceId, 1);
  const control = await devices.enableControls(status.credential);
  const row = (
    await pool.query(
      "SELECT control_credential_hash,controls_approved_epoch,controls_approval_expires_at FROM remote_devices WHERE id=$1",
      [status.deviceId],
    )
  ).rows[0];
  assert.equal(
    row.control_credential_hash,
    createHash("sha256").update(control.credential).digest("hex"),
  );
  assert.equal(row.controls_approved_epoch, null);
  assert.equal(row.controls_approval_expires_at, null);
  await assert.rejects(devices.authenticate(control.credential), /DENIED/);
  await assert.rejects(
    devices.authenticateControls(status.credential),
    /DENIED/,
  );
  const reopened = new RemoteDeviceStore(pool, 3600000, () => now);
  assert.equal(
    (await reopened.authenticateControls(control.credential)).controlId,
    control.controlId,
  );
  await reopened.disableControls(ownerId, status.deviceId);
  await assert.rejects(
    devices.authenticateControls(control.credential),
    /DENIED/,
  );
  // Approval expiring during credential insertion must roll back every field.
  const approval = await devices.approveControls(ownerId, status.deviceId, 1);
  let ticks = 0;
  const expiring = new RemoteDeviceStore(pool, 3600000, () =>
    ++ticks >= 3 ? approval.expiresAt + 1 : now,
  );
  await assert.rejects(expiring.enableControls(status.credential), /DENIED/);
  const after = (
    await pool.query(
      "SELECT controls_enabled,control_id,control_credential_hash FROM remote_devices WHERE id=$1",
      [status.deviceId],
    )
  ).rows[0];
  assert.deepEqual(after, {
    controls_enabled: false,
    control_id: null,
    control_credential_hash: null,
  });
  const current = await devices.enableControls(status.credential);
  now += 3600001;
  await assert.rejects(
    devices.authenticateControls(current.credential),
    /DENIED/,
  );
  await assert.rejects(
    devices.approveControls(ownerId, status.deviceId, 1),
    /DENIED/,
  );
}
