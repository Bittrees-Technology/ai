import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { Wallet } from "ethers";
import type { Pool } from "pg";
import { RemoteSessionStore } from "../modules/remote/sessions.js";
import { RemoteBrowserDeviceStore } from "../modules/remote/browser-devices.js";
import { RemoteDeviceStore } from "../modules/remote/devices.js";
export async function checkBrowserDevices(pool: Pool) {
  let now = Date.now();
  const origin = "https://ai.bittrees.org",
    sessions = new RemoteSessionStore(pool, origin, 1, 3600000, () => now),
    devices = new RemoteBrowserDeviceStore(pool, origin, 1, 7200000, () => now),
    wallet = Wallet.createRandom();
  async function login(w = wallet) {
    const b = await sessions.begin(w.address);
    return sessions.verify({
      id: b.id,
      browserToken: b.browserToken,
      message: b.message,
      signature: await w.signMessage(b.message),
    });
  }
  const a = await login(),
    other = await login(Wallet.createRandom());
  const inspect = await devices.inspect(a.token, a.ownerId, null);
  assert.equal(inspect.registration, null);
  const request = {
    expected: null,
    operationId: randomUUID(),
    confirmed: true,
  };
  for (const bad of [
    { ...request, confirmed: false },
    { ...request, ownerId: a.ownerId },
    { ...request, expected: {} },
  ])
    await assert.rejects(
      devices.register(a.token, a.ownerId, null, bad),
      /INVALID_INPUT/,
    );
  await assert.rejects(
    devices.register(a.token, other.ownerId, null, request),
    /DENIED/,
  );
  const initial = await devices.register(a.token, a.ownerId, null, request),
    b = initial.identity.binding;
  assert.equal(initial.identity.sessionExpiresAt, a.expiresAt);
  assert.equal(b.ownerId, a.ownerId);
  assert.equal(b.credentialEpoch, 1);
  assert.equal(b.expiresAt, now + 7200000);
  const rows = (
    await pool.query("SELECT * FROM remote_browser_devices WHERE id=$1", [
      b.deviceId,
    ])
  ).rows;
  assert.ok(!JSON.stringify(rows).includes(initial.credential));
  assert.equal(
    rows[0].credential_hash,
    createHash("sha256")
      .update("bittrees-browser-device-v1:" + initial.credential)
      .digest("hex"),
  );
  assert.deepEqual(
    await new RemoteBrowserDeviceStore(
      pool,
      origin,
      1,
      7200000,
      () => now,
    ).identify(a.token, a.ownerId, initial.credential),
    initial.identity,
  );
  assert.equal(
    (await devices.inspect(other.token, other.ownerId, initial.credential))
      .registration,
    null,
  );
  await assert.rejects(
    devices.identify(other.token, other.ownerId, initial.credential),
    /DENIED/,
  );
  await assert.rejects(devices.identify(a.token, a.ownerId, a.token), /DENIED/);
  await assert.rejects(sessions.authenticate(initial.credential), /DENIED/);
  await assert.rejects(
    new RemoteDeviceStore(pool, 3600000, () => now).identify(
      initial.credential,
    ),
    /DENIED/,
  );
  for (const wrong of [
    new RemoteBrowserDeviceStore(
      pool,
      "https://other.invalid",
      1,
      7200000,
      () => now,
    ),
    new RemoteBrowserDeviceStore(pool, origin, 2, 7200000, () => now),
  ])
    await assert.rejects(
      wrong.identify(a.token, a.ownerId, initial.credential),
      /DENIED/,
    );
  // Lost creation response cannot replay an operation to obtain another identity/secret.
  await assert.rejects(
    devices.register(a.token, a.ownerId, null, request),
    /CONFLICT/,
  );
  assert.deepEqual(
    await devices.identify(a.token, a.ownerId, initial.credential),
    initial.identity,
  );
  // Account logout denies identity, but subsequent explicit same-owner sign-in preserves this registration.
  await sessions.logout(a.token);
  await assert.rejects(
    devices.identify(a.token, a.ownerId, initial.credential),
    /DENIED/,
  );
  const again = await login();
  assert.deepEqual(
    (await devices.identify(again.token, again.ownerId, initial.credential))
      .binding,
    b,
  );
  const expected = { deviceId: b.deviceId, credentialEpoch: 1 };
  const concurrent = await Promise.allSettled(
    [1, 2].map(() =>
      devices.register(again.token, a.ownerId, initial.credential, {
        expected,
        operationId: randomUUID(),
        confirmed: true,
      }),
    ),
  );
  assert.equal(concurrent.filter((r) => r.status === "fulfilled").length, 1);
  const won = concurrent.find((r) => r.status === "fulfilled")!;
  if (won.status !== "fulfilled") throw Error();
  const replacement = won.value;
  await assert.rejects(
    devices.identify(again.token, a.ownerId, initial.credential),
    /DENIED/,
  );
  assert.equal(
    (await devices.inspect(again.token, a.ownerId, initial.credential))
      .registration!.binding.credentialEpoch,
    2,
  );
  assert.equal(
    (await devices.list(again.token, a.ownerId, {})).items.length,
    2,
  );
  await assert.rejects(
    devices.list(other.token, other.ownerId, { after: b.deviceId }),
    /DENIED/,
  );
  await assert.rejects(
    devices.revoke(other.token, other.ownerId, {
      deviceId: replacement.identity.binding.deviceId,
      credentialEpoch: 1,
      confirmed: true,
    }),
    /DENIED/,
  );
  await assert.rejects(
    new RemoteBrowserDeviceStore(
      pool,
      origin,
      1,
      7200000,
      () => now,
      2,
    ).register(again.token, a.ownerId, replacement.credential, {
      expected: {
        deviceId: replacement.identity.binding.deviceId,
        credentialEpoch: 1,
      },
      operationId: randomUUID(),
      confirmed: true,
    }),
    /CAPACITY/,
  );
  assert.deepEqual(
    (await devices.identify(again.token, a.ownerId, replacement.credential))
      .binding,
    replacement.identity.binding,
  );
  // The identity query must wait for revocation, then reject the changed row.
  const lock = await pool.connect();
  try {
    await lock.query("BEGIN");
    const pid = (await lock.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;
    await lock.query(
      "SELECT id FROM remote_browser_devices WHERE id=$1 FOR UPDATE",
      [replacement.identity.binding.deviceId],
    );
    const pending = assert.rejects(
      devices.identify(again.token, a.ownerId, replacement.credential),
      /DENIED/,
    );
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      if (
        (
          await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))",
            [pid],
          )
        ).rowCount
      ) {
        waiting = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(waiting, true);
    await lock.query(
      "UPDATE remote_browser_devices SET revoked_at=$2,credential_epoch=credential_epoch+1 WHERE id=$1",
      [replacement.identity.binding.deviceId, now],
    );
    await lock.query("COMMIT");
    await pending;
  } finally {
    await lock.query("ROLLBACK");
    lock.release();
  }
  // Session deletion is also serialized before registration: logout cannot leave a new row behind it.
  const sessionLock = await pool.connect();
  const op = randomUUID();
  try {
    await sessionLock.query("BEGIN");
    const pid = (await sessionLock.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;
    await sessionLock.query("DELETE FROM remote_sessions WHERE token_hash=$1", [
      createHash("sha256").update(again.token).digest("hex"),
    ]);
    const pending = assert.rejects(
      devices.register(again.token, a.ownerId, null, {
        expected: null,
        operationId: op,
        confirmed: true,
      }),
      /DENIED/,
    );
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      if (
        (
          await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))",
            [pid],
          )
        ).rowCount
      ) {
        waiting = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    await sessionLock.query("COMMIT");
    await pending;
    assert.equal(waiting, true);
    assert.equal(
      (
        await pool.query(
          "SELECT 1 FROM remote_browser_devices WHERE operation_id=$1",
          [op],
        )
      ).rowCount,
      0,
    );
  } finally {
    await sessionLock.query("ROLLBACK");
    sessionLock.release();
  }
  const fresh = await login();
  const freshMade = await devices.register(fresh.token, fresh.ownerId, null, {
    ...request,
    operationId: randomUUID(),
  });
  // Commit-time expiry rolls back both retirement and insertion.
  let ticks = 0;
  const expiring = new RemoteBrowserDeviceStore(
    pool,
    origin,
    1,
    7200000,
    () => now + (ticks++ < 2 ? 0 : 3600000),
  );
  const failedOp = randomUUID();
  await assert.rejects(
    expiring.register(fresh.token, fresh.ownerId, freshMade.credential, {
      expected: {
        deviceId: freshMade.identity.binding.deviceId,
        credentialEpoch: 1,
      },
      operationId: failedOp,
      confirmed: true,
    }),
    /DENIED/,
  );
  assert.deepEqual(
    (await devices.identify(fresh.token, fresh.ownerId, freshMade.credential))
      .binding,
    freshMade.identity.binding,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM remote_browser_devices WHERE operation_id=$1",
        [failedOp],
      )
    ).rowCount,
    0,
  );
  // Session expiry and registration expiry are independent; inspection alone does not renew either.
  now += 3600000;
  await assert.rejects(
    devices.identify(fresh.token, fresh.ownerId, freshMade.credential),
    /DENIED/,
  );
  const renewedSession = await login();
  assert.deepEqual(
    (
      await devices.identify(
        renewedSession.token,
        fresh.ownerId,
        freshMade.credential,
      )
    ).binding,
    freshMade.identity.binding,
  );
  now += 3600000;
  const lateSession = await login();
  await assert.rejects(
    devices.identify(lateSession.token, fresh.ownerId, freshMade.credential),
    /DENIED/,
  );
  assert.deepEqual(
    (
      await devices.inspect(
        lateSession.token,
        fresh.ownerId,
        freshMade.credential,
      )
    ).registration!.binding,
    freshMade.identity.binding,
  );
  await devices.revoke(lateSession.token, fresh.ownerId, {
    deviceId: freshMade.identity.binding.deviceId,
    credentialEpoch: 1,
    confirmed: true,
  });
  assert.notEqual(
    (
      await devices.inspect(
        lateSession.token,
        fresh.ownerId,
        freshMade.credential,
      )
    ).registration!.revokedAt,
    null,
  );
  const shortSession = await login();
  const shortStore = new RemoteBrowserDeviceStore(
    pool,
    origin,
    1,
    60000,
    () => now,
  );
  const short = await shortStore.register(
    shortSession.token,
    shortSession.ownerId,
    null,
    { ...request, operationId: randomUUID() },
  );
  let identityTicks = 0;
  const expiresDuringIdentity = new RemoteBrowserDeviceStore(
    pool,
    origin,
    1,
    60000,
    () => now + (identityTicks++ < 2 ? 0 : 60000),
  );
  await assert.rejects(
    expiresDuringIdentity.identify(
      shortSession.token,
      shortSession.ownerId,
      short.credential,
    ),
    /DENIED/,
  );
  let clockTicks = 0;
  const rollbackClock = new RemoteBrowserDeviceStore(
    pool,
    origin,
    1,
    60000,
    () => (clockTicks++ === 0 ? now : now - 1),
  );
  await assert.rejects(
    rollbackClock.identify(
      shortSession.token,
      shortSession.ownerId,
      short.credential,
    ),
    /DENIED/,
  );
  const paged = await login(Wallet.createRandom());
  for (let i = 0; i < 51; i++)
    await devices.register(paged.token, paged.ownerId, null, {
      ...request,
      operationId: randomUUID(),
    });
  const firstPage = await devices.list(paged.token, paged.ownerId, {});
  assert.equal(firstPage.items.length, 50);
  assert.ok(firstPage.nextCursor);
  const secondPage = await devices.list(paged.token, paged.ownerId, {
    after: firstPage.nextCursor,
  });
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.nextCursor, null);
  assert.equal(
    new Set(
      [...firstPage.items, ...secondPage.items].map((x) => x.binding.deviceId),
    ).size,
    51,
  );
  await assert.rejects(
    devices.list(paged.token, paged.ownerId, { after: b.deviceId }),
    /DENIED/,
  );
  console.log(
    "Browser registration: real SIWE sessions, hashed credentials, owner isolation, replay, replacement/lock races, rollback, independent expiry and expired-history inspection passed.",
  );
}
