import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { Wallet } from "ethers";
import type { Pool } from "pg";
import { RemoteSessionStore } from "../modules/remote/sessions.js";
import { RemoteDeviceStore } from "../modules/remote/devices.js";

export async function checkRemoteSessions(pool: Pool) {
  let now = Date.now();
  const sessions = new RemoteSessionStore(
    pool,
    "https://ai.bittrees.org",
    1,
    3600000,
    () => now,
  );
  const wallet = Wallet.createRandom(),
    otherWallet = Wallet.createRandom();
  const begin = await sessions.begin(wallet.address);
  const request = {
    id: begin.id,
    browserToken: begin.browserToken,
    message: begin.message,
    signature: await wallet.signMessage(begin.message),
  };
  await assert.rejects(
    sessions.verify({
      ...request,
      browserToken: randomBytes(32).toString("base64url"),
    }),
    /DENIED/,
  );
  await assert.rejects(
    sessions.verify({
      ...request,
      signature: await otherWallet.signMessage(begin.message),
    }),
    /DENIED/,
  );
  for (const [from, to] of [
    ["ai.bittrees.org", "evil.example"],
    ["Chain ID: 1", "Chain ID: 2"],
    ["Nonce: ", "Nonce: abc"],
    ["This does not grant", "This grants"],
  ]) {
    const message = begin.message.replace(from!, to!);
    await assert.rejects(
      sessions.verify({
        ...request,
        message,
        signature: await wallet.signMessage(message),
      }),
      /DENIED/,
    );
  }
  await assert.rejects(
    sessions.verify({ ...request, ownerId: "caller-chosen" }),
    /DENIED/,
  );
  await assert.rejects(
    sessions.verify({ ...request, signature: "0x00" }),
    /DENIED/,
  );
  const wrongOrigin = new RemoteSessionStore(
    pool,
    "https://other.example",
    1,
    3600000,
    () => now,
  );
  await assert.rejects(wrongOrigin.verify(request), /DENIED/);
  const wrongChain = new RemoteSessionStore(
    pool,
    "https://ai.bittrees.org",
    2,
    3600000,
    () => now,
  );
  await assert.rejects(wrongChain.verify(request), /DENIED/);
  const outcomes = await Promise.allSettled([
    sessions.verify(request),
    sessions.verify(request),
  ]);
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  const success = outcomes.find((x) => x.status === "fulfilled")!;
  if (success.status !== "fulfilled") throw Error("Expected verified session");
  const session = success.value;
  assert.equal(session.expiresAt, now + 3600000);
  await assert.rejects(wrongOrigin.authenticate(session.token), /DENIED/);
  await assert.rejects(wrongChain.authenticate(session.token), /DENIED/);
  const auth = await new RemoteSessionStore(
    pool,
    "https://ai.bittrees.org",
    1,
    3600000,
    () => now,
  ).authenticate(session.token);
  assert.deepEqual(auth, { ownerId: session.ownerId });
  const raw = (
    await pool.query("SELECT * FROM remote_sessions WHERE owner_id=$1", [
      session.ownerId,
    ])
  ).rows;
  assert.equal(
    raw[0].token_hash,
    createHash("sha256").update(session.token).digest("hex"),
  );
  assert.ok(!JSON.stringify(raw).includes(session.token));
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM remote_login_challenges WHERE id=$1",
        [begin.id],
      )
    ).rows[0].count,
    "0",
  );

  // Verified identity can approve a pairing, without wallet text being treated as an owner ID.
  const devices = new RemoteDeviceStore(pool, 3600000, () => now);
  const verifier = randomBytes(32).toString("base64url");
  const pair = await devices.begin(
    createHash("sha256").update(verifier).digest("base64url"),
  );
  await devices.approve(auth.ownerId, pair.id, pair.approvalCode);
  const paired = await devices.redeem(pair.id, verifier, auth.ownerId);
  assert.equal(paired.ownerId, session.ownerId);
  assert.equal(paired.scope, "status:publish");
  await assert.rejects(sessions.authenticate(paired.credential), /DENIED/);
  await assert.rejects(devices.authenticate(session.token), /DENIED/);
  const again = await sessions.begin(wallet.address.toLowerCase());
  const same = await sessions.verify({
    id: again.id,
    browserToken: again.browserToken,
    message: again.message,
    signature: await wallet.signMessage(again.message),
  });
  assert.equal(same.ownerId, session.ownerId);
  const other = await sessions.begin(otherWallet.address);
  const different = await sessions.verify({
    id: other.id,
    browserToken: other.browserToken,
    message: other.message,
    signature: await otherWallet.signMessage(other.message),
  });
  assert.notEqual(different.ownerId, session.ownerId);
  await sessions.logout(session.token);
  await assert.rejects(sessions.authenticate(session.token), /DENIED/);
  assert.equal((await sessions.authenticate(same.token)).ownerId, same.ownerId);

  const expired = await sessions.begin(wallet.address);
  const signedExpired = {
    id: expired.id,
    browserToken: expired.browserToken,
    message: expired.message,
    signature: await wallet.signMessage(expired.message),
  };
  now += 300000;
  await assert.rejects(sessions.verify(signedExpired), /DENIED/);
  // Expiry during issuance leaves neither a session nor a consumed challenge.
  const late = await sessions.begin(wallet.address);
  const signedLate = {
    id: late.id,
    browserToken: late.browserToken,
    message: late.message,
    signature: await wallet.signMessage(late.message),
  };
  let ticks = 0;
  const lateStore = new RemoteSessionStore(
    pool,
    "https://ai.bittrees.org",
    1,
    3600000,
    () => now + (ticks++ === 0 ? 0 : 300000),
  );
  const count = (await pool.query("SELECT count(*) FROM remote_sessions"))
    .rows[0].count;
  await assert.rejects(lateStore.verify(signedLate), /DENIED/);
  assert.equal(
    (await pool.query("SELECT count(*) FROM remote_sessions")).rows[0].count,
    count,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM remote_login_challenges WHERE id=$1",
        [late.id],
      )
    ).rows[0].count,
    "1",
  );
  now += 3600000;
  await assert.rejects(sessions.authenticate(same.token), /DENIED/);
  await sessions.purgeExpired();
  assert.equal(
    (await pool.query("SELECT count(*) FROM remote_sessions")).rows[0].count,
    "0",
  );
  assert.equal(
    (await pool.query("SELECT count(*) FROM remote_login_challenges")).rows[0]
      .count,
    "0",
  );
  await assert.rejects(sessions.begin("invalid"), /INVALID_INPUT/);
  assert.throws(
    () => new RemoteSessionStore(pool, "http://ai.bittrees.org", 1, 3600000),
    /INVALID_INPUT/,
  );
}
