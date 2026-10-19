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
