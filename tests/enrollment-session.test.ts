import type { EnrollmentReview } from "../modules/task-sync/enrollment-transport-plan.js";
import { EnrollmentOwner } from "../modules/task-sync/enrollment-owner.js";
import { EnrollmentClient } from "../modules/task-sync/enrollment-client.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Vault } from "../modules/storage/vault.js";
import { EnrollmentSession } from "../modules/task-sync/enrollment-session.js";
test("assembled session persists owner response and rejects restart replay or changed review", async () => {
  const dir = mkdtempSync(tmpdir() + "/enroll-session-"),
    vault = new Vault(randomBytes(32));
  const key = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
  const review = {
    epoch: randomUUID(),
    expiresAt: 400000,
    authorityId: randomUUID(),
    deviceId: randomUUID(),
    sourceWorkspace: randomUUID(),
    principal: "agent:" + randomUUID(),
    publicKey: key,
    ownerWallet: "0x" + "a".repeat(40),
  };
  const request = {
    operation: "start",
    request: {
      version: 1,
      audience: "https://mcp.bittrees.org",
      kind: "enroll",
      authorityId: review.authorityId,
      deviceId: review.deviceId,
      sourceWorkspace: review.sourceWorkspace,
      principal: review.principal,
      publicKey: key,
      ownerWallet: review.ownerWallet,
      issuedAt: 100000,
      nonce: randomUUID(),
    },
    signature: "synthetic",
  };
  const id = randomUUID(),
    secret = "b".repeat(64);
  let calls = 0;
  const dispatch = async (plan: any) => {
    calls++;
    return new TextEncoder().encode(
      JSON.stringify(
        plan.url.endsWith("/start")
          ? {
              id,
              pollSecret: secret,
              reviewUrl:
                "https://roles.bittrees.org/profile?runtimeRequest=" + id,
              expiresAt: new Date(400000).toISOString(),
            }
          : { status: "pending", expiresAt: new Date(400000).toISOString() },
      ),
    );
  };
  let session = new EnrollmentSession(
    dir + "/state.db",
    vault,
    () => review,
    dispatch,
    key,
    () => 100000,
  );
  try {
    await session.execute(request, new AbortController().signal);
    session.close();
    session = new EnrollmentSession(
      dir + "/state.db",
      vault,
      () => review,
      dispatch,
      key,
      () => 100000,
    );
    await assert.rejects(
      session.execute(request, new AbortController().signal),
      /reconciliation/,
    );
    await session.execute(
      { operation: "poll", id, pollSecret: secret },
      new AbortController().signal,
    );
    assert.equal(calls, 2);
    assert.throws(
      () =>
        new EnrollmentSession(
          dir + "/state.db",
          vault,
          () => ({ ...review, deviceId: randomUUID() }),
          dispatch,
          key,
          () => 100000,
        ),
      /owner already present/,
    );
  } finally {
    session.close();
    rmSync(dir, { recursive: true });
  }
});

for (const transport of ["direct", "native-loopback"])
  test(
    transport +
      " assembled signed enrollment completes without permission and rejects revoked replay",
    async () => {
      const { createHash, sign } = await import("node:crypto");
      const { canonical } =
        await import("../modules/contracts/canonical-json.js");
      const { runtimeAttestationMessage } =
        await import("../modules/task-sync/runtime-contract.js");
      const hash = (v: unknown) =>
        createHash("sha256").update(canonical(v)).digest("hex");
      const dir = mkdtempSync(tmpdir() + "/enroll-complete-"),
        vault = new Vault(randomBytes(32));
      const device = generateKeyPairSync("ed25519"),
        signer = generateKeyPairSync("ed25519");
      const publicKey = device.publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
        signerPem = signer.publicKey
          .export({ type: "spki", format: "pem" })
          .toString();
      const review = {
        epoch: randomUUID(),
        expiresAt: 400000,
        authorityId: randomUUID(),
        deviceId: randomUUID(),
        sourceWorkspace: randomUUID(),
        principal: "agent:" + randomUUID(),
        publicKey,
        ownerWallet: "0x" + "a".repeat(40),
      };
      let allowed = true;
      const candidate = {
        version: 1,
        audience: "https://mcp.bittrees.org",
        kind: "enroll",
        authorityId: review.authorityId,
        deviceId: review.deviceId,
        sourceWorkspace: review.sourceWorkspace,
        principal: review.principal,
        publicKey,
        ownerWallet: review.ownerWallet,
        issuedAt: 100000,
        nonce: randomUUID(),
      };
      const { kind, ownerWallet, ...identity } = candidate;
      const challenge = { ...identity, profileId: randomUUID() };
      const credentialId = createHash("sha256").update(publicKey).digest("hex");
      const a = {
        version: 1,
        issuer: "https://ai.bittrees.org",
        audience: "https://roles.bittrees.org",
        purpose: "enroll",
        requestDigest: hash(challenge),
        authorityId: review.authorityId,
        deviceId: review.deviceId,
        ownerWallet,
        principal: review.principal,
        credentialId,
        sourceWorkspace: review.sourceWorkspace,
        issuedAt: 100000,
        expiresAt: 130000,
        nonce: randomUUID(),
      };
      const attestation = {
        request: a,
        signature: sign(
          null,
          Buffer.from(runtimeAttestationMessage(a)),
          signer.privateKey,
        ).toString("base64"),
      };
      const binding = {
        version: 1,
        ownerProfileId: challenge.profileId,
        ownerWallet,
        authorityId: review.authorityId,
        deviceId: review.deviceId,
        principal: review.principal,
        credentialId,
        sourceWorkspace: review.sourceWorkspace,
        tenant: "roles:" + challenge.profileId,
        workspace: "crm:" + review.sourceWorkspace,
      };
      const completed = {
        status: "complete",
        result: {
          principal: review.principal,
          credentialId,
          publicKey,
          binding,
          runtimeBindingDigest: hash(binding),
          permissionsGranted: false,
        },
      };
      const id = randomUUID(),
        pollSecret = "c".repeat(64);
      const urls: string[] = [];
      const dispatch = async (plan: any) => {
        urls.push(plan.url);
        const response = plan.url.endsWith("/start")
          ? {
              id,
              pollSecret,
              reviewUrl:
                "https://roles.bittrees.org/profile?runtimeRequest=" + id,
              expiresAt: new Date(400000).toISOString(),
            }
          : plan.url.endsWith("/poll")
            ? {
                status: "approved",
                request: challenge,
                expiresAt: new Date(400000).toISOString(),
              }
            : plan.url.endsWith("/complete")
              ? completed
              : attestation;
        return new TextEncoder().encode(JSON.stringify(response));
      };
      const makeSession = (current: () => EnrollmentReview | null) =>
        new EnrollmentSession(
          dir + "/state.db",
          vault,
          current,
          dispatch,
          signerPem,
          () => 100000,
        );
      const current = () => (allowed ? review : null);
      const owner =
        transport === "native-loopback"
          ? new EnrollmentOwner(
              review,
              current,
              "f".repeat(64),
              makeSession,
              () => 100000,
            )
          : null;
      const session = owner
        ? new EnrollmentClient(await owner.listen(), "f".repeat(64))
        : makeSession(current);
      try {
        const signal = new AbortController().signal;
        await session.execute(
          {
            operation: "start",
            request: candidate,
            signature: "synthetic-device",
          },
          signal,
        );
        await session.execute({ operation: "poll", id, pollSecret }, signal);
        assert.deepEqual(
          await session.execute(
            {
              operation: "attest",
              request: challenge,
              signature: "synthetic-device",
            },
            signal,
          ),
          attestation,
        );
        const complete = {
          operation: "complete",
          id,
          pollSecret,
          proof: {
            request: challenge,
            signature: "synthetic-device",
            attestation,
          },
        };
        assert.deepEqual(await session.execute(complete, signal), completed);
        assert.equal(urls.length, 4);
        allowed = false;
        await assert.rejects(session.execute(complete, signal));
        assert.equal(urls.length, 4);
      } finally {
        if (owner) await owner.close();
        else (session as EnrollmentSession).close();
        rmSync(dir, { recursive: true });
      }
    },
  );

test("reopening a session cannot reset the persistent request budget", async () => {
  const dir = mkdtempSync(tmpdir() + "/enroll-budget-"),
    vault = new Vault(randomBytes(32));
  const review = {
    epoch: randomUUID(),
    expiresAt: 400000,
    authorityId: randomUUID(),
    deviceId: randomUUID(),
    sourceWorkspace: randomUUID(),
    principal: "agent:" + randomUUID(),
    publicKey: "fixture",
    ownerWallet: "0x" + "a".repeat(40),
  };
  const heartbeat = {
    grant: {
      id: review.authorityId,
      wallet_address: review.ownerWallet,
      device_label: "Mac",
      device_id: review.deviceId,
      model_label: "local",
      paused_at: null,
      revoked_at: null,
      signed_at: new Date(50000).toISOString(),
      require_wallet: true,
      approval_expires_at: null,
      last_seen_at: null,
    },
    activity: [],
    runs: [],
    approvalUrl: "https://ai.bittrees.org/workflows",
  };
  let calls = 0;
  const dispatch = async () => {
    calls++;
    return new TextEncoder().encode(JSON.stringify(heartbeat));
  };
  const open = () =>
    new EnrollmentSession(
      dir + "/state.db",
      vault,
      () => review,
      dispatch,
      "unused",
      () => 100000,
    );
  let session = open();
  try {
    for (let i = 0; i < 60; i++)
      await session.execute(
        { operation: "heartbeat" },
        new AbortController().signal,
      );
    session.close();
    session = open();
    for (let i = 0; i < 48; i++)
      await session.execute(
        { operation: "heartbeat" },
        new AbortController().signal,
      );
    await assert.rejects(
      session.execute({ operation: "heartbeat" }, new AbortController().signal),
      /Persisted.*limit/,
    );
    assert.equal(calls, 108);
  } finally {
    session.close();
    rmSync(dir, { recursive: true });
  }
});
