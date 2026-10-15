import { acceptStatus } from "../modules/coordinator/status-sync.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { Wallet } from "ethers";
import {
  challenge,
  verifyChallenge,
  registerDevice,
  portalList,
  controlWorkflow,
  deviceControl,
  hash,
} from "../modules/coordinator/workflow-portal.js";
import { cloudAuthority } from "../modules/coordinator/cloud-authority.js";
const url = process.env.COORDINATOR_TEST_DATABASE_URL || "";
if (!/^postgres(?:ql)?:\/\/[^@]+@127\.0\.0\.1:\d+\/coordinator_e2e$/.test(url))
  throw Error("Dedicated local test DB required");
const db = new Pool({ connectionString: url });
const ids: string[] = [];
try {
  for (const f of [
    "workflow-authority.sql",
    "marketplace-coordinator.sql",
    "marketplace-status.sql",
    "workflow-wallet-permissions.sql",
  ])
    await db.query(await readFile("modules/remote/migrations/" + f, "utf8"));
  const wallet = Wallet.createRandom(),
    other = Wallet.createRandom(),
    addr = wallet.address.toLowerCase(),
    browser = randomBytes(32).toString("hex");
  const login = await challenge(db, browser, { action: "login", wallet: addr });
  const signature = await wallet.signMessage(login.message);
  await assert.rejects(
    verifyChallenge(db, "wrong-browser", { id: login.id, signature }),
  );
  const session = await verifyChallenge(db, browser, {
    id: login.id,
    signature,
  });
  assert.equal(session.wallet, addr);
  await assert.rejects(
    verifyChallenge(db, browser, { id: login.id, signature }),
  );
  const device = await registerDevice(db, {
    deviceLabel: "Test Mac",
    modelLabel: "Local model",
  });
  ids.push(device.authorityId);
  assert.equal(
    (await portalList(db, addr)).grants.some(
      (g) => g.id === device.authorityId,
    ),
    false,
  );
  const credential = randomBytes(32).toString("hex");
  await db.query(
    "INSERT INTO workflow_credentials(token_hash,authority_id,audience,scopes) VALUES($1,$2,'mercado','[\"publish:qualified\"]')",
    [hash(credential), device.authorityId],
  );
  const own = (
    await db.query("SELECT owner_id FROM workflow_authorities WHERE id=$1", [
      device.authorityId,
    ])
  ).rows[0].owner_id;
  const snap = {
    runId: device.deviceId,
    revision: 1,
    counts: { "mercado:decided": 1 },
    outcomes: [
      {
        source: "mercado",
        state: "decided",
        held: true,
        reason: "Review stock",
      },
    ],
  };
  await acceptStatus(db, own, snap);
  await acceptStatus(db, own, snap);
  await assert.rejects(
    acceptStatus(db, own, {
      ...snap,
      outcomes: [{ ...snap.outcomes[0], reason: "Changed" }],
    }),
  );
  await db.query("DELETE FROM marketplace_status WHERE owner_id=$1", [own]);
  const check = () =>
    cloudAuthority(db, credential, {
      action: "check",
      audience: "mercado",
      scope: "publish:qualified",
    });
  await assert.rejects(check());
  await assert.rejects(
    challenge(
      db,
      browser,
      {
        action: "approve",
        wallet: addr,
        authorityId: device.authorityId,
        duration: "month",
      },
      addr,
    ),
  );
  const grant = await challenge(
    db,
    browser,
    {
      action: "approve",
      wallet: addr,
      authorityId: device.authorityId,
      pairCode: device.pairCode,
      duration: "month",
    },
    addr,
  );
  await assert.rejects(
    verifyChallenge(
      db,
      browser,
      { id: grant.id, signature: await other.signMessage(grant.message) },
      addr,
    ),
  );
  await verifyChallenge(
    db,
    browser,
    { id: grant.id, signature: await wallet.signMessage(grant.message) },
    addr,
  );
  assert.equal((await check()).active, true);
  await assert.rejects(
    cloudAuthority(db, credential, {
      action: "check",
      audience: "crm",
      scope: "import:qualified",
    }),
  );
  assert.equal(
    (await portalList(db, other.address.toLowerCase())).grants.some(
      (g) => g.id === device.authorityId,
    ),
    false,
  );
  await assert.rejects(
    controlWorkflow(db, other.address.toLowerCase(), {
      action: "pause",
      authorityId: device.authorityId,
    }),
  );
  await controlWorkflow(db, addr, {
    action: "pause",
    authorityId: device.authorityId,
  });
  await assert.rejects(check());
  await assert.rejects(
    deviceControl(db, device.controlToken, { action: "resume" }),
  );
  const resume = await challenge(
    db,
    browser,
    {
      action: "approve",
      wallet: addr,
      authorityId: device.authorityId,
      duration: "until-revoked",
    },
    addr,
  );
  await verifyChallenge(
    db,
    browser,
    { id: resume.id, signature: await wallet.signMessage(resume.message) },
    addr,
  );
  assert.equal((await check()).active, true);
  await db.query(
    "UPDATE workflow_credentials SET scopes=scopes || '\"arbitrary\"'::jsonb WHERE token_hash=$1",
    [hash(credential)],
  );
  await assert.rejects(
    cloudAuthority(db, credential, {
      action: "check",
      audience: "mercado",
      scope: "arbitrary",
    }),
  );
  const stale = await challenge(
    db,
    browser,
    {
      action: "approve",
      wallet: addr,
      authorityId: device.authorityId,
      duration: "month",
    },
    addr,
  );
  await db.query(
    "UPDATE workflow_authorities SET device_label='Changed Mac' WHERE id=$1",
    [device.authorityId],
  );
  await assert.rejects(
    verifyChallenge(
      db,
      browser,
      { id: stale.id, signature: await wallet.signMessage(stale.message) },
      addr,
    ),
  );
  await db.query(
    "UPDATE workflow_authorities SET approval_expires_at=now()-interval '1 second' WHERE id=$1",
    [device.authorityId],
  );
  await assert.rejects(check());
  await controlWorkflow(db, addr, {
    action: "revoke",
    authorityId: device.authorityId,
  });
  await assert.rejects(check());
  await assert.rejects(
    challenge(
      db,
      browser,
      {
        action: "approve",
        wallet: addr,
        authorityId: device.authorityId,
        duration: "month",
      },
      addr,
    ),
  );
  console.log(
    "Passed: wallet signature, browser binding, replay, device pairing, owner isolation, unsigned denial, scope expansion denial, changed-device denial, pause, signed resume, expiry and permanent revocation.",
  );
} finally {
  for (const id of ids) {
    await db.query(
      "DELETE FROM workflow_authority_audit WHERE authority_id=$1",
      [id],
    );
    await db.query("DELETE FROM workflow_credentials WHERE authority_id=$1", [
      id,
    ]);
    await db.query("DELETE FROM workflow_authorities WHERE id=$1", [id]);
  }
  await db.end();
}
