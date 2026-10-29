import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign, createHash } from "node:crypto";
import {
  NativeInitialPairing,
  INITIAL_PAIRING_START,
  INITIAL_PAIRING_POLL,
  INITIAL_PAIRING_AUDIENCE,
  initialPairingMessage,
  initialPairingClaimMessage,
  initialPairingPollMessage,
  pairingDigest,
  verifyInitialPairingRequest,
  verifyInitialPairingPollRequest,
} from "../modules/task-sync/initial-pairing.js";
const pair = () =>
  generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
const signature = (message: string, key: ReturnType<typeof pair>) =>
  sign(null, Buffer.from(message), key.privateKey).toString("base64");
function fixture() {
  const device = pair(),
    roles = pair(),
    identity = {
      principal: "agent:" + randomUUID(),
      publicKey: device.publicKey,
    };
  let at = 100000,
    state: any = null,
    consent: any,
    mode = "pending",
    calls = 0,
    original: any;
  const store = {
    async load() {
      return structuredClone(state);
    },
    async save(value: any) {
      state = structuredClone(value);
    },
  };
  const clientOptions = {
    identity,
    signLocal: async (message: string) => signature(message, device),
    currentConsent: () => consent,
    store,
    rolesPublicKey: roles.publicKey,
    now: () => at,
    transport: async ({ url, method, body }: any): Promise<any> => {
      calls++;
      assert.equal(method, "POST");
      if (url === INITIAL_PAIRING_START) {
        assert.equal(state.phase, "starting");
        verifyInitialPairingRequest(body, at);
        original = body.request;
        if (mode === "lost-start") throw Error("uncertain source outcome");
        return {
          status: "pending",
          pairingId: randomUUID(),
          pollSecret: "a".repeat(64),
          requestDigest: pairingDigest(original),
          reviewUrl: "",
          expiresAt: original.expiresAt,
          permissionsGranted: false,
        };
      }
      assert.equal(url, INITIAL_PAIRING_POLL);
      assert.equal(body.request.principal, identity.principal);
      assert.equal(
        body.signature,
        signature(initialPairingPollMessage(body.request), device),
      );
      verifyInitialPairingPollRequest(
        body,
        original,
        state.challenge.pairingId,
        at,
      );
      if (mode === "pending")
        return {
          status: "pending",
          expiresAt: original.expiresAt,
          permissionsGranted: false,
        };
      const ownerProfile = randomUUID();
      const claim: any = {
        version: 1,
        issuer: "https://roles.bittrees.org",
        audience: INITIAL_PAIRING_AUDIENCE,
        purpose: "metadata-only-owner-pairing",
        pairingId: body.request.pairingId,
        operationId: original.operationId,
        requestDigest: pairingDigest(original),
        pollRequestDigest: pairingDigest(body.request),
        principal: identity.principal,
        keyFingerprint: original.keyFingerprint,
        ownerProfile,
        personPrincipal: "person:" + ownerProfile,
        policyDigest: "b".repeat(64),
        activePerson: true,
        applicableRole: true,
        checkedAt: at,
        expiresAt: at + 4000,
        permissionsGranted: false,
        rolesCredentialId: null,
        runtimeEnrolled: false,
        workspace: null,
        nativeLease: null,
        agentController: null,
      };
      if (mode === "invalid-role") claim.applicableRole = false;
      if (mode === "new-grant") claim.permissionsGranted = true;
      if (mode === "new-workspace") claim.workspace = randomUUID();
      if (mode === "replayed-poll") claim.pollRequestDigest = "c".repeat(64);
      return {
        status: "paired",
        proof: {
          claim,
          signature: signature(initialPairingClaimMessage(claim), roles),
        },
      };
    },
  };
  // Add the exact server-generated review URL; caller cannot substitute a host.
  const transport = clientOptions.transport;
  clientOptions.transport = async (request: any) => {
    const r = await transport(request);
    if (r.status === "pending" && r.pairingId)
      r.reviewUrl =
        "https://roles.bittrees.org/profile?pairingRequest=" + r.pairingId;
    return r;
  };
  const first = new NativeInitialPairing(clientOptions);
  consent = {
    id: randomUUID(),
    principal: identity.principal,
    keyFingerprint: createHash("sha256").update(device.publicKey).digest("hex"),
    expiresAt: at + 300000,
  };
  return {
    client: first,
    clientOptions,
    device,
    roles,
    identity,
    store,
    get state() {
      return state;
    },
    get calls() {
      return calls;
    },
    set mode(v: string) {
      mode = v;
    },
    advance(ms = 5000) {
      at += ms;
    },
    replaceConsent() {
      consent = { ...consent, id: randomUUID() };
    },
    expire() {
      at = consent.expiresAt;
    },
  };
}
test("first pairing starts with native key proof only; requires no existing Roles credential/owner/workspace", async () => {
  const f = fixture(),
    r = await f.client.start();
  assert.equal(r.permissionsGranted, false);
  assert.equal(r.status, "pending");
  assert.equal(Object.hasOwn(r, "pollSecret"), false);
  assert.deepEqual(
    Object.keys(f.state.request).sort(),
    [
      "version",
      "audience",
      "purpose",
      "target",
      "operationId",
      "requestId",
      "principal",
      "publicKey",
      "keyFingerprint",
      "issuedAt",
      "expiresAt",
    ].sort(),
  );
  assert.equal(Object.hasOwn(f.state.request, "profileId"), false);
  assert.equal(Object.hasOwn(f.state.request, "workspace"), false);
  assert.equal(JSON.stringify(f.state).includes(f.device.privateKey), false);
});
test("authenticated source claim binds active applicable person role and returns no execution authority", async () => {
  const f = fixture();
  await f.client.start();
  f.mode = "paired";
  const result = await f.client.poll();
  assert.equal(result.status, "paired");
  assert.equal(result.principal, f.identity.principal);
  assert.equal(result.permissionsGranted, false);
  assert.equal(result.workspace, null);
  assert.equal(result.nativeLease, null);
  assert.equal(result.agentController, null);
  assert.equal(f.state.phase, "paired");
});
test("invalid roles, granted scopes and replayed poll claims never become a paired binding", async () => {
  for (const mode of [
    "invalid-role",
    "new-grant",
    "new-workspace",
    "replayed-poll",
  ]) {
    const f = fixture();
    await f.client.start();
    f.mode = mode;
    await assert.rejects(f.client.poll());
    assert.equal(f.state.phase, "pending");
  }
});
test("unknown start outcome remains durable held; restart cannot generate another operation", async () => {
  const f = fixture();
  f.mode = "lost-start";
  await assert.rejects(f.client.start(), /uncertain/);
  const id = f.state.request.operationId;
  const restarted = new NativeInitialPairing(f.clientOptions);
  await assert.rejects(restarted.start(), /Reconcile/);
  assert.equal(f.calls, 1);
  assert.equal(f.state.request.operationId, id);
  assert.equal(f.state.phase, "held");
});
test("pending pairing survives native restart, limits poll cadence and cannot outlive native consent", async () => {
  const f = fixture();
  await f.client.start();
  const restarted = new NativeInitialPairing(f.clientOptions);
  await restarted.poll();
  await assert.rejects(restarted.poll());
  assert.equal(f.calls, 2);
  f.advance();
  await restarted.poll();
  assert.equal(f.calls, 3);
  f.expire();
  await assert.rejects(restarted.poll());
  assert.equal(f.calls, 3);
});
test("revoked/replaced native consent prevents a source response from being adopted", async () => {
  const f = fixture();
  const send = f.clientOptions.transport;
  f.clientOptions.transport = async (request: any) => {
    const result = await send(request);
    f.replaceConsent();
    return result;
  };
  await assert.rejects(f.client.start());
  assert.equal(f.state.phase, "held");
  assert.equal(f.calls, 1);
});
test("device signature domains and caller supplied authority are rejected", async () => {
  const f = fixture();
  await f.client.start();
  const r = f.state.request;
  for (const extra of [
    { ownerProfile: randomUUID() },
    { workspace: randomUUID() },
    { credential: "bearer" },
    { permissionsGranted: true },
  ])
    assert.throws(() =>
      verifyInitialPairingRequest(
        {
          request: { ...r, ...extra },
          signature: signature(
            initialPairingMessage({ ...r, ...extra }),
            f.device,
          ),
        },
        r.issuedAt,
      ),
    );
  assert.throws(() =>
    verifyInitialPairingRequest(
      {
        request: r,
        signature: signature(initialPairingClaimMessage(r), f.device),
      },
      r.issuedAt,
    ),
  );
});
test("untrusted source key and substituted owner URL do not complete pairing", async () => {
  const f = fixture();
  await f.client.start();
  f.mode = "paired";
  f.clientOptions.rolesPublicKey = pair().publicKey;
  await assert.rejects(f.client.poll());
  assert.equal(f.state.phase, "pending");
  const g = fixture(),
    send = g.clientOptions.transport;
  g.clientOptions.transport = async (r: any) => ({
    ...(await send(r)),
    reviewUrl: "https://attacker.invalid/profile",
  });
  await assert.rejects(g.client.start());
  assert.equal(g.state.phase, "held");
});
test("consent deadline cannot be extended and packets are bounded before signing", async () => {
  const f = fixture();
  await f.client.start();
  const loaded = await f.store.load();
  loaded.request.publicKey += "x".repeat(17000);
  assert.throws(() => initialPairingMessage(loaded.request));
  loaded.calls = NaN;
  await f.store.save(loaded);
  await assert.rejects(f.client.poll());
  assert.equal(f.calls, 1);
});

test("native cancellation during durable acceptance write leaves source outcome held", async () => {
  for (const phase of ["pending", "paired"]) {
    const f = fixture();
    if (phase === "paired") {
      await f.client.start();
      f.mode = "paired";
    }
    const save = f.store.save;
    f.store.save = async (value: any) => {
      await save(value);
      if (value.phase === phase) f.replaceConsent();
    };
    await assert.rejects(
      phase === "pending" ? f.client.start() : f.client.poll(),
    );
    assert.equal(f.state.phase, "held");
  }
});
