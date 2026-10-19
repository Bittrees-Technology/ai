import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  validateEnrollmentStart,
  validateEnrollmentPoll,
} from "../modules/task-sync/enrollment-response.js";
const now = 100000;
const review = {
  epoch: "fixture",
  expiresAt: 400000,
  authorityId: randomUUID(),
  deviceId: randomUUID(),
  sourceWorkspace: randomUUID(),
  principal: "agent:" + randomUUID(),
  publicKey: "fixture",
  ownerWallet: "0x" + "a".repeat(40),
};
const id = randomUUID();
const start = {
  id,
  pollSecret: "a".repeat(64),
  reviewUrl: "https://roles.bittrees.org/profile?runtimeRequest=" + id,
  expiresAt: new Date(400000).toISOString(),
};
const request = {
  version: 1,
  audience: "https://mcp.bittrees.org",
  profileId: randomUUID(),
  principal: review.principal,
  publicKey: review.publicKey,
  authorityId: review.authorityId,
  deviceId: review.deviceId,
  sourceWorkspace: review.sourceWorkspace,
  issuedAt: now,
  nonce: randomUUID(),
};
test("start accepts exact Roles owner URL and refuses alternative destinations", () => {
  assert.deepEqual(validateEnrollmentStart(start, review, now), start);
  for (const reviewUrl of [
    start.reviewUrl + "&next=https://example.com",
    start.reviewUrl.replace("roles.", "evil."),
    start.reviewUrl.replace("https:", "http:"),
  ])
    assert.throws(() =>
      validateEnrollmentStart({ ...start, reviewUrl }, review, now),
    );
});
test("owner response cannot extend review, expire, or add authority fields", () => {
  for (const end of [now, 400001])
    assert.throws(() =>
      validateEnrollmentStart(
        { ...start, expiresAt: new Date(end).toISOString() },
        review,
        now,
      ),
    );
  assert.throws(() =>
    validateEnrollmentStart(
      { ...start, permissionsGranted: true },
      review,
      now,
    ),
  );
});
test("pending and approved challenges preserve exact reviewed device", () => {
  const pending = { status: "pending", expiresAt: start.expiresAt };
  assert.deepEqual(validateEnrollmentPoll(pending, review, now), pending);
  const approved = { status: "approved", expiresAt: start.expiresAt, request };
  assert.deepEqual(validateEnrollmentPoll(approved, review, now), approved);
  for (const key of [
    "authorityId",
    "deviceId",
    "sourceWorkspace",
    "principal",
    "publicKey",
  ]) {
    assert.throws(() =>
      validateEnrollmentPoll(
        { ...approved, request: { ...request, [key]: "changed" } },
        review,
        now,
      ),
    );
  }
  assert.throws(() =>
    validateEnrollmentPoll(
      { ...approved, request: { ...request, issuedAt: 1 } },
      review,
      now,
    ),
  );
});
test("completion is not accepted as an enrollment challenge or permission", () => {
  assert.throws(() =>
    validateEnrollmentPoll(
      { status: "complete", result: { permissionsGranted: true } },
      review,
      now,
    ),
  );
});

test("completion and signed attestation bind exact device without granting permissions", async () => {
  const { generateKeyPairSync, createHash, sign } = await import("node:crypto");
  const { canonical } = await import("../modules/contracts/canonical-json.js");
  const { runtimeAttestationMessage } =
    await import("../modules/task-sync/runtime-contract.js");
  const { validateEnrollmentComplete, validateEnrollmentAttestation } =
    await import("../modules/task-sync/enrollment-response.js");
  const hash = (v: unknown) =>
    createHash("sha256").update(canonical(v)).digest("hex");
  const device = generateKeyPairSync("ed25519"),
    signer = generateKeyPairSync("ed25519"),
    other = generateKeyPairSync("ed25519");
  const publicKey = device.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const r = { ...review, publicKey };
  const c = { ...request, publicKey };
  const reviewed = { ...r, enrollmentRequestDigest: hash(c) };
  const credentialId = createHash("sha256").update(publicKey).digest("hex");
  const binding = {
    version: 1,
    ownerProfileId: c.profileId,
    ownerWallet: r.ownerWallet,
    authorityId: r.authorityId,
    deviceId: r.deviceId,
    principal: r.principal,
    credentialId,
    sourceWorkspace: r.sourceWorkspace,
    tenant: "roles:" + c.profileId,
    workspace: "crm:" + r.sourceWorkspace,
  };
  const complete = {
    status: "complete",
    result: {
      principal: r.principal,
      credentialId,
      publicKey,
      binding,
      runtimeBindingDigest: hash(binding),
      permissionsGranted: false,
    },
  };
  assert.deepEqual(
    validateEnrollmentComplete(complete, reviewed, c, now),
    complete,
  );
  assert.throws(() =>
    validateEnrollmentComplete(
      { ...complete, result: { ...complete.result, permissionsGranted: true } },
      reviewed,
      c,
      now,
    ),
  );
  assert.throws(() =>
    validateEnrollmentComplete(
      {
        ...complete,
        result: {
          ...complete.result,
          binding: { ...binding, ownerProfileId: randomUUID() },
        },
      },
      reviewed,
      c,
      now,
    ),
  );
  const a = {
    version: 1,
    issuer: "https://ai.bittrees.org",
    audience: "https://roles.bittrees.org",
    purpose: "enroll",
    requestDigest: hash(c),
    authorityId: r.authorityId,
    deviceId: r.deviceId,
    ownerWallet: r.ownerWallet,
    principal: r.principal,
    credentialId,
    sourceWorkspace: r.sourceWorkspace,
    issuedAt: now,
    expiresAt: now + 30000,
    nonce: randomUUID(),
  };
  const pem = signer.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const envelope = {
    request: a,
    signature: sign(
      null,
      Buffer.from(runtimeAttestationMessage(a)),
      signer.privateKey,
    ).toString("base64"),
  };
  assert.deepEqual(
    validateEnrollmentAttestation(envelope, reviewed, c, pem, now),
    envelope,
  );
  assert.throws(() =>
    validateEnrollmentAttestation(
      envelope,
      reviewed,
      c,
      other.publicKey.export({ type: "spki", format: "pem" }).toString(),
      now,
    ),
  );
  for (const change of [
    { purpose: "activate" },
    { deviceId: randomUUID() },
    { expiresAt: now + 30001 },
    { credentialId: "f".repeat(64) },
  ]) {
    const altered = { ...a, ...change };
    const signed = {
      request: altered,
      signature: sign(
        null,
        Buffer.from(runtimeAttestationMessage(altered)),
        signer.privateKey,
      ).toString("base64"),
    };
    assert.throws(() =>
      validateEnrollmentAttestation(signed, reviewed, c, pem, now),
    );
  }
});
