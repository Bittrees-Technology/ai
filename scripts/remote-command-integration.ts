import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { RemoteCommandStore } from "../modules/remote/commands.js";
import { RemoteStatusStore } from "../modules/remote/status-store.js";
export async function checkRemoteCommands(pool: Pool) {
  let now = Date.now();
  const ownerId = randomUUID(),
    otherOwner = randomUUID(),
    deviceId = randomUUID(),
    taskId = randomUUID();
  const auth = { ownerId, deviceId, epoch: 1, controlId: randomUUID() };
  const queue = new RemoteCommandStore(pool, 86400000, () => now),
    status = new RemoteStatusStore(pool, 86400000, () => now);
  await pool.query(
    "INSERT INTO remote_devices(id,owner_id,epoch,expires_at) VALUES($1,$2,1,$3)",
    [deviceId, ownerId, now + 2 * 86400000],
  );
  await status.publish(
    { ownerId, deviceId, epoch: 1 },
    {
      sequence: 1,
      items: [
        {
          id: taskId,
          deviceId,
          status: "running",
          revision: 1,
          updatedAt: new Date(now).toISOString(),
        },
      ],
    },
  );
  const request = {
    id: randomUUID(),
    deviceId,
    taskId,
    command: "pause",
    expectedRevision: 1,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 300000).toISOString(),
  };
  await assert.rejects(queue.submit(ownerId, request), /DENIED/);
  await assert.rejects(queue.poll(auth), /DENIED/);
  // Explicit fixture consent only. No production device is upgraded by the migration.
  await pool.query(
    "UPDATE remote_devices SET controls_enabled=true,control_id=$2 WHERE id=$1",
    [deviceId, auth.controlId],
  );
  await assert.rejects(queue.submit(otherOwner, request), /DENIED/);
  await assert.rejects(
    queue.submit(ownerId, { ...request, command: "resume" }),
    /INVALID_INPUT/,
  );
  await assert.rejects(
    queue.submit(ownerId, { ...request, prompt: "PRIVATE" }),
    /INVALID_INPUT/,
  );
  await assert.rejects(
    queue.submit(ownerId, { ...request, expectedRevision: 2 }),
    /CONFLICT/,
  );
  const submitted = await Promise.all([
    queue.submit(ownerId, request),
    queue.submit(ownerId, request),
  ]);
  assert.equal(submitted.filter((x) => x.duplicate).length, 1);
  now += 1000;
  const repeated = await queue.submit(ownerId, request);
  assert.equal(repeated.duplicate, true);
  assert.deepEqual(repeated.command, submitted[0]!.command);
  await assert.rejects(
    queue.submit(ownerId, { ...request, command: "cancel" }),
    /CONFLICT/,
  );
  await assert.rejects(queue.inspect(otherOwner, request.id), /DENIED/);
  await assert.rejects(queue.poll({ ...auth, epoch: 2 }), /DENIED/);
  const polled = await new RemoteCommandStore(pool, 86400000, () => now).poll(
    auth,
  );
  assert.deepEqual(polled, [submitted[0]!.command]);
  assert.deepEqual(await queue.poll(auth), polled); // Delivery alone does not consume or apply.
  const receipt = {
    id: request.id,
    deviceId,
    outcome: "applied",
    completedAt: new Date(now).toISOString(),
  };
  await assert.rejects(
    queue.acknowledge({ ...auth, ownerId: otherOwner }, receipt),
    /DENIED/,
  );
  await assert.rejects(
    queue.acknowledge(auth, { ...receipt, deviceId: randomUUID() }),
    /DENIED/,
  );
  await assert.rejects(
    queue.acknowledge(auth, {
      ...receipt,
      completedAt: new Date(now + 60000).toISOString(),
    }),
    /INVALID_INPUT/,
  );
  assert.equal((await queue.acknowledge(auth, receipt)).duplicate, false);
  assert.equal((await queue.acknowledge(auth, receipt)).duplicate, true);
  await assert.rejects(
    queue.acknowledge(auth, { ...receipt, outcome: "conflict" }),
    /CONFLICT/,
  );
  assert.deepEqual(await queue.poll(auth), []);
  const view = await queue.inspect(ownerId, request.id);
  assert.equal(view.state, "acknowledged");
  assert.deepEqual(view.receipt, receipt);
  assert.equal((await status.list(ownerId, deviceId))[0]!.status, "running"); // Receipt is not a status update or local execution.
  const expiring = { ...request, id: randomUUID() };
  await queue.submit(ownerId, expiring);
  now += 300000;
  assert.deepEqual(await queue.poll(auth), []);
  assert.equal((await queue.inspect(ownerId, expiring.id)).state, "expired");
  await assert.rejects(
    queue.acknowledge(auth, {
      ...receipt,
      id: expiring.id,
      completedAt: new Date(now).toISOString(),
    }),
    /INVALID_INPUT/,
  );
  const fresh = {
    ...request,
    id: randomUUID(),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 300000).toISOString(),
  };
  await queue.submit(ownerId, fresh);
  await pool.query("UPDATE remote_devices SET epoch=2 WHERE id=$1", [deviceId]);
  assert.equal((await queue.inspect(ownerId, fresh.id)).state, "cancelled");
  assert.deepEqual(await queue.poll({ ...auth, epoch: 2 }), []);
  await assert.rejects(
    queue.acknowledge(
      { ...auth, epoch: 2 },
      { ...receipt, id: fresh.id, completedAt: new Date(now).toISOString() },
    ),
    /DENIED/,
  );
  const revoked = { ...fresh, id: randomUUID() };
  await queue.submit(ownerId, revoked);
  await status.revoke(ownerId, deviceId);
  assert.equal((await queue.inspect(ownerId, revoked.id)).state, "cancelled");
  await assert.rejects(queue.poll({ ...auth, epoch: 2 }), /DENIED/);

  const capped = randomUUID();
  await pool.query(
    "INSERT INTO remote_devices(id,owner_id,epoch,expires_at,controls_enabled,control_id) VALUES($1,$2,1,$3,true,$4)",
    [capped, ownerId, now + 2 * 86400000, auth.controlId],
  );
  await status.publish(
    { ownerId, deviceId: capped, epoch: 1 },
    {
      sequence: 1,
      items: [
        {
          id: taskId,
          deviceId: capped,
          status: "queued",
          revision: 1,
          updatedAt: new Date(now).toISOString(),
        },
      ],
    },
  );
  const cappedRequest = { ...fresh, deviceId: capped };
  const firstCappedId = randomUUID();
  for (let i = 0; i < 100; i++)
    await queue.submit(ownerId, {
      ...cappedRequest,
      id: i === 0 ? firstCappedId : randomUUID(),
    });
  await assert.rejects(
    queue.submit(ownerId, { ...cappedRequest, id: randomUUID() }),
    /CONFLICT/,
  );
  assert.equal(
    (
      await queue.poll({
        ownerId,
        deviceId: capped,
        epoch: 1,
        controlId: auth.controlId,
      })
    ).length,
    20,
  );
  assert.ok(
    !JSON.stringify(
      (await pool.query("SELECT * FROM remote_commands")).rows,
    ).includes("PRIVATE"),
  );
  const shortDevice = randomUUID(),
    rolledBackId = randomUUID();
  await pool.query(
    "INSERT INTO remote_devices(id,owner_id,epoch,expires_at,controls_enabled,control_id) VALUES($1,$2,1,$3,true,$4)",
    [shortDevice, ownerId, now + 50, auth.controlId],
  );
  await status.publish(
    { ownerId, deviceId: shortDevice, epoch: 1 },
    {
      sequence: 1,
      items: [
        {
          id: taskId,
          deviceId: shortDevice,
          status: "running",
          revision: 1,
          updatedAt: new Date(now).toISOString(),
        },
      ],
    },
  );
  let ticks = 0;
  const expiresDuringInsert = new RemoteCommandStore(
    pool,
    86400000,
    () => now + (ticks++ < 2 ? 0 : 51),
  );
  await assert.rejects(
    expiresDuringInsert.submit(ownerId, {
      ...fresh,
      id: rolledBackId,
      deviceId: shortDevice,
    }),
    /DENIED/,
  );
  assert.equal(
    (
      await pool.query("SELECT count(*) FROM remote_commands WHERE id=$1", [
        rolledBackId,
      ])
    ).rows[0].count,
    "0",
  );
  now += 86400001;
  assert.ok((await queue.purgeExpired()) > 0);
  // A deleted replay record cannot turn the original expired intent into a fresh request.
  await assert.rejects(
    queue.submit(ownerId, { ...cappedRequest, id: firstCappedId }),
    /INVALID_INPUT/,
  );
  await assert.rejects(queue.inspect(ownerId, request.id), /DENIED/);
}
