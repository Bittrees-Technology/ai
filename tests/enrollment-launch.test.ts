import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { launchEnrollment } from "../apps/companion/enrollment-launch.js";
test("native launcher needs protected current operator configuration before any unlock", async () => {
  const dir = await mkdtemp(tmpdir() + "/enrollment-launch-");
  let unlocks = 0;
  const unlock = async () => {
    unlocks++;
    throw Error("Unexpected unlock");
  };
  const config = {
    version: 1,
    authorityId: randomUUID(),
    deviceId: randomUUID(),
    ownerWallet: "0x" + "a".repeat(40),
    identityDigest: "a".repeat(64),
    credentialDigest: "b".repeat(64),
    sourceAccessApproved: true,
    costBasis: "verified-included-usage",
    evidenceId: "fixture-only",
    approvedAt: 1000,
    expiresAt: 2000,
  };
  try {
    assert.equal(await launchEnrollment(dir, unlock, () => 1500), null);
    await writeFile(dir + "/native-enrollment.json", JSON.stringify(config), {
      mode: 0o600,
    });
    await assert.rejects(
      launchEnrollment(dir, unlock, () => 3000),
      /expired/,
    );
    await assert.rejects(
      launchEnrollment(dir, unlock, () => 0),
      /expired/,
    );
    await writeFile(
      dir + "/native-enrollment.json",
      JSON.stringify({ ...config, costBasis: "unknown" }),
    );
    await assert.rejects(launchEnrollment(dir, unlock, () => 1500));
    await writeFile(
      dir + "/native-enrollment.json",
      JSON.stringify({ ...config, costBasis: "explicit-one-time-approval" }),
    );
    await assert.rejects(
      launchEnrollment(dir, unlock, () => 1500),
      /aggregate approval/,
    );
    assert.equal(unlocks, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("configured launcher separates native consent and core execution; changed approval denies before network", async () => {
  const { generateKeyPairSync, randomBytes, createHash } =
    await import("node:crypto");
  const { default: Database } = await import("better-sqlite3");
  const { Vault } = await import("../modules/storage/vault.js");
  const { existsSync } = await import("node:fs");
  const dir = await mkdtemp(tmpdir() + "/enrollment-launch-live-");
  const vault = new Vault(randomBytes(32)),
    pair = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
  const identity = {
    principal: "agent:" + randomUUID(),
    publicKey: pair.publicKey,
    sourceWorkspace: randomUUID(),
  };
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  const token = "a".repeat(64),
    now = Date.now();
  const config = {
    version: 1,
    authorityId: randomUUID(),
    deviceId: randomUUID(),
    ownerWallet: "0x" + "a".repeat(40),
    identityDigest: hash(JSON.stringify(identity)),
    credentialDigest: hash(token),
    sourceAccessApproved: true,
    costBasis: "verified-included-usage",
    evidenceId: "fixture",
    approvedAt: now - 1000,
    expiresAt: now + 60000,
  };
  let launched: Awaited<ReturnType<typeof launchEnrollment>> = null;
  try {
    const db = new Database(dir + "/task-sync.db");
    db.exec("CREATE TABLE state(key TEXT PRIMARY KEY,value BLOB NOT NULL)");
    db.prepare("INSERT INTO state VALUES (?,?)").run(
      "key",
      vault.seal({ ...pair, principal: identity.principal }, "task-sync:key"),
    );
    db.prepare("INSERT INTO state VALUES (?,?)").run(
      "review",
      vault.seal(
        { sourceWorkspace: identity.sourceWorkspace },
        "task-sync:review",
      ),
    );
    db.close();
    await writeFile(
      dir + "/workflow-device.enc",
      vault.seal({ controlToken: token }, "workflow-device"),
    );
    await writeFile(dir + "/native-enrollment.json", JSON.stringify(config), {
      mode: 0o600,
    });
    launched = await launchEnrollment(dir, async () => vault);
    assert.ok(launched);
    const env = launched.environment;
    const call = (url: string, key: string, body: unknown) =>
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + key,
        },
        body: JSON.stringify(body),
      });
    assert.equal(existsSync(dir + "/native-enrollment.db"), false);
    assert.equal(
      (
        await call(
          env.BITTREES_ENROLLMENT_CONTROL_URL,
          env.BITTREES_ENROLLMENT_HELPER_TOKEN,
          { action: "propose" },
        )
      ).status,
      403,
    );
    const proposal = (await (
      await call(
        env.BITTREES_ENROLLMENT_CONTROL_URL,
        env.BITTREES_ENROLLMENT_CONTROL_TOKEN,
        { action: "propose" },
      )
    ).json()) as any;
    assert.equal(
      (
        await call(
          env.BITTREES_ENROLLMENT_CONTROL_URL,
          env.BITTREES_ENROLLMENT_CONTROL_TOKEN,
          { action: "approve", digest: proposal.digest },
        )
      ).status,
      200,
    );
    assert.equal(existsSync(dir + "/native-enrollment.db"), true);
    await writeFile(
      dir + "/native-enrollment.json",
      JSON.stringify({ ...config, evidenceId: "changed" }),
    );
    assert.notEqual(
      (
        await call(
          env.BITTREES_ENROLLMENT_HELPER_URL,
          env.BITTREES_ENROLLMENT_HELPER_TOKEN,
          { operation: "heartbeat" },
        )
      ).status,
      200,
    );
  } finally {
    await launched?.service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("central-purpose launcher uses its existing identity and separate typed broker, without task-sync fallback or source calls", async () => {
  const { generateKeyPairSync, randomBytes, createHash } =
    await import("node:crypto");
  const { default: Database } = await import("better-sqlite3");
  const { Vault } = await import("../modules/storage/vault.js");
  const { realpath, access } = await import("node:fs/promises");
  const { nativeCentralEnrollmentClient } =
    await import("../modules/workflows/central-enrollment-client.js");
  const { nativeEnrollmentClient } =
    await import("../modules/task-sync/enrollment-client.js");
  const dir = await realpath(
      await mkdtemp(tmpdir() + "/central-enrollment-launch-"),
    ),
    vault = new Vault(randomBytes(32)),
    time = Date.now();
  const key = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const saved = {
    ...key,
    principal: "agent:" + randomUUID(),
    credentialId: createHash("sha256").update(key.publicKey).digest("hex"),
  };
  const db = new Database(dir + "/central-workflows.db");
  db.exec("CREATE TABLE state(key TEXT PRIMARY KEY,value BLOB NOT NULL)");
  db.prepare("INSERT INTO state VALUES('identity',?)").run(
    vault.seal(saved, "central-workflows:identity"),
  );
  db.close();
  const control = "a".repeat(64);
  await writeFile(
    dir + "/workflow-device.enc",
    vault.seal({ controlToken: control }, "workflow-device"),
    { mode: 0o600 },
  );
  const runtimeApproval = {
    approvalId: randomUUID(),
    reference: "synthetic-owner-approval",
    pricingReference: "synthetic-pricing-evidence",
    authorizedAt: time - 1000,
    authorizationExpiresAt: time + 60000,
    approvedAt: time - 1000,
    expiresAt: time + 60000,
    providers: ["neon", "vercel"],
    maximumMicroUSD: 1000000,
    maximumAttempts: 108,
    ceilings: {
      enrollment: 10000,
      central: 10000,
      assignment: 10000,
      attestation: 10000,
    },
  };
  const config = {
    version: 1,
    purpose: "central-workflows",
    authorityId: randomUUID(),
    deviceId: randomUUID(),
    sourceWorkspace: randomUUID(),
    ownerWallet: "0x" + "a".repeat(40),
    principal: saved.principal,
    credentialId: saved.credentialId,
    credentialDigest: createHash("sha256").update(control).digest("hex"),
    sourceAccessApproved: true,
    costBasis: "explicit-one-time-approval",
    runtimeApproval,
    evidenceId: "synthetic-only",
    approvedAt: time - 1000,
    expiresAt: time + 60000,
  };
  await writeFile(dir + "/native-enrollment.json", JSON.stringify(config), {
    mode: 0o600,
  });
  let launched: Awaited<ReturnType<typeof launchEnrollment>> = null;
  try {
    launched = await launchEnrollment(
      dir,
      async () => vault,
      () => time,
    );
    assert.ok(launched);
    assert.equal(
      launched.environment.BITTREES_ENROLLMENT_PURPOSE,
      "central-workflows",
    );
    assert.equal(nativeEnrollmentClient(launched.environment), undefined);
    const client = nativeCentralEnrollmentClient(launched.environment)!;
    await assert.rejects(
      client.execute({ action: "status" }, AbortSignal.timeout(3000)),
    );
    const post = (body: unknown) =>
      fetch(launched!.environment.BITTREES_ENROLLMENT_CONTROL_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization:
            "Bearer " + launched!.environment.BITTREES_ENROLLMENT_CONTROL_TOKEN,
        },
        body: JSON.stringify(body),
      });
    const proposal = await (await post({ action: "propose" })).json();
    assert.equal(proposal.review.principal, saved.principal);
    assert.equal(proposal.review.publicKey, saved.publicKey);
    assert.match(proposal.disclosure.purpose, /central Workflows identity/);
    assert.equal(proposal.disclosure.maximumAdditionalMicroUSD, 1000000);
    assert.equal("additionalSpendingUSD" in proposal.disclosure, false);
    assert.equal(
      (await post({ action: "approve", digest: proposal.digest })).status,
      200,
    );
    const status = await client.execute(
      { action: "status" },
      AbortSignal.timeout(3000),
    );
    assert.equal(status.principal, saved.principal);
    assert.equal(status.state.status, "not-started");
    await assert.rejects(
      client.execute(
        { operation: "attest", request: {} },
        AbortSignal.timeout(3000),
      ),
    );
    assert.equal(status.permissionsGranted, false);
    assert.equal(status.enrollment, null);
    await assert.rejects(access(dir + "/task-sync.db"));
    await assert.rejects(access(dir + "/native-runtime-cost.db"));
  } finally {
    await launched?.service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
