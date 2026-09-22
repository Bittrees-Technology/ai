import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { cleanupRemote } from "../modules/remote/maintenance.js";
export async function checkRemoteMaintenance(pool: Pool) {
  // Other integration fixtures share this disposable schema; use an isolated past cutoff.
  const cutoff = 100000,
    owner = randomUUID(),
    device = randomUUID();
  // Earlier tests leave revoked synthetic devices; clear their invalid credentials before
  // counting this fixture's batches. No live or unexpired authority is removed.
  await cleanupRemote(pool, 1000, cutoff);
  await pool.query(
    "INSERT INTO remote_accounts(id,address,chain_id) VALUES($1,$2,1)",
    [owner, "0x" + randomBytes(20).toString("hex")],
  );
  await pool.query(
    "INSERT INTO remote_devices(id,owner_id,epoch,expires_at) VALUES($1,$2,1,$3)",
    [device, owner, cutoff + 100000],
  );
  const hash = () => randomBytes(32).toString("hex");
  const deadline = [cutoff - 2, cutoff - 1, cutoff, cutoff + 1];
  const keys: {
    status: string;
    pairing: string;
    challenge: string;
    session: string;
    command: string;
    credentialDevice: string;
    approvalDevice: string;
  }[] = [];
  for (const expires of deadline) {
    const key = {
      status: randomUUID(),
      pairing: randomUUID(),
      challenge: randomUUID(),
      session: hash(),
      command: randomUUID(),
      credentialDevice: randomUUID(),
      approvalDevice: randomUUID(),
    };
    keys.push(key);
    await pool.query(
      "INSERT INTO remote_status(device_id,id,status,revision,updated_at,projection_hash,expires_at) VALUES($1,$2,'queued',1,1,$3,$4)",
      [device, key.status, hash(), expires],
    );
    await pool.query(
      "INSERT INTO remote_pairings(id,approval_hash,challenge,expires_at) VALUES($1,$2,$3,$4)",
      [key.pairing, hash(), randomBytes(32).toString("base64url"), expires],
    );
    await pool.query(
      "INSERT INTO remote_login_challenges(id,browser_hash,message_hash,address,chain_id,expires_at) VALUES($1,$2,$3,$4,1,$5)",
      [
        key.challenge,
        hash(),
        hash(),
        "0x" + randomBytes(20).toString("hex"),
        expires,
      ],
    );
    await pool.query(
      "INSERT INTO remote_sessions(token_hash,origin,chain_id,owner_id,expires_at) VALUES($1,'https://ai.bittrees.org',1,$2,$3)",
      [key.session, owner, expires],
    );
    // Command lease has already expired in all four cases, but history purge deadlines differ.
    await pool.query(
      "INSERT INTO remote_commands(id,device_id,device_epoch,task_id,request_hash,command,expected_revision,issued_at,expires_at,purge_at) VALUES($1,$2,1,$3,$4,'pause',1,1,2,$5)",
      [key.command, device, randomUUID(), hash(), expires],
    );
    await pool.query(
      "INSERT INTO remote_devices(id,owner_id,epoch,expires_at,credential_hash,control_id,control_credential_hash,controls_enabled) VALUES($1,$2,1,$3,$4,$5,$6,true)",
      [key.credentialDevice, owner, expires, hash(), randomUUID(), hash()],
    );
    await pool.query(
      "INSERT INTO remote_devices(id,owner_id,epoch,expires_at,controls_approved_epoch,controls_approval_expires_at) VALUES($1,$2,1,$3,1,$4)",
      [key.approvalDevice, owner, cutoff + 100000, expires],
    );
  }
  for (const batch of [0, -1, 1.5, 1001, NaN])
    await assert.rejects(cleanupRemote(pool, batch, cutoff), /INVALID_INPUT/);
  const lock = await pool.connect();
  try {
    await lock.query("BEGIN");
    await lock.query("SELECT id FROM remote_pairings WHERE id=$1 FOR UPDATE", [
      keys[0]!.pairing,
    ]);
    const first = await cleanupRemote(pool, 1, cutoff);
    assert.ok(Object.values(first.counts).every((n) => n === 1));
    assert.equal(
      (
        await pool.query("SELECT id FROM remote_pairings WHERE id=$1", [
          keys[0]!.pairing,
        ])
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await pool.query("SELECT id FROM remote_pairings WHERE id=$1", [
          keys[1]!.pairing,
        ])
      ).rowCount,
      0,
    );
  } finally {
    await lock.query("ROLLBACK");
    lock.release();
  }
  // Two workers can overlap safely without deleting live rows or exceeding individual bounds.
  const concurrent = await Promise.all([
    cleanupRemote(pool, 1, cutoff),
    cleanupRemote(pool, 1, cutoff),
  ]);
  for (const result of concurrent)
    assert.ok(Object.values(result.counts).every((n) => n <= 1));
  assert.ok(
    Object.values((await cleanupRemote(pool, 1, cutoff)).counts).every(
      (n) => n === 0,
    ),
  );
  for (const [table, key, column] of [
    ["remote_status", "status", "id"],
    ["remote_pairings", "pairing", "id"],
    ["remote_login_challenges", "challenge", "id"],
    ["remote_sessions", "session", "token_hash"],
    ["remote_commands", "command", "id"],
  ] as const) {
    for (let i = 0; i < keys.length; i++)
      assert.equal(
        (
          await pool.query(
            `SELECT ${column} FROM ${table} WHERE ${column}=$1`,
            [keys[i]![key]],
          )
        ).rowCount,
        i === 3 ? 1 : 0,
      );
  }
  const active = keys[3]!;
  for (let i = 0; i < keys.length; i++) {
    const row = (
      await pool.query("SELECT * FROM remote_devices WHERE id=$1", [
        keys[i]!.credentialDevice,
      ])
    ).rows[0];
    assert.equal(!!row.credential_hash, i === 3);
    assert.equal(row.controls_enabled, i === 3);
    assert.equal(row.epoch, 1); // No lease, sequence, owner or epoch mutation.
    const approval = (
      await pool.query(
        "SELECT controls_approved_epoch FROM remote_devices WHERE id=$1",
        [keys[i]!.approvalDevice],
      )
    ).rows[0];
    assert.equal(approval.controls_approved_epoch, i === 3 ? 1 : null);
  }
  await pool.query("UPDATE remote_devices SET revoked_at=$2 WHERE id=$1", [
    active.credentialDevice,
    cutoff,
  ]);
  assert.equal(
    (await cleanupRemote(pool, 1, cutoff)).counts.deviceCredentials,
    1,
  );
  assert.equal(
    (await pool.query("SELECT id FROM remote_accounts WHERE id=$1", [owner]))
      .rowCount,
    1,
  );
  // A later phase failure rolls back earlier deletes; diagnostic data never escapes the utility.
  const rollbackId = randomUUID();
  await pool.query(
    "INSERT INTO remote_pairings(id,approval_hash,challenge,expires_at) VALUES($1,$2,$3,$4)",
    [rollbackId, hash(), randomBytes(32).toString("base64url"), cutoff],
  );
  await pool.query(
    "ALTER TABLE remote_commands RENAME TO maintenance_hidden_commands",
  );
  try {
    await assert.rejects(
      cleanupRemote(pool, 1, cutoff),
      /^Error: UNAVAILABLE$/,
    );
    assert.equal(
      (
        await pool.query("SELECT id FROM remote_pairings WHERE id=$1", [
          rollbackId,
        ])
      ).rowCount,
      1,
    );
  } finally {
    await pool.query(
      "ALTER TABLE maintenance_hidden_commands RENAME TO remote_commands",
    );
  }
  assert.equal((await cleanupRemote(pool, 1, cutoff)).counts.pairings, 1);
}
