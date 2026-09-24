import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { browserReplayCoverageMatches } from "../modules/remote/browser-key-lifecycle.js";
import {
  createBrowserKeyMaterial,
  browserRecoveryKey,
  newBrowserRecoveryCode,
  openBrowserKeyRecovery,
} from "../modules/remote/browser-key-recovery.js";

test("Browser transaction prerequisite binds provenance to the current owner, scope, registration and active proof", async () => {
  const now = 1800000000000,
    scope = "a".repeat(64),
    localOwner = "synthetic:alice";
  const binding = {
    ownerId: randomUUID(),
    deviceId: randomUUID(),
    credentialEpoch: 1,
    expiresAt: now + 60000,
  };
  const identity = { localOwner, binding, keyId: randomUUID(), keyEpoch: 1 };
  const recoveryKey = await browserRecoveryKey(newBrowserRecoveryCode());
  const material = await createBrowserKeyMaterial(identity, recoveryKey);
  const record = {
    scope,
    keyId: identity.keyId,
    identity,
    state: "ready",
    publicKey: material.publicKey,
    privateHandle: material.pair.privateKey,
    publicHandle: material.pair.publicKey,
    recovery: material.recovery,
    incomingReplayBoundary: "from-generation-v1",
  };
  const proof = {
    revision: 2,
    keyId: identity.keyId,
    keyEpoch: 1,
    binding,
    publicKey: material.publicKey,
  };
  const state = {
    scope,
    revision: 2,
    ownerId: binding.ownerId,
    deviceId: binding.deviceId,
    locked: false,
    slots: [
      {
        id: identity.keyId,
        keyEpoch: 1,
        binding,
        createdAt: now,
        state: "active",
        publicKey: material.publicKey,
      },
    ],
  };
  const authority = { localOwner, scope, binding, now };
  assert.equal(
    browserReplayCoverageMatches(state, record, proof, authority),
    true,
  );
  for (const a of [
    { ...authority, localOwner: "synthetic:bob" },
    { ...authority, scope: "b".repeat(64) },
    { ...authority, now: binding.expiresAt },
    { ...authority, binding: { ...binding, deviceId: randomUUID() } },
    { ...authority, binding: { ...binding, credentialEpoch: 2 } },
  ])
    assert.equal(browserReplayCoverageMatches(state, record, proof, a), false);
  for (const s of [
    null,
    { ...state, revision: 3 },
    { ...state, locked: true },
    { ...state, slots: [{ ...state.slots[0], state: "retired" }] },
  ])
    assert.equal(
      browserReplayCoverageMatches(s, record, proof, authority),
      false,
    );
  for (const r of [
    undefined,
    { ...record, incomingReplayBoundary: undefined },
    { ...record, incomingReplayBoundary: "unknown" },
    { ...record, recovery: null },
    { ...record, identity: { ...identity, localOwner: "synthetic:bob" } },
    { ...record, identity: { ...identity, keyEpoch: 2 } },
    { ...record, state: "deleted" },
  ])
    assert.equal(
      browserReplayCoverageMatches(state, r, proof, authority),
      false,
    );
  const recovered = await openBrowserKeyRecovery(
    material.recovery,
    recoveryKey,
  );
  assert.equal(recovered.publicKey, proof.publicKey);
  assert.equal("incomingReplayBoundary" in recovered, false);
  assert.equal(
    browserReplayCoverageMatches(
      state,
      { ...record, incomingReplayBoundary: undefined },
      proof,
      authority,
    ),
    false,
  );
});
