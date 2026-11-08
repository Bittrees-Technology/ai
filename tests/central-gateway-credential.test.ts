import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHash,
  randomBytes,
  randomUUID,
  generateKeyPairSync,
} from "node:crypto";
import Database from "better-sqlite3";
import { Vault } from "../modules/storage/vault.js";
import { canonical } from "../modules/contracts/canonical-json.js";
import {
  readCompletedCentralEnrollment,
  prepareCentralGatewayCredential,
  readPreparedCentralGatewayReceipt,
  centralGatewayReviewActions,
  existingPreparedCentralGatewayCredential,
} from "../modules/workflows/central-gateway-credential.js";
import {
  existingCentralCredential,
  savedCentralState,
} from "../modules/workflows/central-saved-state.js";
import { launchWorkflowSetup } from "../apps/companion/workflow-setup-launch.js";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
function fixture() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "gateway-custody-")),
    vault = new Vault(randomBytes(32));
  const pair = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { format: "pem", type: "spki" },
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
  });
  const identity = {
    ...pair,
    principal: "agent:" + randomUUID(),
    credentialId: hash(pair.publicKey),
  };
  const central = join(dir, "central-workflows.db"),
    path = join(dir, "native-central-enrollment.db");
  const db = new Database(central);
  db.exec("CREATE TABLE state(key TEXT PRIMARY KEY,value BLOB NOT NULL)");
  db.prepare("INSERT INTO state VALUES('identity',?)").run(
    vault.seal(identity, "central-workflows:identity"),
  );
  db.close();
  const at = Date.now(),
    ownerWallet = "0x" + "a".repeat(40),
    profile = randomUUID(),
    authorityId = randomUUID(),
    deviceId = randomUUID(),
    sourceWorkspace = randomUUID();
  const binding = {
    version: 1 as const,
    ownerProfileId: profile,
    ownerWallet,
    authorityId,
    deviceId,
    principal: identity.principal,
    credentialId: identity.credentialId,
    sourceWorkspace,
    tenant: "roles:" + profile,
    workspace: "crm:" + sourceWorkspace,
  };
  const e = {
    principal: identity.principal,
    publicKey: identity.publicKey,
    credentialId: identity.credentialId,
    binding,
    runtimeBindingDigest: hash(canonical(binding)),
    permissionsGranted: false as const,
  };
  const candidate = {
    kind: "enroll",
    version: 1,
    audience: "https://mcp.bittrees.org",
    principal: identity.principal,
    publicKey: identity.publicKey,
    authorityId,
    deviceId,
    sourceWorkspace,
    ownerWallet,
    issuedAt: at,
    nonce: randomUUID(),
  };
  const review = {
    epoch: randomUUID(),
    expiresAt: at + 300000,
    principal: identity.principal,
    publicKey: identity.publicKey,
    authorityId,
    deviceId,
    sourceWorkspace,
    ownerWallet,
  };
  const handoff = {
    candidate,
    id: randomUUID(),
    pollSecret: "b".repeat(64),
    reviewUrl:
      "https://roles.bittrees.org/profile?runtimeRequest=" + randomUUID(),
    expiresAt: new Date(at + 300000).toISOString(),
    status: "complete",
    result: e,
  };
  const write = (value: unknown) => {
    const db = new Database(path);
    db.exec(
      "CREATE TABLE IF NOT EXISTS central_native_handoffs(id TEXT PRIMARY KEY,record BLOB NOT NULL)",
    );
    const id = hash(identity.principal + "\n" + identity.publicKey);
    db.prepare(
      "INSERT OR REPLACE INTO central_native_handoffs VALUES(?,?)",
    ).run(id, vault.seal(value, "central-native-handoff:" + id));
    db.close();
    chmodSync(path, 0o600);
  };
  const original = { review, candidate, handoff };
  write(original);
  return {
    dir,
    vault,
    central,
    path,
    e,
    identity,
    original,
    write,
    clean: () => rmSync(dir, { recursive: true, force: true }),
  };
}
test("separate native review prepares one encrypted gateway bearer; restart/lost reply retain it", async () => {
  const f = fixture();
  let setup: Awaited<ReturnType<typeof launchWorkflowSetup>> | undefined;
  try {
    const before = readFileSync(f.central),
      enrollmentBefore = readFileSync(f.path);
    const launch = () => launchWorkflowSetup(f.dir, async () => f.vault);
    setup = await launch();
    const call = (
      body: unknown,
      token = setup!.environment.BITTREES_CENTRAL_GATEWAY_SETUP_TOKEN,
    ) =>
      fetch(setup!.environment.BITTREES_CENTRAL_GATEWAY_SETUP_URL, {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    let response = await call({ action: "propose" });
    assert.equal(response.status, 200);
    let p: any = await response.json();
    assert.equal(p.prepared, null);
    assert.equal(existsSync(join(f.dir, "native-central-gateway.db")), false);
    assert.equal(
      (
        await call(
          { action: "approve", digest: p.digest },
          setup.environment.BITTREES_WORKFLOW_SETUP_TOKEN,
        )
      ).status,
      403,
    );
    assert.equal(
      (await call({ action: "approve", digest: p.digest })).status,
      200,
    );
    const receipt = readPreparedCentralGatewayReceipt(f.dir, f.vault);
    assert.equal(Object.hasOwn(receipt, "token"), false);
    assert.equal(receipt.permissionsGranted, false);
    assert.equal(receipt.configuresWorker, false);
    const token = existingPreparedCentralGatewayCredential(f.dir, f.vault, {
      ...f.e.binding,
      reference: receipt.credentialReference,
    });
    assert.equal(hash(token), receipt.actorTokenHash);
    assert.equal(
      readFileSync(join(f.dir, "native-central-gateway.db")).includes(token),
      false,
    );
    await setup.close();
    setup = await launch();
    // Deliberately treat the original approve reply as lost. A second native
    // review recovers the SAME durable credential, not a replacement token.
    response = await call({ action: "propose" });
    p = await response.json();
    assert.equal(p.prepared.actorTokenHash, receipt.actorTokenHash);
    assert.equal(
      (await call({ action: "approve", digest: p.digest })).status,
      200,
    );
    assert.deepEqual(
      readPreparedCentralGatewayReceipt(f.dir, f.vault),
      receipt,
    );
    assert.deepEqual(readFileSync(f.central), before);
    assert.deepEqual(readFileSync(f.path), enrollmentBefore);
    assert.equal(existsSync(join(f.dir, "native-runtime-cost.db")), false);
    assert.equal(JSON.stringify(p).includes(token), false);
    assert.equal(JSON.stringify(p).includes(f.identity.privateKey), false);
    assert.equal(
      JSON.stringify(p).includes(f.original.handoff.pollSecret),
      false,
    );
  } finally {
    await setup?.close();
    f.clean();
  }
});
test("public reference resolves only in native scope; central identity/config guards remain", () => {
  const f = fixture();
  try {
    const receipt = prepareCentralGatewayCredential(
      f.dir,
      f.vault,
      f.e,
      () => {},
    );
    const config = {
      confirmed: true,
      enabled: false,
      tenant: f.e.binding.tenant,
      workspace: f.e.binding.workspace,
      connectionId: randomUUID(),
      workflowId: "approved-workflow",
      delegationId: randomUUID(),
      profileId: randomUUID(),
      mcpToken: receipt.credentialReference,
    };
    const put = (c: unknown) => {
      const db = new Database(f.central);
      db.prepare("INSERT OR REPLACE INTO state VALUES('config',?)").run(
        f.vault.seal(c, "central-workflows:config"),
      );
      db.close();
    };
    put(config);
    assert.equal(
      savedCentralState(f.central, f.vault).mcpCredentialDigest,
      receipt.actorTokenHash,
    );
    assert.equal(
      hash(existingCentralCredential(f.central, f.vault)),
      receipt.actorTokenHash,
    );
    put({ ...config, workspace: "crm:" + randomUUID() });
    assert.throws(
      () => existingCentralCredential(f.central, f.vault),
      /outside/,
    );
    put({ ...config, mcpToken: "native-central-gateway:" + "f".repeat(64) });
    assert.throws(
      () => existingCentralCredential(f.central, f.vault),
      /outside/,
    );
    assert.throws(() =>
      readPreparedCentralGatewayReceipt(f.dir, new Vault(randomBytes(32))),
    );
  } finally {
    f.clean();
  }
});
test("missing/unfinished/changed enrollment, altered review and revocation cannot prepare a credential", async () => {
  const f = fixture();
  try {
    for (const value of [
      { ...f.original, handoff: { ...f.original.handoff, status: "pending" } },
      {
        ...f.original,
        handoff: {
          ...f.original.handoff,
          result: {
            ...f.e,
            binding: { ...f.e.binding, ownerWallet: "0x" + "c".repeat(40) },
          },
        },
      },
      {
        ...f.original,
        candidate: { ...f.original.candidate, deviceId: randomUUID() },
      },
    ]) {
      f.write(value);
      assert.throws(() => readCompletedCentralEnrollment(f.dir, f.vault));
      assert.equal(existsSync(join(f.dir, "native-central-gateway.db")), false);
    }
    f.write(f.original);
    let at = Date.now(),
      revoking = false;
    const actions = centralGatewayReviewActions(
      async () => readCompletedCentralEnrollment(f.dir, f.vault),
      async (e, admitted) =>
        prepareCentralGatewayCredential(
          f.dir,
          f.vault,
          e,
          () => {
            admitted();
            if (revoking) throw Error("revoked");
          },
          () => at,
        ),
      () => at,
    );
    let p = await actions.propose();
    await assert.rejects(actions.approve("0".repeat(64)));
    actions.revoke();
    await assert.rejects(actions.approve(p.digest));
    p = await actions.propose();
    at += 60000;
    await assert.rejects(actions.approve(p.digest));
    p = await actions.propose();
    revoking = true;
    await assert.rejects(actions.approve(p.digest), /revoked/);
    assert.equal(existsSync(join(f.dir, "native-central-gateway.db")), false);
    actions.close();
    await assert.rejects(actions.propose());
    chmodSync(f.path, 0o644);
    assert.throws(
      () => readCompletedCentralEnrollment(f.dir, f.vault),
      /Protected/,
    );
  } finally {
    f.clean();
  }
});
test("existing gateway ciphertext and bindings cannot be overwritten or redirected", () => {
  const f = fixture();
  try {
    prepareCentralGatewayCredential(f.dir, f.vault, f.e, () => {});
    const path = join(f.dir, "native-central-gateway.db"),
      before = readFileSync(path);
    assert.throws(() =>
      prepareCentralGatewayCredential(
        f.dir,
        f.vault,
        { ...f.e, runtimeBindingDigest: "0".repeat(64) },
        () => {},
      ),
    );
    assert.deepEqual(readFileSync(path), before);
    chmodSync(path, 0o644);
    assert.throws(
      () => prepareCentralGatewayCredential(f.dir, f.vault, f.e, () => {}),
      /Protected/,
    );
    chmodSync(path, 0o600);
    const db = new Database(path);
    db.prepare("UPDATE state SET value=? WHERE id='gateway'").run(
      randomBytes(64),
    );
    db.close();
    const corrupt = readFileSync(path);
    assert.throws(() =>
      prepareCentralGatewayCredential(f.dir, f.vault, f.e, () => {}),
    );
    assert.deepEqual(readFileSync(path), corrupt);
    rmSync(path);
    symlinkSync(f.path, path);
    assert.throws(
      () => prepareCentralGatewayCredential(f.dir, f.vault, f.e, () => {}),
      /Protected/,
    );
  } finally {
    f.clean();
  }
});

test("revocation inside the credential transaction rolls back secret creation", () => {
  const f = fixture();
  try {
    let checks = 0;
    assert.throws(
      () =>
        prepareCentralGatewayCredential(f.dir, f.vault, f.e, () => {
          if (++checks === 3) throw Error("revoked at commit");
        }),
      /revoked at commit/,
    );
    const path = join(f.dir, "native-central-gateway.db"),
      db = new Database(path, { readonly: true });
    assert.equal(
      (db.prepare("SELECT count(*) AS n FROM state").get() as { n: number }).n,
      0,
    );
    db.close();
    const receipt = prepareCentralGatewayCredential(
      f.dir,
      f.vault,
      f.e,
      () => {},
    );
    assert.match(receipt.actorTokenHash, /^[a-f0-9]{64}$/);
  } finally {
    f.clean();
  }
});
