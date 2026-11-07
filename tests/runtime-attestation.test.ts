import test from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  createHash,
} from "node:crypto";
import { attestRuntime } from "../modules/coordinator/runtime-attestation.js";
import {
  runtimeEnrollmentMessage,
  runtimeAttestationMessage,
  leaseActivationMessage,
} from "../modules/task-sync/runtime-contract.js";
import { digest } from "../modules/task-sync/proof-contract.js";
import { canonical } from "../modules/contracts/canonical-json.js";
function fixture() {
  const keys = generateKeyPairSync("ed25519"),
    issuer = generateKeyPairSync("ed25519");
  const privateKey = issuer.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const g: any = {
    id: randomUUID(),
    device_id: randomUUID(),
    wallet_address: "0x" + "a".repeat(40),
    signed_at: new Date().toISOString(),
    paused_at: null,
    revoked_at: null,
    approval_expires_at: null,
  };
  const request = {
    version: 1,
    audience: "https://mcp.bittrees.org",
    profileId: randomUUID(),
    principal: "agent:" + randomUUID(),
    publicKey: keys.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    authorityId: g.id,
    deviceId: g.device_id,
    sourceWorkspace: randomUUID(),
    issuedAt: Date.now(),
    nonce: randomUUID(),
  };
  let binding: any;
  const queries: string[] = [];
  const pool: any = {
    connect: async () => ({
      query: async (q: string, args: any[]) => {
        queries.push(q);
        if (q.startsWith("SELECT id,")) return { rows: [g] };
        if (q.startsWith("INSERT INTO workflow_runtime_keys")) {
          binding = {
            principal: args[0],
            authority_id: args[1],
            device_id: args[2],
            public_key: args[3],
            credential_id: args[4],
            source_workspace: args[5],
            owner_wallet: args[6],
          };
          return { rows: [binding] };
        }
        if (q.startsWith("SELECT * FROM workflow_runtime_keys"))
          return { rows: binding ? [binding] : [] };
        return { rows: [] };
      },
      release() {},
    }),
  };
  const body = () => ({
    purpose: "enroll",
    request,
    signature: sign(
      null,
      Buffer.from(runtimeEnrollmentMessage(request)),
      keys.privateKey,
    ).toString("base64"),
  });
  return { pool, g, request, body, privateKey, issuer, keys, queries };
}
test("issuer binds exact device proof and signs server-known registration with a short lifetime", async () => {
  const f = fixture(),
    a = await attestRuntime(f.pool, "b".repeat(64), f.body(), f.privateKey);
  assert.equal(a.request.requestDigest, digest(f.request));
  assert.equal(a.request.ownerWallet, f.g.wallet_address);
  assert.equal(a.request.expiresAt - a.request.issuedAt, 15000);
  assert.ok(
    verify(
      null,
      Buffer.from(runtimeAttestationMessage(a.request)),
      f.issuer.publicKey,
      Buffer.from(a.signature, "base64"),
    ),
  );
  assert.ok(f.queries.includes("COMMIT"));
  const r = {
    version: 1,
    audience: "https://roles.bittrees.org",
    leaseId: randomUUID(),
    policyDigest: "c".repeat(64),
    principal: f.request.principal,
    credentialId: createHash("sha256")
      .update(f.request.publicKey)
      .digest("hex"),
    runtimeBindingDigest: "d".repeat(64),
    issuedAt: Date.now(),
    nonce: randomUUID(),
  };
  const b = {
    purpose: "activate",
    request: r,
    signature: sign(
      null,
      Buffer.from(leaseActivationMessage(r)),
      f.keys.privateKey,
    ).toString("base64"),
  };
  await attestRuntime(f.pool, "b".repeat(64), b, f.privateKey);
  f.g.revoked_at = new Date().toISOString();
  await assert.rejects(
    attestRuntime(f.pool, "b".repeat(64), b, f.privateKey),
    /INACTIVE/,
  );
});
for (const field of [
  "paused_at",
  "revoked_at",
  "approval_expires_at",
  "signed_at",
])
  test("issuer refuses inactive " + field, async () => {
    const f = fixture();
    f.g[field] =
      field === "signed_at" ? null : new Date(Date.now() - 1000).toISOString();
    await assert.rejects(
      attestRuntime(f.pool, "b".repeat(64), f.body(), f.privateKey),
      /INACTIVE/,
    );
    assert.ok(!f.queries.some((q) => q.startsWith("INSERT")));
    assert.ok(f.queries.includes("ROLLBACK"));
  });
test("issuer rejects stale, mismatched, and tampered proofs", async () => {
  const f = fixture();
  f.request.issuedAt -= 16000;
  await assert.rejects(
    attestRuntime(f.pool, "b".repeat(64), f.body(), f.privateKey),
    /STALE/,
  );
  assert.equal(f.queries.length, 0);
  f.request.issuedAt = Date.now();
  f.request.deviceId = randomUUID();
  await assert.rejects(
    attestRuntime(f.pool, "b".repeat(64), f.body(), f.privateKey),
    /MISMATCH/,
  );
  f.request.deviceId = f.g.device_id;
  const body = f.body();
  body.signature = Buffer.alloc(64).toString("base64");
  await assert.rejects(
    attestRuntime(f.pool, "b".repeat(64), body, f.privateKey),
    /REJECTED/,
  );
});

test("assignment decisions attest an existing exact worker without granting execution or inserting keys", async () => {
  const f = fixture();
  await attestRuntime(f.pool, "b".repeat(64), f.body(), f.privateKey);
  const base = {
    version: 1,
    source: "mcp.bittrees.org",
    audience: "https://roles.bittrees.org/api/authority/mcp-decision",
    requestId: randomUUID(),
    operationId: randomUUID(),
    parametersDigest: "a".repeat(64),
    issuedAt: Date.now(),
    principal: f.request.principal,
    credentialId: createHash("sha256")
      .update(f.request.publicKey)
      .digest("hex"),
    delegationId: null,
    leaseId: randomUUID(),
    runtimeBindingDigest: "c".repeat(64),
    tenant: "fixture",
    workspace: "fixture",
    project: "workflow",
    resource: "workflow:fixture",
    action: "workflow:claim",
    stage: "execute",
  };
  const signed = (request: unknown) => ({
    purpose: "decision",
    request,
    signature: sign(
      null,
      Buffer.from("Bittrees MCP authority request v1\n" + canonical(request)),
      f.keys.privateKey,
    ).toString("base64"),
  });
  f.queries.length = 0;
  for (const action of ["workflow:claim", "workflow:complete"]) {
    const request = { ...base, action };
    const result = await attestRuntime(
      f.pool,
      "b".repeat(64),
      signed(request),
      f.privateKey,
    );
    assert.equal(result.request.purpose, "decision");
    assert.equal(result.request.requestDigest, digest(request));
    assert.ok(
      verify(
        null,
        Buffer.from(runtimeAttestationMessage(result.request)),
        f.issuer.publicKey,
        Buffer.from(result.signature, "base64"),
      ),
    );
  }
  assert.equal(
    f.queries.some((q) => q.startsWith("INSERT") || q.startsWith("UPDATE")),
    false,
  );
  for (const change of [
    { action: "workflow:grant" },
    { resource: "crm:all" },
    { stage: "interactive" },
    { project: "crm" },
  ])
    await assert.rejects(
      attestRuntime(
        f.pool,
        "b".repeat(64),
        signed({ ...base, ...change }),
        f.privateKey,
      ),
    );
  f.g.revoked_at = new Date().toISOString();
  await assert.rejects(
    attestRuntime(f.pool, "b".repeat(64), signed(base), f.privateKey),
    /INACTIVE/,
  );
});
