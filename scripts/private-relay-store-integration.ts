import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Wallet } from "ethers";
import type { Pool } from "pg";
import { RemoteSessionStore } from "../modules/remote/sessions.js";
import { RemoteDeviceStore } from "../modules/remote/devices.js";
import { RemoteBrowserDeviceStore } from "../modules/remote/browser-devices.js";
import { RemotePrivateRelayAccess } from "../modules/remote/private-relay-access.js";
import { RemotePrivateRelayStore } from "../modules/remote/private-relay-store.js";
import {
  sealPrivateEnvelope,
  openPrivateEnvelope,
  privateEnvelopeSuite,
} from "../modules/remote/private-envelope.js";

/** Real PostgreSQL, SIWE, separate endpoint grants and authenticated HPKE; synthetic accounts only. */
export async function checkPrivateRelayStore(pool: Pool) {
  let now = Date.now();
  const clock = () => now,
    origin = "https://ai.bittrees.org",
    day = 86400000;
  const sessions = new RemoteSessionStore(pool, origin, 1, 3600000, clock);
  const devices = new RemoteDeviceStore(pool, 7200000, clock);
  const browsers = new RemoteBrowserDeviceStore(
    pool,
    origin,
    1,
    7200000,
    clock,
  );
  const access = new RemotePrivateRelayAccess(pool, origin, 1, clock);
  const policy = {
    version: 1,
    origin,
    chainId: 1,
    receivedContent: "until-deleted",
    unreceivedContent: { mode: "until-deleted" },
    operationalMetadataMs: 7 * day,
    maxMessagesPerOwner: 100,
    maxBytesPerOwner: 1024 * 1024,
  };
  const store = new RemotePrivateRelayStore(pool, policy, clock);
  const page = { after: null, limit: 20 };
  const request = () => ({
    operationId: randomUUID(),
    expected: null,
    expiresAt: now + 600000,
    confirmed: true,
  });
  async function fixture() {
    const wallet = Wallet.createRandom(),
      challenge = await sessions.begin(wallet.address);
    const session = await sessions.verify({
      id: challenge.id,
      browserToken: challenge.browserToken,
      message: challenge.message,
      signature: await wallet.signMessage(challenge.message),
    });
    const browser = await browsers.register(
      session.token,
      session.ownerId,
      null,
      { expected: null, operationId: randomUUID(), confirmed: true },
    );
    const verifier = randomBytes(32).toString("base64url"),
      pair = await devices.begin(
        createHash("sha256").update(verifier).digest("base64url"),
      );
    await devices.approve(session.ownerId, pair.id, pair.approvalCode);
    const mac = await devices.redeem(pair.id, verifier, session.ownerId);
    const browserGrant = await access.enableBrowser(
      session.token,
      session.ownerId,
      browser.credential,
      request(),
    );
    const pending = await access.approveMac(session.token, session.ownerId, {
      ...request(),
      deviceId: mac.deviceId,
      credentialEpoch: mac.epoch,
    });
    const relay = await access.acceptMac(mac.credential, {
      id: pending.id,
      expectedRevision: pending.revision,
      confirmed: true,
    });
    return { session, browser, mac, browserGrant, relay };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const key = () =>
    crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
      "deriveBits",
    ]);
  const browserKey = await key(),
    macKey = await key();
  let sequence = 0;
  async function message(f: Fixture, reverse = false, size = 32) {
    const header = {
      version: 1,
      suite: privateEnvelopeSuite,
      ownerId: f.session.ownerId,
      senderId: reverse ? f.mac.deviceId : f.browser.identity.binding.deviceId,
      recipientId: reverse
        ? f.browser.identity.binding.deviceId
        : f.mac.deviceId,
      senderKeyEpoch: 1,
      recipientKeyEpoch: 1,
      messageId: randomUUID(),
      operationId: randomUUID(),
      sequence: ++sequence,
      issuedAt: now,
      expiresAt: now + 300000,
    };
    const plaintext = new Uint8Array(size).fill(83);
    const envelope = await sealPrivateEnvelope(
      header,
      plaintext,
      {
        senderKey: reverse ? macKey : browserKey,
        recipientPublicKey: reverse ? browserKey.publicKey : macKey.publicKey,
      },
      clock,
    );
    return { version: 1, envelope };
  }
  const submit = (s: RemotePrivateRelayStore, f: Fixture, raw: unknown) =>
    s.submitBrowser(
      f.session.token,
      f.session.ownerId,
      f.browser.credential,
      raw,
    );
  const history = (s: RemotePrivateRelayStore, f: Fixture, p = page) =>
    s.exportOwner(f.session.token, f.session.ownerId, p);
  const f = await fixture(),
    other = await fixture(),
    m = await message(f, false, 65536);
  const results = await Promise.all([submit(store, f, m), submit(store, f, m)]);
  assert.deepEqual(results.map((r) => r.duplicate).sort(), [false, true]);
  const receipt = results[0].receipt;
  assert.equal(receipt.revision, 1);
  // Reopen retains the exact authenticated maximum-size payload; the relay never sees plaintext.
  const reopened = new RemotePrivateRelayStore(pool, policy, clock);
  const polled = await reopened.pollMac(f.relay.credential, page);
  assert.equal(polled.items.length, 1);
  assert.deepEqual(polled.items[0]!.envelope, m.envelope);
  const opened = await openPrivateEnvelope(
    polled.items[0]!.envelope,
    m.envelope.header,
    { recipientKey: macKey, senderPublicKey: browserKey.publicKey },
    clock,
  );
  assert.equal(opened.plaintext.length, 65536);
  assert.ok(opened.plaintext.every((b) => b === 83));
  assert.equal((await history(store, f)).restoreAuthority, false);
  assert.equal((await history(store, other)).items.length, 0);
  await assert.rejects(
    store.inspectMac(other.relay.credential, { messageId: receipt.messageId }),
    /DENIED/,
  );
  await assert.rejects(submit(store, other, m), /DENIED|INVALID_INPUT/);
  await assert.rejects(store.pollMac(f.mac.credential, page), /DENIED/);
  const changed = structuredClone(m);
  changed.envelope.header.operationId = randomUUID();
  await assert.rejects(submit(store, f, changed), /CONFLICT/);
  const collision = structuredClone(m);
  collision.envelope.header.messageId = randomUUID();
  await assert.rejects(submit(store, f, collision), /CONFLICT/);
  const ack = {
    messageId: receipt.messageId,
    envelopeHash: receipt.envelopeHash,
    expectedRevision: 1,
    confirmed: true,
  };
  await assert.rejects(
    store.acknowledgeBrowser(
      f.session.token,
      f.session.ownerId,
      f.browser.credential,
      ack,
    ),
    /DENIED/,
  );
  await assert.rejects(
    store.acknowledgeMac(f.relay.credential, {
      ...ack,
      envelopeHash: "0".repeat(64),
    }),
    /CONFLICT/,
  );
  await assert.rejects(
    store.acknowledgeMac(f.relay.credential, { ...ack, confirmed: false }),
    /INVALID_INPUT/,
  );
  const received = await store.acknowledgeMac(f.relay.credential, ack);
  assert.equal(received.receipt.state, "received");
  assert.equal(received.receipt.revision, 2);
  assert.equal(
    (await store.acknowledgeMac(f.relay.credential, ack)).duplicate,
    true,
  );
  assert.equal((await store.pollMac(f.relay.credential, page)).items.length, 0);
  assert.deepEqual((await history(store, f)).items[0]!.envelope, m.envelope);
  await assert.rejects(
    store.deleteMac(f.relay.credential, {
      messageId: receipt.messageId,
      expectedRevision: 1,
      confirmed: true,
    }),
    /CONFLICT/,
  );
  const del = {
    messageId: receipt.messageId,
    expectedRevision: 2,
    confirmed: true,
  };
  assert.equal(
    (await store.deleteOwner(f.session.token, f.session.ownerId, del)).receipt
      .revision,
    3,
  );
  assert.equal(
    (await store.deleteMac(f.relay.credential, del)).duplicate,
    true,
  );
  assert.equal(
    (await store.acknowledgeMac(f.relay.credential, ack)).duplicate,
    true,
  );
  assert.equal((await submit(store, f, m)).receipt.state, "deleted");
  assert.equal((await history(store, f)).items[0]!.envelope, null);
  assert.equal(
    (
      await pool.query(
        "SELECT content_bytes FROM remote_private_messages WHERE owner_id=$1",
        [f.session.ownerId],
      )
    ).rows[0].content_bytes,
    0,
  );
  // Reply direction, stable bounded pages, and no implicit acknowledgement.
  const replies = await Promise.all([
    message(f, true),
    message(f, true),
    message(f, true),
  ]);
  for (const reply of replies) await store.submitMac(f.relay.credential, reply);
  const first = await store.pollBrowser(
    f.session.token,
    f.session.ownerId,
    f.browser.credential,
    { after: null, limit: 2 },
  );
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  const second = await store.pollBrowser(
    f.session.token,
    f.session.ownerId,
    f.browser.credential,
    { after: first.nextCursor, limit: 2 },
  );
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(
    new Set([...first.items, ...second.items].map((i) => i.receipt.messageId))
      .size,
    3,
  );
  assert.equal(
    (
      await store.pollBrowser(
        f.session.token,
        f.session.ownerId,
        f.browser.credential,
        page,
      )
    ).items.length,
    3,
  );
  // Stored corruption never leaves the repository as apparently valid ciphertext.
  const corrupt = replies[0];
  await pool.query(
    "UPDATE remote_private_messages SET envelope_hash=$2 WHERE message_id=$1",
    [corrupt.envelope.header.messageId, "0".repeat(64)],
  );
  await assert.rejects(history(store, f), /UNAVAILABLE/);
  await assert.rejects(
    store.pollBrowser(
      f.session.token,
      f.session.ownerId,
      f.browser.credential,
      page,
    ),
    /UNAVAILABLE/,
  );
  const { privateRelayEnvelopeHash } =
    await import("../modules/remote/private-relay-contracts.js");
  await pool.query(
    "UPDATE remote_private_messages SET envelope_hash=$2 WHERE message_id=$1",
    [
      corrupt.envelope.header.messageId,
      await privateRelayEnvelopeHash(corrupt.envelope),
    ],
  );
  // New grants cannot inherit old encrypted transport queues; owner history/deletion survives revocation.
  await access.revokeOwner(f.session.token, f.session.ownerId, {
    id: f.browserGrant.id,
    expectedRevision: f.browserGrant.revision,
    confirmed: true,
  });
  await assert.rejects(
    store.pollBrowser(
      f.session.token,
      f.session.ownerId,
      f.browser.credential,
      page,
    ),
    /DENIED/,
  );
  const replacement = await access.enableBrowser(
    f.session.token,
    f.session.ownerId,
    f.browser.credential,
    {
      ...request(),
      expected: null,
    },
  );
  assert.notEqual(replacement.id, f.browserGrant.id);
  assert.equal(
    (
      await store.pollBrowser(
        f.session.token,
        f.session.ownerId,
        f.browser.credential,
        page,
      )
    ).items.length,
    0,
  );
  await assert.rejects(
    store.inspectBrowser(
      f.session.token,
      f.session.ownerId,
      f.browser.credential,
      { messageId: replies[0].envelope.header.messageId },
    ),
    /DENIED/,
  );
  assert.equal((await history(store, f)).items.length, 4);
  await store.deleteOwner(f.session.token, f.session.ownerId, {
    messageId: replies[0].envelope.header.messageId,
    expectedRevision: 1,
    confirmed: true,
  });
  // Row and byte quotas serialize concurrent submissions, including retained tombstones.
  const q = await fixture(),
    quota = new RemotePrivateRelayStore(
      pool,
      { ...policy, maxMessagesPerOwner: 1 },
      clock,
    );
  const qa = await message(q),
    qb = await message(q);
  const races = await Promise.allSettled([
    submit(quota, q, qa),
    submit(quota, q, qb),
  ]);
  assert.equal(races.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(
    String(
      (races.find((r) => r.status === "rejected") as PromiseRejectedResult)
        .reason,
    ),
    /CAPACITY/,
  );
  const qh = await history(quota, q);
  await quota.deleteOwner(q.session.token, q.session.ownerId, {
    messageId: qh.items[0]!.receipt.messageId,
    expectedRevision: 1,
    confirmed: true,
  });
  await assert.rejects(submit(quota, q, await message(q)), /CAPACITY/);
  const b = await fixture(),
    bytes = new RemotePrivateRelayStore(
      pool,
      { ...policy, maxBytesPerOwner: 98304 },
      clock,
    );
  await submit(bytes, b, await message(b, false, 65536));
  await assert.rejects(
    submit(bytes, b, await message(b, false, 65536)),
    /CAPACITY/,
  );
  // A real SQL write followed by expiry must roll back, including the ciphertext row.
  const exp = await fixture(),
    expMessage = await message(exp),
    start = now;
  let afterQuery: ((sql: string) => void) | undefined;
  const hooked = new Proxy(pool, {
    get(target, name) {
      if (name !== "connect") return Reflect.get(target, name, target);
      return async () => {
        const db = await target.connect();
        return new Proxy(db, {
          get(client, property) {
            if (property === "query")
              return async (...args: any[]) => {
                const result = await (client.query as any)(...args);
                afterQuery?.(String(args[0]));
                return result;
              };
            const value = Reflect.get(client, property, client);
            return typeof value === "function" ? value.bind(client) : value;
          },
        });
      };
    },
  }) as Pool;
  const expStore = new RemotePrivateRelayStore(hooked, policy, clock);
  for (const deadline of [
    expMessage.envelope.header.expiresAt,
    exp.relay.grant.expiresAt,
    start - 1,
  ]) {
    afterQuery = (sql) => {
      if (sql.startsWith("INSERT INTO remote_private_messages")) now = deadline;
    };
    await assert.rejects(submit(expStore, exp, expMessage), /DENIED/);
    now = start;
    afterQuery = undefined;
    assert.equal((await history(store, exp)).items.length, 0);
  }
  await submit(store, exp, expMessage);
  afterQuery = (sql) => {
    if (sql.includes("SELECT m.* FROM remote_private_messages"))
      now = expMessage.envelope.header.expiresAt;
  };
  await assert.rejects(expStore.pollMac(exp.relay.credential, page), /DENIED/);
  now = start;
  afterQuery = undefined;
  await access.revokeOwner(exp.session.token, exp.session.ownerId, {
    id: exp.browserGrant.id,
    expectedRevision: 1,
    confirmed: true,
  });
  assert.equal(
    (await store.pollMac(exp.relay.credential, page)).items.length,
    0,
  );
  assert.equal((await history(store, exp)).items.length, 1);

  // Snapshot policy at storage, never silently apply a newer policy to existing messages.
  const r = await fixture(),
    removalPolicy = {
      ...policy,
      receivedContent: "delete-after-receipt",
      unreceivedContent: { mode: "bounded", retentionMs: 60000 },
    };
  const removal = new RemotePrivateRelayStore(pool, removalPolicy, clock),
    rm = await message(r);
  const rr = (await submit(removal, r, rm)).receipt;
  await store.acknowledgeMac(r.relay.credential, {
    messageId: rr.messageId,
    envelopeHash: rr.envelopeHash,
    expectedRevision: 1,
    confirmed: true,
  });
  assert.equal((await history(store, r)).items[0]!.envelope, null);
  const pending = await message(r);
  await submit(removal, r, pending);
  const retained = await message(r);
  await submit(store, r, retained);
  now += 60001;
  assert.equal(
    (await removal.pollMac(r.relay.credential, page)).items.length,
    1,
  );
  // Busy owners are skipped without waiting or changing their pending content.
  const maintenanceLock = await pool.connect();
  try {
    await maintenanceLock.query("BEGIN");
    await maintenanceLock.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('bittrees-ai:private-relay:' || $1,0))",
      [r.session.ownerId],
    );
    assert.equal((await removal.cleanup(1)).contentDeleted, 0);
  } finally {
    await maintenanceLock.query("ROLLBACK");
    maintenanceLock.release();
  }
  assert.equal((await removal.cleanup(1)).contentDeleted, 1);
  const rh = await history(store, r);
  assert.equal(
    rh.items.find(
      (i) => i.receipt.messageId === pending.envelope.header.messageId,
    )!.receipt.state,
    "deleted",
  );
  assert.ok(
    rh.items.find(
      (i) => i.receipt.messageId === retained.envelope.header.messageId,
    )!.envelope,
  );
  assert.equal((await removal.cleanup(1)).contentDeleted, 0);
  await assert.rejects(removal.cleanup(0), /INVALID_INPUT/);
  // Expired delivery is hidden, retained content remains owner-exportable, never resubmittable.
  now += 240000;
  assert.equal((await store.pollMac(r.relay.credential, page)).items.length, 0);
  assert.ok(
    (await history(store, r)).items.find(
      (i) => i.receipt.messageId === retained.envelope.header.messageId,
    )!.envelope,
  );
  await assert.rejects(submit(store, r, retained), /INVALID_INPUT/);
  now += 300000; // Relay grants have expired; owner session remains valid.
  await assert.rejects(store.pollMac(r.relay.credential, page), /DENIED/);
  assert.ok(
    (await history(store, r)).items.find(
      (i) => i.receipt.messageId === retained.envelope.header.messageId,
    )!.envelope,
  );
  await store.deleteOwner(r.session.token, r.session.ownerId, {
    messageId: retained.envelope.header.messageId,
    expectedRevision: 1,
    confirmed: true,
  });
  const historyFirst = await history(store, r, { after: null, limit: 2 });
  assert.equal(historyFirst.items.length, 2);
  assert.ok(historyFirst.nextCursor);
  const historyLast = await store.exportOwner(
    r.session.token,
    r.session.ownerId,
    { after: historyFirst.nextCursor, limit: 2 },
  );
  assert.equal(historyLast.items.length, 1);
  assert.equal(historyLast.nextCursor, null);
  assert.equal(
    new Set(
      [...historyFirst.items, ...historyLast.items].map(
        (i) => i.receipt.messageId,
      ),
    ).size,
    3,
  );
  // Tombstones outlive original envelope validity; bounded cleanup never destroys retained ciphertext.
  const beforeCleanup = Number(
    (
      await pool.query(
        "SELECT count(*) AS n FROM remote_private_messages WHERE envelope IS NOT NULL",
      )
    ).rows[0].n,
  );
  now += 8 * day;
  const cleaned = await store.cleanup(1);
  assert.equal(cleaned.metadataDeleted, 1);
  while ((await store.cleanup(1000)).metadataDeleted > 0) {
    /* finite synthetic tombstones */
  }
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT count(*) AS n FROM remote_private_messages WHERE envelope IS NOT NULL",
        )
      ).rows[0].n,
    ),
    beforeCleanup,
  );
  console.log(
    "Private relay ciphertext store: authenticated maximum payload/reopen, exact/concurrent retry, conflict, endpoint isolation, bidirectional pages, receipt/deletion reconciliation, grant replacement, corruption, atomic quotas and explicit retention/cleanup passed. Synthetic PostgreSQL only.",
  );
}
