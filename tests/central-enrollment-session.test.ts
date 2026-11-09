import test from "node:test";
import assert from "node:assert/strict";
import {
  randomBytes,
  randomUUID,
  generateKeyPairSync,
  createHash,
  sign,
  verify,
} from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtempSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Vault } from "../modules/storage/vault.js";
import { canonical } from "../modules/contracts/canonical-json.js";
import {
  runtimeHandoffMessage,
  runtimeEnrollmentMessage,
  runtimeAttestationMessage,
  runtimeReconciliationMessage,
} from "../modules/task-sync/runtime-contract.js";
import { enrollmentOperationId } from "../modules/task-sync/enrollment-journal.js";
import { nativeCentralEnrollmentSessionFactory } from "../modules/workflows/central-enrollment-session.js";
const hash = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
function fixture() {
  const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "central-native-enrollment-")),
    ),
    vault = new Vault(randomBytes(32));
  const key = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const attester = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const saved = {
    ...key,
    principal: "agent:" + randomUUID(),
    credentialId: createHash("sha256").update(key.publicKey).digest("hex"),
  };
  const central = join(directory, "central-workflows.db"),
    path = join(directory, "native-central-enrollment.db");
  const db = new Database(central);
  db.exec("CREATE TABLE state(key TEXT PRIMARY KEY,value BLOB NOT NULL)");
  db.prepare("INSERT INTO state VALUES('identity',?)").run(
    vault.seal(saved, "central-workflows:identity"),
  );
  db.close();
  let time = Date.now(),
    allowed = true,
    dropStart = false,
    dropComplete = false,
    preventCommit = false,
    wrongSettlement = false,
    committed = false,
    revokeOnPoll = false,
    sourceRevoked = false;
  let review = {
    epoch: randomUUID(),
    expiresAt: time + 120000,
    principal: saved.principal,
    publicKey: saved.publicKey,
    authorityId: randomUUID(),
    deviceId: randomUUID(),
    sourceWorkspace: randomUUID(),
    ownerWallet: "0x" + "a".repeat(40),
  };
  const requestId = randomUUID(),
    pollSecret = randomBytes(32).toString("hex"),
    profileId = randomUUID();
  let challenge: any, result: any, candidateDigest: string, rolesExpiry: string;
  const originalEpoch = review.epoch;
  const seal = vault.seal.bind(vault);
  let failSave = false,
    handoffWrites = 0;
  vault.seal = (value, aad) => {
    if (
      aad.startsWith("central-native-handoff:") &&
      ++handoffWrites === 3 &&
      failSave
    ) {
      failSave = false;
      throw Error(
        "Fixture local handoff save interrupted after verified source reply",
      );
    }
    return seal(value, aad);
  };
  const counts = {
    heartbeat: 0,
    start: 0,
    poll: 0,
    attest: 0,
    complete: 0,
    reconcile: 0,
    reservations: 0,
  };
  const send = ((url: URL, options: any, callback: any) => {
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.servername, url.hostname);
    const req = new EventEmitter() as any;
    req.end = (bytes: string) =>
      queueMicrotask(() => {
        try {
          const body = JSON.parse(bytes);
          let response: unknown;
          if (url.hostname === "ai.bittrees.org") {
            if (body.action === "device") {
              counts.heartbeat++;
              assert.deepEqual(body.input, { action: "heartbeat" });
              response = {
                grant: {
                  id: review.authorityId,
                  wallet_address: review.ownerWallet,
                  device_label: "synthetic Mac",
                  device_id: review.deviceId,
                  model_label: "synthetic local model",
                  paused_at: null,
                  revoked_at: sourceRevoked
                    ? new Date(time).toISOString()
                    : null,
                  signed_at: new Date(time - 1000).toISOString(),
                  require_wallet: true,
                  approval_expires_at: null,
                  last_seen_at: new Date(time).toISOString(),
                },
                activity: [],
                runs: [],
                approvalUrl: "https://ai.bittrees.org/workflows",
              };
            } else {
              counts.attest++;
              assert.equal(body.action, "runtime-attestation");
              assert.equal(body.input.purpose, "enroll");
              assert.equal(
                options.headers.Authorization,
                "Bearer " + "a".repeat(64),
              );
              assert.equal(
                verify(
                  null,
                  Buffer.from(runtimeEnrollmentMessage(body.input.request)),
                  key.publicKey,
                  Buffer.from(body.input.signature, "base64"),
                ),
                true,
              );
              const request = {
                version: 1,
                issuer: "https://ai.bittrees.org",
                audience: "https://roles.bittrees.org",
                purpose: "enroll",
                requestDigest: hash(body.input.request),
                authorityId: review.authorityId,
                deviceId: review.deviceId,
                ownerWallet: review.ownerWallet,
                principal: saved.principal,
                credentialId: saved.credentialId,
                sourceWorkspace: review.sourceWorkspace,
                issuedAt: time,
                expiresAt: time + 15000,
                nonce: randomUUID(),
              };
              response = {
                request,
                signature: sign(
                  null,
                  Buffer.from(runtimeAttestationMessage(request)),
                  attester.privateKey,
                ).toString("base64"),
              };
            }
          } else {
            assert.equal(url.hostname, "roles.bittrees.org");
            assert.equal(options.headers.Authorization, undefined);
            const action = url.pathname.split("/").at(-1);
            if (action === "start") {
              counts.start++;
              assert.equal(counts.start, 1);
              assert.equal(body.request.principal, saved.principal);
              assert.equal(
                verify(
                  null,
                  Buffer.from(runtimeHandoffMessage(body.request)),
                  key.publicKey,
                  Buffer.from(body.signature, "base64"),
                ),
                true,
              );
              candidateDigest = hash(body.request);
              rolesExpiry = new Date(time + 60000).toISOString();
              response = {
                id: requestId,
                pollSecret,
                reviewUrl:
                  "https://roles.bittrees.org/profile?runtimeRequest=" +
                  requestId,
                expiresAt: rolesExpiry,
              };
              if (dropStart) {
                req.emit(
                  "error",
                  Error("Fixture start reply lost after source commit"),
                );
                return;
              }
            } else if (action === "poll") {
              counts.poll++;
              assert.equal(body.id, requestId);
              assert.equal(body.pollSecret, pollSecret);
              if (committed) response = { status: "complete", result };
              else {
                challenge = {
                  version: 1,
                  audience: "https://mcp.bittrees.org",
                  profileId,
                  principal: saved.principal,
                  publicKey: saved.publicKey,
                  authorityId: review.authorityId,
                  deviceId: review.deviceId,
                  sourceWorkspace: review.sourceWorkspace,
                  issuedAt: time,
                  nonce: randomUUID(),
                };
                response = {
                  status: "approved",
                  expiresAt: new Date(time + 60000).toISOString(),
                  request: challenge,
                };
              }
              if (revokeOnPoll) allowed = false;
            } else if (action === "complete") {
              counts.complete++;
              assert.equal(counts.complete, 1);
              assert.equal(body.id, requestId);
              assert.equal(body.pollSecret, pollSecret);
              assert.deepEqual(body.proof.request, challenge);
              const binding = {
                version: 1,
                ownerProfileId: profileId,
                ownerWallet: review.ownerWallet,
                authorityId: review.authorityId,
                deviceId: review.deviceId,
                principal: saved.principal,
                credentialId: saved.credentialId,
                sourceWorkspace: review.sourceWorkspace,
                tenant: "roles:" + profileId,
                workspace: "crm:" + review.sourceWorkspace,
              };
              result = {
                principal: saved.principal,
                credentialId: saved.credentialId,
                publicKey: saved.publicKey,
                binding,
                runtimeBindingDigest: hash(binding),
                permissionsGranted: false,
              };
              committed = !preventCommit;
              response = { status: "complete", result };
              if (dropComplete) {
                req.emit(
                  "error",
                  Error("Fixture completion reply lost after source commit"),
                );
                return;
              }
            } else if (action === "reconcile") {
              counts.reconcile++;
              assert.equal(body.pollSecret, pollSecret);
              assert.equal(body.request.id, requestId);
              assert.equal(body.request.candidateDigest, candidateDigest);
              assert.equal(
                body.request.operationId,
                enrollmentOperationId(originalEpoch, "complete"),
              );
              assert.equal(
                body.request.pollSecretHash,
                createHash("sha256").update(pollSecret).digest("hex"),
              );
              assert.equal(
                verify(
                  null,
                  Buffer.from(runtimeReconciliationMessage(body.request)),
                  key.publicKey,
                  Buffer.from(body.signature, "base64"),
                ),
                true,
              );
              response = {
                version: 1,
                id: requestId,
                operationId: wrongSettlement
                  ? randomUUID()
                  : body.request.operationId,
                candidateDigest,
                expiresAt: rolesExpiry,
                checkedAt: time,
                ...(committed
                  ? { status: "committed", result }
                  : { status: "not-committed" }),
              };
            } else throw Error("Unapproved fixture source route");
          }
          const res = Readable.from([JSON.stringify(response)]) as any;
          res.statusCode = 200;
          res.headers = { "content-type": "application/json" };
          callback(res);
        } catch (e) {
          req.emit("error", e);
        }
      });
    return req;
  }) as any;
  const make = () =>
    nativeCentralEnrollmentSessionFactory({
      path,
      centralStatePath: central,
      vault,
      pinnedSigner: attester.publicKey,
      credential: () => "a".repeat(64),
      admitted: () => allowed,
      reserveCost: () => {
        counts.reservations++;
      },
      now: () => time,
      resolve: (async () => [{ address: "8.8.8.8", family: 4 }]) as any,
      send,
    })(() => (allowed ? review : null));
  return {
    make,
    path,
    central,
    review: () => review,
    journal: () => {
      const db = new Database(path, { readonly: true });
      try {
        return db
          .prepare("SELECT id,value FROM enrollment_operations")
          .all()
          .map((row: any) =>
            vault.open<any>(row.value, "enrollment-operation:" + row.id),
          );
      } finally {
        db.close();
      }
    },
    counts,
    failHandoffSave: () => {
      failSave = true;
      handoffWrites = 0;
    },
    dropStart: () => {
      dropStart = true;
    },
    dropComplete: (commits = true) => {
      dropComplete = true;
      preventCommit = !commits;
    },
    wrongSettlement: () => {
      wrongSettlement = true;
    },
    revokeDevice: () => {
      sourceRevoked = true;
    },
    revokeOnPoll: () => {
      revokeOnPoll = true;
    },
    changeWorkspace: () => {
      review = { ...review, sourceWorkspace: randomUUID() };
    },
    restartReview: (elapsed = 4000) => {
      time += elapsed;
      review = { ...review, epoch: randomUUID(), expiresAt: time + 300000 };
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
    pollSecret,
  };
}
const signal = () => AbortSignal.timeout(4000);
for (const outcome of [
  "not-committed",
  "committed",
  "wrong-operation",
] as const) {
  test(`expired native enrollment reconciles the original reservation with ${outcome} evidence`, async () => {
    const f = fixture();
    let native = f.make();
    try {
      await native.execute({ action: "start" }, signal());
      f.dropComplete(outcome === "committed");
      await native.execute({ action: "poll" }, signal());
      const original = f.journal();
      assert.equal(
        original.find((entry) => entry.kind === "complete")?.state,
        "reserved",
      );
      const priorCounts = { ...f.counts };
      native.close();
      f.restartReview(240000);
      native = f.make();
      if (outcome === "wrong-operation") {
        f.wrongSettlement();
        await assert.rejects(
          () => native.execute({ action: "reconcile" }, signal()),
          /differs from the original/,
        );
      } else {
        const status = await native.execute({ action: "reconcile" }, signal());
        assert.equal(status.reconciliation, outcome);
        assert.equal(Boolean(status.enrollment), outcome === "committed");
        assert(!JSON.stringify(status).includes(f.pollSecret));
        native.close();
        f.restartReview();
        native = f.make();
        assert.equal(
          (await native.execute({ action: "reconcile" }, signal()))
            .reconciliation,
          outcome,
        );
      }
      assert.equal(f.counts.reconcile, 1);
      assert.equal(f.counts.start, priorCounts.start);
      assert.equal(f.counts.complete, priorCounts.complete);
      assert.equal(f.counts.reservations, priorCounts.reservations + 2);
      assert.equal(f.counts.heartbeat, priorCounts.heartbeat + 1);
      assert.deepEqual(f.journal(), original);
    } finally {
      native.close();
      f.cleanup();
    }
  });
}
test("native central enrollment uses the existing central signer through verified fixed source exchange", async () => {
  const f = fixture();
  let owner = f.make();
  try {
    assert.equal(
      (await owner.execute({ action: "status" }, signal())).state.status,
      "not-started",
    );
    await assert.rejects(
      owner.execute(
        { action: "start", sourceWorkspace: randomUUID() },
        signal(),
      ),
    );
    assert.equal(f.counts.start, 0);
    const start = await owner.execute({ action: "start" }, signal());
    assert.equal(start.state.status, "pending");
    const complete = await owner.execute({ action: "poll" }, signal());
    assert.equal(complete.state.status, "complete");
    assert.equal(complete.permissionsGranted, false);
    assert.ok(complete.enrollment);
    assert.equal(complete.enrollment.principal, f.review().principal);
    assert.equal(JSON.stringify(complete).includes(f.pollSecret), false);
    assert.equal(JSON.stringify(complete).includes("PRIVATE KEY"), false);
    assert.deepEqual(f.counts, {
      heartbeat: 2,
      start: 1,
      poll: 1,
      attest: 1,
      complete: 1,
      reconcile: 0,
      reservations: 6,
    });
    owner.close();
    f.restartReview();
    owner = f.make();
    assert.equal(
      (await owner.execute({ action: "start" }, signal())).state.status,
      "complete",
    );
    assert.equal(f.counts.start, 1);
    assert.equal(
      readFileSync(f.path).includes(Buffer.from(f.pollSecret)),
      false,
    );
  } finally {
    owner.close();
    f.cleanup();
  }
});
test("lost completion is reconciled by original poll after restart and fresh consent, without another mutation", async () => {
  const f = fixture();
  f.dropComplete();
  let owner = f.make();
  try {
    await owner.execute({ action: "start" }, signal());
    const uncertain = await owner.execute({ action: "poll" }, signal());
    assert.equal(uncertain.state.status, "pending");
    const original = f.journal().find((r: any) => r.kind === "complete");
    assert.equal(original.state, "reserved");
    owner.close();
    f.restartReview(30000);
    owner = f.make();
    assert.equal(
      (await owner.execute({ action: "poll" }, signal())).state.status,
      "complete",
    );
    const reconciled = f.journal().find((r: any) => r.kind === "complete");
    assert.equal(reconciled.state, "confirmed");
    assert.equal(reconciled.operationId, original.operationId);
    assert.equal(reconciled.requestDigest, original.requestDigest);
    assert.deepEqual(f.counts, {
      heartbeat: 3,
      start: 1,
      poll: 2,
      attest: 1,
      complete: 1,
      reconcile: 0,
      reservations: 8,
    });
  } finally {
    owner.close();
    f.cleanup();
  }
});
test("uncertain start retains original reservation across restart and cannot mint another source request", async () => {
  const f = fixture();
  f.dropStart();
  let owner = f.make();
  try {
    await assert.rejects(owner.execute({ action: "start" }, signal()));
    owner.close();
    f.restartReview();
    owner = f.make();
    await assert.rejects(
      owner.execute({ action: "start" }, signal()),
      /uncertain/,
    );
    assert.equal(f.counts.start, 1);
    assert.equal(f.counts.reservations, 2);
  } finally {
    owner.close();
    f.cleanup();
  }
});
test("revocation after source poll blocks attestation and enrollment completion", async () => {
  const f = fixture();
  f.revokeOnPoll();
  const owner = f.make();
  try {
    await owner.execute({ action: "start" }, signal());
    await assert.rejects(owner.execute({ action: "poll" }, signal()));
    assert.equal(f.counts.attest, 0);
    assert.equal(f.counts.complete, 0);
  } finally {
    owner.close();
    f.cleanup();
  }
});

test("fresh consent cannot replace the original central source binding or reset its start", async () => {
  const f = fixture();
  const owner = f.make();
  try {
    await owner.execute({ action: "start" }, signal());
  } finally {
    owner.close();
  }
  try {
    f.restartReview();
    f.changeWorkspace();
    assert.throws(() => f.make(), /binding cannot be replaced/);
    assert.equal(f.counts.start, 1);
  } finally {
    f.cleanup();
  }
});

test("verified native start receipt is recovered after local handoff persistence fails, without another POST", async () => {
  const f = fixture();
  f.failHandoffSave();
  let owner = f.make();
  try {
    await assert.rejects(
      owner.execute({ action: "start" }, signal()),
      /local handoff save/,
    );
    assert.equal(f.counts.start, 1);
    owner.close();
    f.restartReview();
    owner = f.make();
    const recovered = await owner.execute({ action: "start" }, signal());
    assert.equal(recovered.state.status, "pending");
    assert.equal(f.counts.start, 1);
    assert.equal(f.counts.reservations, 2);
  } finally {
    owner.close();
    f.cleanup();
  }
});

test("fresh signed-device verification detects remote revocation before another Roles action", async () => {
  const f = fixture(),
    owner = f.make();
  try {
    await owner.execute({ action: "start" }, signal());
    f.revokeDevice();
    await assert.rejects(owner.execute({ action: "poll" }, signal()));
    assert.equal(f.counts.heartbeat, 2);
    assert.equal(f.counts.start, 1);
    assert.equal(f.counts.poll, 0);
    assert.equal(f.counts.attest, 0);
    assert.equal(f.counts.complete, 0);
  } finally {
    owner.close();
    f.cleanup();
  }
});
