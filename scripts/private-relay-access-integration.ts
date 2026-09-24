import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Wallet } from "ethers";
import type { Pool } from "pg";
import { RemoteSessionStore } from "../modules/remote/sessions.js";
import { RemoteDeviceStore } from "../modules/remote/devices.js";
import { RemoteBrowserDeviceStore } from "../modules/remote/browser-devices.js";
import {
  RemotePrivateRelayAccess,
  type PrivateRelayTransaction,
} from "../modules/remote/private-relay-access.js";
import {
  parsePrivateRelaySubmission,
  privateRelayEnvelopeHash,
} from "../modules/remote/private-relay-contracts.js";
import {
  sealPrivateEnvelope,
  privateEnvelopeSuite,
} from "../modules/remote/private-envelope.js";
export async function checkPrivateRelayAccess(pool: Pool) {
  let now = Date.now();
  const origin = "https://ai.bittrees.org",
    clock = () => now;
  const sessions = new RemoteSessionStore(pool, origin, 1, 3600000, clock),
    devices = new RemoteDeviceStore(pool, 7200000, clock),
    browsers = new RemoteBrowserDeviceStore(pool, origin, 1, 7200000, clock),
    access = new RemotePrivateRelayAccess(pool, origin, 1, clock);
  const request = () => ({
    operationId: randomUUID(),
    expected: null,
    expiresAt: now + 600000,
    confirmed: true,
  });
  async function fixture() {
    const wallet = Wallet.createRandom(),
      challenge = await sessions.begin(wallet.address),
      session = await sessions.verify({
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
    return { session, browser, mac };
  }
  const enable = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const browser = await access.enableBrowser(
        f.session.token,
        f.session.ownerId,
        f.browser.credential,
        request(),
      ),
      pending = await access.approveMac(f.session.token, f.session.ownerId, {
        ...request(),
        deviceId: f.mac.deviceId,
        credentialEpoch: f.mac.epoch,
      });
    const mac = await access.acceptMac(f.mac.credential, {
      id: pending.id,
      expectedRevision: pending.revision,
      confirmed: true,
    });
    return { browser, pending, mac };
  };
  const f = await fixture(),
    other = await fixture();
  await assert.rejects(
    access.withBrowser(
      f.session.token,
      f.session.ownerId,
      f.browser.credential,
      async () => true,
    ),
    /DENIED/,
  );
  await assert.rejects(
    access.withMac(f.mac.credential, async () => true),
    /DENIED/,
  );
  assert.equal(
    await access.inspectBrowser(
      f.session.token,
      f.session.ownerId,
      f.browser.credential,
    ),
    null,
  );
  for (const change of [
    { confirmed: false },
    { ownerId: other.session.ownerId },
    { expiresAt: now },
    { expiresAt: now + 7200001 },
  ])
    await assert.rejects(
      access.enableBrowser(
        f.session.token,
        f.session.ownerId,
        f.browser.credential,
        { ...request(), ...change },
      ),
      /INVALID_INPUT/,
    );
  const grantRequest = request(),
    browserGrant = await access.enableBrowser(
      f.session.token,
      f.session.ownerId,
      f.browser.credential,
      grantRequest,
    );
  assert.equal(browserGrant.state, "active");
  assert.equal(JSON.stringify(browserGrant).includes("credentialHash"), false);
  await assert.rejects(
    access.enableBrowser(
      f.session.token,
      f.session.ownerId,
      f.browser.credential,
      grantRequest,
    ),
    /CONFLICT/,
  );
  assert.deepEqual(
    await access.inspectOwnerOperation(f.session.token, f.session.ownerId, {
      operationId: grantRequest.operationId,
    }),
    browserGrant,
  );
  await assert.rejects(
    access.inspectOwnerOperation(other.session.token, other.session.ownerId, {
      operationId: grantRequest.operationId,
    }),
    /DENIED/,
  );
  await assert.rejects(
    access.inspectOwnerOperation(f.session.token, f.session.ownerId, {
      operationId: randomUUID(),
    }),
    /DENIED/,
  );
  const pending = await access.approveMac(f.session.token, f.session.ownerId, {
    ...request(),
    deviceId: f.mac.deviceId,
    credentialEpoch: f.mac.epoch,
  });
  assert.equal(pending.state, "pending");
  assert.equal(pending.approvalExpiresAt, now + 120000);
  await assert.rejects(
    access.withBrowser(
      f.session.token,
      f.session.ownerId,
      f.browser.credential,
      async (c) => c.recipient(f.mac.deviceId),
    ),
    /DENIED/,
  );
  await assert.rejects(
    access.acceptMac(other.mac.credential, {
      id: pending.id,
      expectedRevision: 1,
      confirmed: true,
    }),
    /DENIED/,
  );
  await assert.rejects(
    access.acceptMac(f.mac.credential, {
      id: pending.id,
      expectedRevision: 1,
      confirmed: false,
    }),
    /INVALID_INPUT/,
  );
  const accepted = await access.acceptMac(f.mac.credential, {
    id: pending.id,
    expectedRevision: 1,
    confirmed: true,
  });
  assert.equal(accepted.grant.revision, 2);
  assert.equal(accepted.scope, "private:relay");
  assert.notEqual(accepted.credential, f.mac.credential);
  await assert.rejects(
    access.acceptMac(f.mac.credential, {
      id: pending.id,
      expectedRevision: 2,
      confirmed: true,
    }),
    /DENIED/,
  );
  await assert.rejects(devices.identify(accepted.credential), /DENIED/);
  await assert.rejects(sessions.authenticate(accepted.credential), /DENIED/);
  await assert.rejects(
    access.withMac(f.mac.credential, async () => true),
    /DENIED/,
  );
  await assert.rejects(
    access.withMac(f.session.token, async () => true),
    /DENIED/,
  );
  const raw = (
    await pool.query(
      "SELECT * FROM remote_private_relay_grants WHERE owner_id=$1",
      [f.session.ownerId],
    )
  ).rows;
  assert.equal(JSON.stringify(raw).includes(accepted.credential), false);
  assert.equal(
    raw.find((r) => r.id === accepted.grant.id).credential_hash,
    createHash("sha256")
      .update("bittrees-private-relay-v1:" + accepted.credential)
      .digest("hex"),
  );
  let escaped: PrivateRelayTransaction | undefined;
  await access.withBrowser(
    f.session.token,
    f.session.ownerId,
    f.browser.credential,
    async (c) => {
      escaped = c;
      assert.equal(c.identity.permissionId, browserGrant.id);
      assert.equal(
        (await c.recipient(f.mac.deviceId)).permissionId,
        accepted.grant.id,
      );
    },
  );
  assert.throws(() => escaped!.check(), /DENIED/);
  await assert.rejects(escaped!.recipient(f.mac.deviceId), /DENIED/);
  await access.withMac(accepted.credential, async (c) =>
    assert.equal(
      (await c.recipient(f.browser.identity.binding.deviceId)).permissionId,
      browserGrant.id,
    ),
  );
  // The real maximum envelope fits authenticated identities; status credentials never supply them.
  const key = () =>
      crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
        "deriveBits",
      ]),
    senderKey = await key(),
    recipientKey = await key();
  const envelope = await sealPrivateEnvelope(
    {
      version: 1,
      suite: privateEnvelopeSuite,
      ownerId: f.session.ownerId,
      senderId: f.browser.identity.binding.deviceId,
      recipientId: f.mac.deviceId,
      senderKeyEpoch: 1,
      recipientKeyEpoch: 2,
      messageId: randomUUID(),
      operationId: randomUUID(),
      sequence: 1,
      issuedAt: now,
      expiresAt: now + 300000,
    },
    new Uint8Array(65536).fill(83),
    { senderKey, recipientPublicKey: recipientKey.publicKey },
    clock,
  );
  const expectedHash = await privateRelayEnvelopeHash(envelope);
  await access.withBrowser(
    f.session.token,
    f.session.ownerId,
    f.browser.credential,
    async (c) =>
      assert.equal(
        await privateRelayEnvelopeHash(
          parsePrivateRelaySubmission(
            { version: 1, envelope },
            c.identity,
            await c.recipient(f.mac.deviceId),
            now,
          ).envelope,
        ),
        expectedHash,
      ),
  );
  for (const attempt of [
    () =>
      access.inspectOwner(other.session.token, other.session.ownerId, {
        id: pending.id,
      }),
    () =>
      access.approveMac(other.session.token, other.session.ownerId, {
        ...request(),
        deviceId: f.mac.deviceId,
        credentialEpoch: 1,
      }),
    () =>
      access.withBrowser(
        other.session.token,
        f.session.ownerId,
        f.browser.credential,
        async () => true,
      ),
    () =>
      access.withBrowser(
        other.session.token,
        other.session.ownerId,
        f.browser.credential,
        async () => true,
      ),
    () =>
      access.withMac(accepted.credential, async (c) =>
        c.recipient(other.browser.identity.binding.deviceId),
      ),
  ])
    await assert.rejects(attempt(), /DENIED/);
  // Wrong origin/chain sessions, stale snapshots and duplicate operation IDs fail closed.
  for (const wrong of [
    new RemotePrivateRelayAccess(pool, "https://other.invalid", 1, clock),
    new RemotePrivateRelayAccess(pool, origin, 2, clock),
  ])
    await assert.rejects(
      wrong.withBrowser(
        f.session.token,
        f.session.ownerId,
        f.browser.credential,
        async () => true,
      ),
      /DENIED/,
    );
  await assert.rejects(
    access.revokeOwner(f.session.token, f.session.ownerId, {
      id: browserGrant.id,
      expectedRevision: 2,
      confirmed: true,
    }),
    /CONFLICT/,
  );
  await assert.rejects(
    access.enableBrowser(
      f.session.token,
      f.session.ownerId,
      f.browser.credential,
      { ...grantRequest, expected: { id: browserGrant.id, revision: 1 } },
    ),
    /CONFLICT/,
  );
  assert.equal(
    (await access.inspectBrowser(
      f.session.token,
      f.session.ownerId,
      f.browser.credential,
    ))!.id,
    browserGrant.id,
  );
  const replaced = await access.enableBrowser(
    f.session.token,
    f.session.ownerId,
    f.browser.credential,
    { ...request(), expected: { id: browserGrant.id, revision: 1 } },
  );
  assert.notEqual(replaced.id, browserGrant.id);
  assert.equal(
    (
      await access.inspectOwner(f.session.token, f.session.ownerId, {
        id: browserGrant.id,
      })
    ).state,
    "revoked",
  );
  const ownerRows = [],
    seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await access.listOwner(f.session.token, f.session.ownerId, {
      after: cursor,
      limit: 1,
    });
    assert.ok(page.items.length <= 1);
    for (const item of page.items) {
      assert.equal(item.ownerId, f.session.ownerId);
      assert.equal(seen.has(item.id), false);
      seen.add(item.id);
      ownerRows.push(item);
    }
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ownerRows.length, 3);
  assert.equal(JSON.stringify(ownerRows).includes(accepted.credential), false);
  assert.equal(JSON.stringify(ownerRows).includes("credential_hash"), false);
  for (const limit of [0, 51, 1.5])
    await assert.rejects(
      access.listOwner(f.session.token, f.session.ownerId, {
        after: null,
        limit,
      }),
      /INVALID_INPUT/,
    );
  const revoked = await access.revokeMac(accepted.credential, {
    id: accepted.grant.id,
    expectedRevision: 2,
    confirmed: true,
  });
  assert.equal(revoked.state, "revoked");
  await assert.rejects(
    access.withMac(accepted.credential, async () => true),
    /DENIED/,
  );
  assert.equal(
    (await devices.identify(f.mac.credential)).deviceId,
    f.mac.deviceId,
  );
  // Explicit registration/credential changes invalidate retained relay grants without borrowing other scopes.
  const rotated = await fixture(),
    r = await enable(rotated);
  await devices.rotate(rotated.mac.credential);
  await assert.rejects(
    access.withMac(r.mac.credential, async () => true),
    /DENIED/,
  );
  await browsers.revoke(rotated.session.token, rotated.session.ownerId, {
    deviceId: rotated.browser.identity.binding.deviceId,
    credentialEpoch: 1,
    confirmed: true,
  });
  await assert.rejects(
    access.withBrowser(
      rotated.session.token,
      rotated.session.ownerId,
      rotated.browser.credential,
      async () => true,
    ),
    /DENIED/,
  );
  const logged = await fixture();
  await enable(logged);
  await sessions.logout(logged.session.token);
  await assert.rejects(
    access.withBrowser(
      logged.session.token,
      logged.session.ownerId,
      logged.browser.credential,
      async () => true,
    ),
    /DENIED/,
  );
  // Concurrent creation uses the same owner lock and exact expected state; one approval wins.
  const concurrent = await fixture(),
    results = await Promise.allSettled(
      [1, 2].map(() =>
        access.enableBrowser(
          concurrent.session.token,
          concurrent.session.ownerId,
          concurrent.browser.credential,
          request(),
        ),
      ),
    );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.filter(
      (r) => r.status === "rejected" && /CONFLICT/.test(r.reason.message),
    ).length,
    1,
  );
  const limited = await fixture(),
    quota = new RemotePrivateRelayAccess(pool, origin, 1, clock, 1);
  const only = await quota.enableBrowser(
    limited.session.token,
    limited.session.ownerId,
    limited.browser.credential,
    request(),
  );
  await assert.rejects(
    quota.approveMac(limited.session.token, limited.session.ownerId, {
      ...request(),
      deviceId: limited.mac.deviceId,
      credentialEpoch: 1,
    }),
    /CAPACITY/,
  );
  assert.equal(
    (await quota.inspectBrowser(
      limited.session.token,
      limited.session.ownerId,
      limited.browser.credential,
    ))!.id,
    only.id,
  );
  // Expiry and rollback after a callback's SQL write roll back the whole transaction.
  const exp = await fixture(),
    ex = await enable(exp);
  await pool.query(
    "CREATE TABLE private_relay_rollback_probe(id uuid PRIMARY KEY)",
  );
  const before = now,
    id = randomUUID();
  await assert.rejects(
    access.withMac(ex.mac.credential, async (c) => {
      await c.db.query("INSERT INTO private_relay_rollback_probe VALUES($1)", [
        id,
      ]);
      now = ex.mac.grant.expiresAt;
      return true;
    }),
    /DENIED/,
  );
  assert.equal(
    (await pool.query("SELECT * FROM private_relay_rollback_probe")).rowCount,
    0,
  );
  now = before;
  await assert.rejects(
    access.withMac(ex.mac.credential, async (c) => {
      await c.db.query("INSERT INTO private_relay_rollback_probe VALUES($1)", [
        id,
      ]);
      now = before - 1;
      return true;
    }),
    /DENIED/,
  );
  assert.equal(
    (await pool.query("SELECT * FROM private_relay_rollback_probe")).rowCount,
    0,
  );
  now = before;
  // A revocation already holding the owner lock wins before authentication enters its callback.
  const lock = await pool.connect();
  try {
    await lock.query("BEGIN");
    await lock.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('bittrees-ai:private-relay:' || $1,0))",
      [exp.session.ownerId],
    );
    await lock.query(
      "UPDATE remote_private_relay_grants SET state='revoked',credential_hash=NULL,revoked_at=$2,revision=revision+1 WHERE id=$1",
      [ex.mac.grant.id, now],
    );
    let entered = false;
    const waiting = access.withMac(ex.mac.credential, async () => {
      entered = true;
      return true;
    });
    const rejection = assert.rejects(waiting, /DENIED/);
    await lock.query("COMMIT");
    await rejection;
    assert.equal(entered, false);
  } finally {
    await lock.query("ROLLBACK").catch(() => {});
    lock.release();
  }
  // Concurrent native opt-in returns exactly one new secret and never rotates it on a replay.
  const nativeRace = await fixture();
  const nativeApproval = await access.approveMac(
    nativeRace.session.token,
    nativeRace.session.ownerId,
    { ...request(), deviceId: nativeRace.mac.deviceId, credentialEpoch: 1 },
  );
  const nativeOutcomes = await Promise.allSettled(
    [1, 2].map(() =>
      access.acceptMac(nativeRace.mac.credential, {
        id: nativeApproval.id,
        expectedRevision: 1,
        confirmed: true,
      }),
    ),
  );
  assert.equal(
    nativeOutcomes.filter((r) => r.status === "fulfilled").length,
    1,
  );
  assert.equal(
    nativeOutcomes.filter(
      (r) => r.status === "rejected" && /DENIED/.test(r.reason.message),
    ).length,
    1,
  );
  const nativeWinner = nativeOutcomes.find((r) => r.status === "fulfilled")!;
  if (nativeWinner.status !== "fulfilled")
    throw Error("missing native acceptance");
  assert.equal(
    (
      await access.inspectOwner(
        nativeRace.session.token,
        nativeRace.session.ownerId,
        { id: nativeApproval.id },
      )
    ).revision,
    2,
  );
  const replacement = await access.approveMac(
    nativeRace.session.token,
    nativeRace.session.ownerId,
    {
      ...request(),
      deviceId: nativeRace.mac.deviceId,
      credentialEpoch: 1,
      expected: { id: nativeApproval.id, revision: 2 },
    },
  );
  await assert.rejects(
    access.withMac(nativeWinner.value.credential, async () => true),
    /DENIED/,
  );
  const replacementSecret = await access.acceptMac(nativeRace.mac.credential, {
    id: replacement.id,
    expectedRevision: 1,
    confirmed: true,
  });
  assert.notEqual(replacementSecret.credential, nativeWinner.value.credential);
  // The original browser session deadline and the recipient grant deadline fence callback writes too.
  const shortSession = await fixture(),
    shortGrants = await enable(shortSession);
  await pool.query(
    "UPDATE remote_sessions SET expires_at=$2 WHERE token_hash=$1",
    [
      createHash("sha256").update(shortSession.session.token).digest("hex"),
      now + 1000,
    ],
  );
  const sessionStart = now;
  await assert.rejects(
    access.withBrowser(
      shortSession.session.token,
      shortSession.session.ownerId,
      shortSession.browser.credential,
      async (c) => {
        await c.db.query(
          "INSERT INTO private_relay_rollback_probe VALUES($1)",
          [randomUUID()],
        );
        now = sessionStart + 1000;
        return true;
      },
    ),
    /DENIED/,
  );
  assert.equal(
    (await pool.query("SELECT * FROM private_relay_rollback_probe")).rowCount,
    0,
  );
  now = sessionStart;
  await pool.query(
    "UPDATE remote_private_relay_grants SET expires_at=$2 WHERE id=$1",
    [shortGrants.mac.grant.id, now + 500],
  );
  await assert.rejects(
    access.withBrowser(
      shortSession.session.token,
      shortSession.session.ownerId,
      shortSession.browser.credential,
      async (c) => {
        await c.recipient(shortSession.mac.deviceId);
        await c.db.query(
          "INSERT INTO private_relay_rollback_probe VALUES($1)",
          [randomUUID()],
        );
        now = sessionStart + 500;
        return true;
      },
    ),
    /DENIED/,
  );
  assert.equal(
    (await pool.query("SELECT * FROM private_relay_rollback_probe")).rowCount,
    0,
  );
  now = sessionStart;
  const expired = await fixture(),
    approval = await access.approveMac(
      expired.session.token,
      expired.session.ownerId,
      { ...request(), deviceId: expired.mac.deviceId, credentialEpoch: 1 },
    );
  now = approval.approvalExpiresAt!;
  await assert.rejects(
    access.acceptMac(expired.mac.credential, {
      id: approval.id,
      expectedRevision: 1,
      confirmed: true,
    }),
    /DENIED/,
  );
  assert.equal(
    (
      await access.inspectOwner(
        expired.session.token,
        expired.session.ownerId,
        { id: approval.id },
      )
    ).state,
    "pending",
  );
  console.log(
    "Private relay permission integration passed: independent browser/native opt-in, scoped hashed secrets, exact revisions, cross-owner denial, current endpoint/session/grant locks, expiry/rollback, quota/concurrency and actual maximum encrypted-envelope identity. Synthetic stores only.",
  );
}
