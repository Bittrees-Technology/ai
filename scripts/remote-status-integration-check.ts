import { checkPrivateRelayStore } from "./private-relay-store-integration.js";
import { checkPrivateRelayAccess } from "./private-relay-access-integration.js";
import { checkBrowserDevices } from "./browser-device-integration.js";
import { checkRemoteTemplates } from "./remote-template-integration.js";
import { checkRemoteQuotas } from "./remote-quota-integration.js";
import { checkRemoteMaintenance } from "./remote-maintenance-integration.js";
import { checkRemoteControlScope } from "./remote-control-scope-integration.js";
import { checkRemoteCommands } from "./remote-command-integration.js";
// Isolated schema in an explicitly configured test PostgreSQL database; no live relay.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { checkRemoteHttp } from "./remote-http-integration.js";
import { checkRemoteSessions } from "./remote-session-integration.js";
import { checkRemoteDevices } from "./remote-device-integration.js";
import { RemoteStatusStore } from "../modules/remote/status-store.js";
const connectionString = process.env.REMOTE_TEST_DATABASE_URL;
if (!connectionString) throw Error("REMOTE_TEST_DATABASE_URL required");
const schema = "remote_test_" + randomUUID().replaceAll("-", "");
const admin = new Pool({ connectionString }),
  pool = new Pool({
    connectionString,
    options: "-c search_path=" + schema,
    application_name: schema,
  });
let now = Date.now();
const ownerId = randomUUID(),
  otherOwner = randomUUID(),
  deviceId = randomUUID(),
  taskId = randomUUID();
const auth = { ownerId, deviceId, epoch: 1 };
const item = {
  id: taskId,
  deviceId,
  status: "queued",
  revision: 1,
  updatedAt: new Date(now).toISOString(),
};
const store = new RemoteStatusStore(pool, 86400000, () => now);
try {
  await admin.query("CREATE SCHEMA " + schema);
  await pool.query(
    await readFile(
      new URL("../modules/remote/migrations/001-status.sql", import.meta.url),
      "utf8",
    ),
  );
  await pool.query(
    await readFile(
      new URL("../modules/remote/migrations/002-pairing.sql", import.meta.url),
      "utf8",
    ),
  );
  await pool.query(
    "INSERT INTO remote_devices(id,owner_id,epoch,expires_at) VALUES($1,$2,1,$3)",
    [deviceId, ownerId, now + 2 * 86400000],
  );
  assert.deepEqual(await store.publish(auth, { sequence: 1, items: [item] }), {
    sequence: 1,
    duplicate: false,
  });
  const before = (await pool.query("SELECT expires_at FROM remote_status"))
    .rows[0].expires_at;
  now += 1000;
  assert.equal(
    (await store.publish(auth, { sequence: 1, items: [item] })).duplicate,
    true,
  );
  assert.equal(
    (await pool.query("SELECT expires_at FROM remote_status")).rows[0]
      .expires_at,
    before,
  );
  await assert.rejects(
    store.publish(
      { ...auth, ownerId: otherOwner },
      { sequence: 2, items: [item] },
    ),
    /DENIED/,
  );
  await assert.rejects(store.list(otherOwner, deviceId), /DENIED/);
  await assert.rejects(store.revoke(otherOwner, deviceId), /DENIED/);
  await assert.rejects(
    store.publish({ ...auth, epoch: 2 }, { sequence: 2, items: [item] }),
    /DENIED/,
  );
  await assert.rejects(
    store.publish(auth, {
      sequence: 2,
      items: [{ ...item, title: "PRIVATE" }],
    }),
    /INVALID_INPUT/,
  );
  await assert.rejects(
    store.publish(auth, {
      sequence: 1,
      items: [{ ...item, status: "running" }],
    }),
    /CONFLICT/,
  );
  const next = {
    ...item,
    status: "running",
    revision: 2,
    updatedAt: new Date(now).toISOString(),
  };
  const concurrent = await Promise.all([
    store.publish(auth, { sequence: 2, items: [next] }),
    store.publish(auth, { sequence: 2, items: [next] }),
  ]);
  assert.equal(concurrent.filter((r) => r.duplicate).length, 1);
  assert.equal(
    (
      await new RemoteStatusStore(pool, 86400000, () => now).list(
        ownerId,
        deviceId,
      )
    )[0]!.revision,
    2,
  );
  await assert.rejects(
    store.publish(auth, {
      sequence: 3,
      items: [
        { ...next, id: randomUUID() },
        { ...item, revision: 1 },
      ],
    }),
    /CONFLICT/,
  );
  assert.equal(
    (await pool.query("SELECT count(*) FROM remote_status")).rows[0].count,
    "1",
  );
  assert.equal(
    (await pool.query("SELECT last_sequence FROM remote_devices")).rows[0]
      .last_sequence,
    "2",
  );
  assert.ok(
    !JSON.stringify(
      (await pool.query("SELECT * FROM remote_status")).rows,
    ).includes("PRIVATE"),
  );
  now += 86400001;
  assert.deepEqual(await store.list(ownerId, deviceId), []);
  assert.equal(await store.purgeExpired(), 1);
  // Exact old delivery cannot resurrect expired rows.
  assert.equal(
    (await store.publish(auth, { sequence: 2, items: [next] })).duplicate,
    true,
  );
  assert.deepEqual(await store.list(ownerId, deviceId), []);
  await store.publish(auth, {
    sequence: 3,
    items: [{ ...next, revision: 3, updatedAt: new Date(now).toISOString() }],
  });
  // A publisher queued behind revocation sees the revocation after acquiring its lock.
  const lock = await pool.connect();
  await lock.query("BEGIN");
  await lock.query("SELECT id FROM remote_devices WHERE id=$1 FOR UPDATE", [
    deviceId,
  ]);
  const pending = store.publish(auth, {
    sequence: 4,
    items: [{ ...next, revision: 4, updatedAt: new Date(now).toISOString() }],
  });
  const rejected = assert.rejects(pending, /DENIED/);
  let observedWaiting = false;
  for (let i = 0; i < 100; i++) {
    const waits = await admin.query(
      "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
      [schema],
    );
    if (waits.rowCount) {
      observedWaiting = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }

  await lock.query("UPDATE remote_devices SET revoked_at=$2 WHERE id=$1", [
    deviceId,
    now,
  ]);
  await lock.query("COMMIT");
  lock.release();
  await rejected;
  assert.equal(
    observedWaiting,
    true,
    "publisher must actually wait on the device lock",
  );
  await store.revoke(ownerId, deviceId);
  assert.equal(
    (await pool.query("SELECT count(*) FROM remote_status")).rows[0].count,
    "0",
  );
  await assert.rejects(store.list(ownerId, deviceId), /DENIED/);
  const expiringId = randomUUID();
  await pool.query(
    "INSERT INTO remote_devices(id,owner_id,epoch,expires_at) VALUES($1,$2,1,$3)",
    [expiringId, ownerId, now + 10],
  );
  let ticks = 0;
  const expiresDuringWrite = new RemoteStatusStore(
    pool,
    86400000,
    () => now + (ticks++ === 0 ? 0 : 11),
  );
  await assert.rejects(
    expiresDuringWrite.publish(
      { ownerId, deviceId: expiringId, epoch: 1 },
      {
        sequence: 1,
        items: [
          {
            ...item,
            deviceId: expiringId,
            updatedAt: new Date(now).toISOString(),
          },
        ],
      },
    ),
    /DENIED/,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM remote_status WHERE device_id=$1",
        [expiringId],
      )
    ).rows[0].count,
    "0",
  );
  // Traverse more than two full pages through the public repository API.
  const pagedDevice = randomUUID();
  await pool.query(
    "INSERT INTO remote_devices(id,owner_id,epoch,expires_at) VALUES($1,$2,1,$3)",
    [pagedDevice, ownerId, now + 2 * 86400000],
  );
  const many = Array.from({ length: 205 }, () => ({
    ...item,
    id: randomUUID(),
    deviceId: pagedDevice,
    updatedAt: new Date(now).toISOString(),
  }));
  for (let offset = 0; offset < many.length; offset += 100) {
    await store.publish(
      { ownerId, deviceId: pagedDevice, epoch: 1 },
      {
        sequence: offset / 100 + 1,
        items: many.slice(offset, offset + 100),
      },
    );
  }
  const first = await store.listPage(ownerId, pagedDevice);
  assert.equal(first.items.length, 100);
  assert.ok(first.nextCursor);
  const second = await store.listPage(ownerId, pagedDevice, {
    after: first.nextCursor,
  });
  const third = await store.listPage(ownerId, pagedDevice, {
    after: second.nextCursor,
  });
  assert.equal(second.items.length, 100);
  assert.equal(third.items.length, 5);
  assert.equal(third.nextCursor, null);
  assert.deepEqual(
    [...first.items, ...second.items, ...third.items].map((x) => x.id),
    many.map((x) => x.id).sort(),
  );
  const narrow = await store.listPage(ownerId, pagedDevice, { limit: 1 });
  assert.equal(narrow.items.length, 1);
  assert.equal(narrow.nextCursor, first.items[0]!.id);
  for (const options of [
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { after: "invalid" },
    { after: null },
    { ownerId: otherOwner },
  ]) {
    await assert.rejects(
      store.listPage(ownerId, pagedDevice, options),
      /INVALID_INPUT/,
    );
  }
  await assert.rejects(
    store.listPage(otherOwner, pagedDevice, { after: first.nextCursor }),
    /DENIED/,
  );
  // Cursor can be replayed but cannot bypass row expiry or device revocation.
  now += 86400001;
  assert.deepEqual(
    await store.listPage(ownerId, pagedDevice, { after: first.nextCursor }),
    { items: [], nextCursor: null },
  );
  await store.revoke(ownerId, pagedDevice);
  await assert.rejects(
    store.listPage(ownerId, pagedDevice, { after: first.nextCursor }),
    /DENIED/,
  );
  await pool.query(
    await readFile(
      new URL("../modules/remote/migrations/004-controls.sql", import.meta.url),
      "utf8",
    ),
  );
  await pool.query(
    await readFile(
      new URL(
        "../modules/remote/migrations/005-control-scope.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await checkRemoteDevices(pool);
  await pool.query(
    await readFile(
      new URL("../modules/remote/migrations/003-sessions.sql", import.meta.url),
      "utf8",
    ),
  );
  await checkRemoteSessions(pool);
  await pool.query(
    await readFile(
      new URL(
        "../modules/remote/migrations/007-templates.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await pool.query(
    await readFile(
      new URL(
        "../modules/remote/migrations/008-browser-devices.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await pool.query(
    await readFile(
      new URL(
        "../modules/remote/migrations/009-private-relay-access.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await pool.query(
    await readFile(
      new URL(
        "../modules/remote/migrations/010-private-relay-messages.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await pool.query(await readFile(new URL("../modules/remote/migrations/011-mcp-delegation.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../modules/remote/migrations/012-retention-90-days.sql", import.meta.url), "utf8"));
  await checkBrowserDevices(pool);
  await checkRemoteHttp(pool);
  await checkRemoteCommands(pool);
  await checkRemoteControlScope(pool);
  await pool.query(
    await readFile(
      new URL(
        "../modules/remote/migrations/006-maintenance.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await checkRemoteMaintenance(pool);
  await checkRemoteQuotas(pool);
  await checkRemoteTemplates(pool);
  await checkPrivateRelayAccess(pool);
  await checkPrivateRelayStore(pool);
  console.log(
    "PostgreSQL status isolation, ordered/deduplicated writes, atomic rollback, retention, repository reopen, revocation, pagination and one-use device pairing and credential rotation and SIWE session/HTTPS boundary and expiring pause/cancel queue and bounded expiry maintenance and concurrent stored-row quota and separate scoped template queue checks passed. Synthetic schema only.",
  );
} finally {
  await pool.end();
  await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
  await admin.end();
}
