import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createPublicKey, verify } from "node:crypto";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../modules/storage/vault.js";
import {
  initializeNativeWorkflowIdentity,
  readNativeWorkflowIdentity,
} from "../modules/task-sync/native-identity-review.js";
import { signNativeInitialPairingMessage } from "../modules/task-sync/initial-pairing-signer.js";
import {
  INITIAL_PAIRING_START,
  INITIAL_PAIRING_POLL,
  initialPairingMessage,
  initialPairingPollMessage,
  pairingDigest,
} from "../modules/task-sync/initial-pairing.js";
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "bittrees-initial-signer-")),
    path = join(folder, "task-sync.db"),
    vault = new Vault(randomBytes(32));
  initializeNativeWorkflowIdentity(path, vault, () => true);
  const identity = readNativeWorkflowIdentity(path, vault);
  assert.equal(identity.status, "existing");
  if (identity.status !== "existing") throw Error("fixture");
  const now = Date.now(),
    consent = {
      id: randomUUID(),
      principal: identity.principal,
      keyFingerprint: identity.credentialId,
      expiresAt: now + 60000,
    };
  const request = {
    version: 1,
    audience: INITIAL_PAIRING_START,
    purpose: "metadata-only-owner-pairing",
    target: "Bittrees local AI on this Mac",
    operationId: randomUUID(),
    requestId: randomUUID(),
    principal: identity.principal,
    publicKey: identity.publicKey,
    keyFingerprint: identity.credentialId,
    issuedAt: now,
    expiresAt: consent.expiresAt,
  };
  return {
    path,
    folder,
    vault,
    identity,
    consent,
    request,
    close: () => rmSync(folder, { recursive: true }),
  };
}
test("existing native key signs only canonical initial domains without saved workspace or credential", () => {
  const f = fixture();
  try {
    assert.equal(f.identity.sourceWorkspace, null);
    const start = initialPairingMessage(f.request),
      sig = signNativeInitialPairingMessage(
        f.path,
        f.vault,
        () => f.consent,
        start,
      );
    assert.equal(
      verify(
        null,
        Buffer.from(start),
        createPublicKey(f.identity.publicKey),
        Buffer.from(sig, "base64"),
      ),
      true,
    );
    const poll = initialPairingPollMessage({
      version: 1,
      audience: INITIAL_PAIRING_POLL,
      pairingId: randomUUID(),
      pollSecret: "a".repeat(64),
      operationId: f.request.operationId,
      principal: f.identity.principal,
      keyFingerprint: f.identity.credentialId,
      requestDigest: pairingDigest(f.request),
      issuedAt: Date.now(),
      nonce: randomUUID(),
    });
    assert.ok(
      signNativeInitialPairingMessage(f.path, f.vault, () => f.consent, poll),
    );
  } finally {
    f.close();
  }
});
test("generic source actions, authority fields, different identity and extended consent cannot be signed", () => {
  const f = fixture();
  try {
    for (const text of [
      "Bittrees MCP request v1\n{}",
      initialPairingMessage({ ...f.request, workspace: randomUUID() }),
      initialPairingMessage({
        ...f.request,
        principal: "agent:" + randomUUID(),
      }),
      initialPairingMessage({
        ...f.request,
        expiresAt: f.consent.expiresAt + 1,
      }),
    ])
      assert.throws(() =>
        signNativeInitialPairingMessage(f.path, f.vault, () => f.consent, text),
      );
    assert.throws(() =>
      signNativeInitialPairingMessage(
        f.path,
        f.vault,
        () => ({ ...f.consent, keyFingerprint: "c".repeat(64) }),
        initialPairingMessage({ ...f.request, keyFingerprint: "c".repeat(64) }),
      ),
    );
  } finally {
    f.close();
  }
});
test("missing key and revoked native consent fail without initialization or private key export", () => {
  const f = fixture();
  try {
    const missing = join(f.folder, "missing.db");
    assert.throws(() =>
      signNativeInitialPairingMessage(
        missing,
        f.vault,
        () => f.consent,
        initialPairingMessage(f.request),
      ),
    );
    assert.equal(existsSync(missing), false);
    let calls = 0;
    assert.throws(
      () =>
        signNativeInitialPairingMessage(
          f.path,
          f.vault,
          () => (++calls === 1 ? f.consent : null),
          initialPairingMessage(f.request),
        ),
      /revoked/,
    );
    assert.throws(
      () =>
        signNativeInitialPairingMessage(
          f.path,
          f.vault,
          () => null,
          initialPairingMessage(f.request),
        ),
      /consent/,
    );
  } finally {
    f.close();
  }
});
