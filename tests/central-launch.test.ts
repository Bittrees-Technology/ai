import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  rm,
  symlink,
  chmod,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  randomBytes,
} from "node:crypto";
import Database from "better-sqlite3";
import { Vault } from "../modules/storage/vault.js";
import {
  savedCentralState,
  existingCentralCredential,
} from "../modules/workflows/central-saved-state.js";
import { launchCentral } from "../apps/companion/central-launch.js";
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
async function fixture() {
  const directory = await realpath(
      await mkdtemp(join(tmpdir(), "native-central-launch-")),
    ),
    vault = new Vault(randomBytes(32)),
    path = join(directory, "central-workflows.db"),
    now = Date.now();
  const pair = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    }),
    identity = {
      ...pair,
      principal: "agent:" + randomUUID(),
      credentialId: hash(pair.publicKey),
    };
  const config = {
    confirmed: true,
    enabled: false,
    tenant: "t",
    workspace: "w",
    connectionId: randomUUID(),
    workflowId: "fixture",
    delegationId: randomUUID(),
    profileId: randomUUID(),
    mcpToken: randomBytes(32).toString("hex"),
  };
  const db = new Database(path);
  db.exec("CREATE TABLE state(key TEXT PRIMARY KEY,value BLOB NOT NULL)");
  for (const [key, value] of Object.entries({ identity, config }))
    db.prepare("INSERT INTO state VALUES(?,?)").run(
      key,
      vault.seal(value, "central-workflows:" + key),
    );
  db.close();
  const state = savedCentralState(path, vault),
    epoch = randomUUID(),
    period = { epoch, approvedAt: now - 1000, expiresAt: now + 60000 };
  const review = {
    ownerWallet: "0x" + "a".repeat(40),
    scope: {
      ...period,
      principal: state.principal,
      publicKey: state.publicKey,
      credentialId: state.credentialId,
      tenant: state.tenant,
      workspace: state.workspace,
      connectionId: state.connectionId,
      workflowId: state.workflowId,
      delegationId: state.delegationId,
    },
    budget: {
      ...period,
      costBasis: "verified-included-usage",
      maximumAttempts: 3,
      maximumMicroUSD: 0,
      attemptCeilingMicroUSD: 0,
      evidenceId: "synthetic-proof",
    },
  };
  const proof = {
    version: 1,
    id: "synthetic-proof",
    observedAt: period.approvedAt,
    validUntil: period.expiresAt,
    account: "synthetic-account",
    project: "synthetic-project",
    plan: "synthetic-included-plan",
    services: [
      "mcp.bittrees.org",
      "roles.bittrees.org",
      "workflow.bittrees.org",
    ],
    resourceClass: "synthetic-resource",
    overageControls: "synthetic-hard-stop",
    costBasis: "verified-included-usage",
    aggregateAttemptCeilingMicroUSD: 0,
    reference: "fixture-only-not-production-evidence",
  };
  const evidence = JSON.stringify(proof),
    approval = {
      version: 1,
      review,
      stateDigest: hash(JSON.stringify(state)),
      credentialDigest: hash(config.mcpToken),
      evidenceDigest: hash(evidence),
      sourceAccessApproved: true,
    };
  await writeFile(join(directory, "native-central-evidence.json"), evidence, {
    mode: 0o600,
  });
  await writeFile(
    join(directory, "native-central.json"),
    JSON.stringify(approval),
    { mode: 0o600 },
  );
  return { directory, vault, path, now, config, approval };
}
test("central state reader preserves existing data and returns only public bindings", async () => {
  const f = await fixture();
  try {
    const before = hash(await readFile(f.path)),
      state = savedCentralState(f.path, f.vault);
    assert.equal(hash(await readFile(f.path)), before);
    assert.equal(state.mcpCredentialDigest, hash(f.config.mcpToken));
    assert.equal(existingCentralCredential(f.path, f.vault), f.config.mcpToken);
    assert.equal(JSON.stringify(state).includes("PRIVATE KEY"), false);
    assert.equal(JSON.stringify(state).includes(f.config.mcpToken), false);
    assert.throws(() => savedCentralState(f.path, new Vault(randomBytes(32))));
    const link = join(f.directory, "state-link.db");
    await symlink(f.path, link);
    assert.throws(() => savedCentralState(link, f.vault));
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
test("missing, expired or unprotected central configuration never invokes Keychain", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "central-missing-")));
  let unlocks = 0;
  const unlock = async () => {
    unlocks++;
    throw Error("must not unlock");
  };
  try {
    assert.equal(await launchCentral(dir, unlock), null);
    assert.equal(unlocks, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const f = await fixture();
  try {
    await assert.rejects(
      launchCentral(f.directory, unlock, () => f.now + 120000),
    );
    assert.equal(unlocks, 0);
    await chmod(join(f.directory, "native-central.json"), 0o644);
    await assert.rejects(launchCentral(f.directory, unlock, () => f.now));
    assert.equal(unlocks, 0);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
test("central launcher binds current evidence and saved credentials before exposing isolated controls", async () => {
  const f = await fixture();
  let unlocks = 0;
  try {
    const launched = await launchCentral(
      f.directory,
      async () => {
        unlocks++;
        return f.vault;
      },
      () => f.now,
    );
    assert.ok(launched);
    assert.equal(unlocks, 1);
    try {
      const env = launched.environment;
      assert.notEqual(
        env.BITTREES_CENTRAL_CONTROL_TOKEN,
        env.BITTREES_CENTRAL_HELPER_TOKEN,
      );
      const post = (url: string, token: string, body: unknown) =>
        fetch(url, {
          method: "POST",
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      const proposal = await (
        await post(
          env.BITTREES_CENTRAL_CONTROL_URL,
          env.BITTREES_CENTRAL_CONTROL_TOKEN,
          { action: "propose" },
        )
      ).json();
      assert.equal(
        proposal.review.scope.principal,
        f.approval.review.scope.principal,
      );
      const denied = await post(
        env.BITTREES_CENTRAL_CONTROL_URL,
        env.BITTREES_CENTRAL_HELPER_TOKEN,
        { action: "approve", digest: proposal.digest },
      );
      assert.equal(denied.status, 403);
      await denied.body?.cancel();
      // No execute is sent: this fixture must not contact a real source.
      const approved = await post(
        env.BITTREES_CENTRAL_CONTROL_URL,
        env.BITTREES_CENTRAL_CONTROL_TOKEN,
        { action: "approve", digest: proposal.digest },
      );
      assert.equal((await approved.json()).approved, true);
      await writeFile(join(f.directory, "native-central-evidence.json"), "{}", {
        mode: 0o600,
      });
      const held = await post(
        env.BITTREES_CENTRAL_HELPER_URL,
        env.BITTREES_CENTRAL_HELPER_TOKEN,
        {},
      );
      assert.equal(held.status, 403);
      await held.body?.cancel();
    } finally {
      await launched.service.close();
    }
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
test("central launcher rejects changed identity or credential binding without creating a grant", async () => {
  for (const field of ["stateDigest", "credentialDigest"] as const) {
    const f = await fixture();
    try {
      f.approval[field] = "f".repeat(64);
      await writeFile(
        join(f.directory, "native-central.json"),
        JSON.stringify(f.approval),
        { mode: 0o600 },
      );
      await assert.rejects(
        launchCentral(
          f.directory,
          async () => f.vault,
          () => f.now,
        ),
      );
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});

test("saved central identity refuses missing state or a mismatched private key without replacing keys", async () => {
  const f = await fixture();
  try {
    const missing = join(f.directory, "missing.db");
    assert.throws(() => savedCentralState(missing, f.vault));
    await assert.rejects(access(missing));
    const db = new Database(f.path);
    try {
      const row = db
        .prepare("SELECT value FROM state WHERE key='identity'")
        .get() as { value: Buffer };
      const identity = f.vault.open<any>(
        row.value,
        "central-workflows:identity",
      );
      identity.privateKey = generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      }).privateKey;
      db.prepare("UPDATE state SET value=? WHERE key='identity'").run(
        f.vault.seal(identity, "central-workflows:identity"),
      );
    } finally {
      db.close();
    }
    const before = hash(await readFile(f.path));
    assert.throws(() => savedCentralState(f.path, f.vault), /inconsistent/);
    assert.equal(hash(await readFile(f.path)), before);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
