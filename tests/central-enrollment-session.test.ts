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
function fixture(maximumStarts = 2) {
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
  let requestId = randomUUID(),
    pollSecret = randomBytes(32).toString("hex");
  const profileId = randomUUID();
  let challenge: any, result: any, candidateDigest: string, rolesExpiry: string;
  let requestEpoch = review.epoch;
  let completionAttempted = false;
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
              assert(counts.start <= maximumStarts);
              requestEpoch = review.epoch;
              completionAttempted = false;
              if (body.request.deferredFrom)
                assert.equal(body.request.deferredFrom, requestId);
              if (counts.start > 1) {
                requestId = randomUUID();
                pollSecret = randomBytes(32).toString("hex");
              }
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
              rolesExpiry = new Date(
                time + (body.request.deferredFrom ? 7200000 : 60000),
              ).toISOString();
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
                  expiresAt: rolesExpiry,
                  request: challenge,
                };
              }
              if (revokeOnPoll) allowed = false;
            } else if (action === "complete") {
              completionAttempted = true;
              counts.complete++;
              assert(counts.complete <= (maximumStarts === 4 ? 2 : 1));
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
                body.request.operation,
                completionAttempted ? undefined : "start",
              );
              assert.equal(
                body.request.operationId,
                enrollmentOperationId(
                  requestEpoch,
                  completionAttempted ? "complete" : "start",
                ),
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
    archives: () => {
      const db = new Database(path, { readonly: true });
      try {
        return db
          .prepare(
            "SELECT id,epoch,record FROM central_native_handoff_archive ORDER BY rowid",
          )
          .all()
          .map((row: any) =>
            vault.open<any>(
              row.record,
              "central-native-handoff-archive:" + row.id + ":" + row.epoch,
            ),
          );
      } finally {
        db.close();
      }
    },
    restoreLegacyArchiveLayout: () => {
      const db = new Database(path);
      try {
        db.exec(`
          ALTER TABLE central_native_handoff_archive RENAME TO test_archive;
          CREATE TABLE central_native_handoff_archive(id TEXT PRIMARY KEY,epoch TEXT NOT NULL,record BLOB NOT NULL);
          INSERT INTO central_native_handoff_archive SELECT id,epoch,record FROM test_archive;
          DROP TABLE test_archive;
        `);
      } finally {
        db.close();
      }
    },
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
    allowCompletion: () => {
      dropComplete = false;
      preventCommit = false;
    },
    advance: (elapsed: number) => {
      time += elapsed;
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
async function exerciseDeferredEnrollment(
  outcome: "complete" | "lost-reply" | "expired",
) {
  const finishDeferred = outcome !== "expired";
  const f = fixture(4);
  let native = f.make();
  try {
    const first = await native.execute({ action: "start" }, signal());
    f.dropComplete(false);
    await native.execute({ action: "poll" }, signal());
    const original = f.journal();
    native.close();
    f.restartReview(240000);
    native = f.make();
    assert.equal(
      (await native.execute({ action: "reconcile" }, signal())).reconciliation,
      "not-committed",
    );
    await assert.rejects(
      () => native.execute({ action: "start" }, signal()),
      /Separate fresh native approval/,
    );
    assert.equal(f.counts.start, 1);
    assert.deepEqual(f.archives(), []);
    native.close();
    f.restartReview();
    native = f.make();
    assert.equal(
      (await native.execute({ action: "status" }, signal()))
        .replacementReviewReady,
      true,
    );
    const replacement = await native.execute({ action: "start" }, signal());
    assert.equal(replacement.state.status, "pending");
    assert.notEqual(
      (replacement.state as any).reviewUrl,
      (first.state as any).reviewUrl,
    );
    assert.equal(replacement.permissionsGranted, false);
    assert.equal(
      f.archives()[0]?.handoff.reviewUrl,
      (first.state as any).reviewUrl,
    );
    assert.equal(f.archives()[0]?.settlement.outcome, "not-committed");
    assert.deepEqual(
      f
        .journal()
        .filter((entry) =>
          original.some((old) => old.operationId === entry.operationId),
        ),
      original,
    );
    assert.equal(f.journal().length, original.length + 1);
    assert.equal(f.counts.start, 2);
    assert.equal(f.counts.complete, 1);

    const originalArchive = f.archives()[0];
    const replacementJournal = f.journal();
    native.close();
    f.restoreLegacyArchiveLayout();
    f.restartReview(360000);
    native = f.make();
    assert.deepEqual(f.archives(), [originalArchive]);
    assert.equal(
      (await native.execute({ action: "reconcile" }, signal())).reconciliation,
      "not-committed",
    );
    assert.deepEqual(f.journal(), replacementJournal);
    assert.equal(f.counts.complete, 1);
    await assert.rejects(
      () => native.execute({ action: "start" }, signal()),
      /Separate fresh native approval/,
    );
    native.close();
    f.restartReview(300001);
    native = f.make();
    const recovery = await native.execute({ action: "start" }, signal());
    assert.equal(recovery.state.status, "pending");
    assert.equal(recovery.permissionsGranted, false);
    assert.deepEqual(f.archives()[0], originalArchive);
    assert.equal(
      f.archives()[1]?.handoff.reviewUrl,
      (replacement.state as any).reviewUrl,
    );
    assert.equal(f.archives()[1]?.settlement.operationKind, "start");
    assert.deepEqual(
      f
        .journal()
        .filter((row) =>
          replacementJournal.some(
            (prior) => prior.operationId === row.operationId,
          ),
        ),
      replacementJournal,
    );
    assert.equal(f.counts.start, 3);
    assert.equal(f.counts.complete, 1);

    native.close();
    f.restartReview(360000);
    native = f.make();
    await native.execute({ action: "reconcile" }, signal());
    const priorArchives = f.archives();
    const priorOperations = f.journal();
    await assert.rejects(
      () => native.execute({ action: "start" }, signal()),
      /Separate fresh native approval/,
    );
    native.close();
    f.restartReview(300001);
    native = f.make();
    const deferred = await native.execute({ action: "start" }, signal());
    assert.equal(deferred.deferredOwnerReview, true);
    assert.equal(deferred.permissionsGranted, false);
    assert.deepEqual(f.archives().slice(0, 2), priorArchives);
    assert.equal(f.archives().length, 3);
    assert.equal(f.counts.start, 4);
    f.advance(finishDeferred ? 3600000 : 7500000);
    await assert.rejects(
      () => native.execute({ action: "poll" }, signal()),
      /consent required/,
    );
    native.close();
    f.restartReview();
    native = f.make();
    if (finishDeferred) {
      const resumed = await native.execute({ action: "status" }, signal());
      assert.deepEqual(resumed.state, deferred.state);
      assert.equal(resumed.originalReviewExpired, false);
      await native.execute({ action: "start" }, signal());
      f.allowCompletion();
      if (outcome === "lost-reply") {
        f.dropComplete();
        assert.equal(
          (await native.execute({ action: "poll" }, signal())).state.status,
          "pending",
        );
        native.close();
        f.restartReview(360000);
        native = f.make();
      }
      assert.equal(
        (await native.execute({ action: "poll" }, signal())).state.status,
        "complete",
      );
      assert.equal(f.counts.complete, 2);
    } else {
      const settled = await native.execute({ action: "reconcile" }, signal());
      assert.equal(settled.reconciliation, "not-committed");
      assert.equal(settled.replacementLimitReached, true);
      native.close();
      f.restartReview(300001);
      native = f.make();
      await assert.rejects(
        () => native.execute({ action: "start" }, signal()),
        /Separate fresh native approval/,
      );
      assert.equal(f.counts.complete, 1);
    }
    assert.deepEqual(
      f
        .journal()
        .filter((row) =>
          priorOperations.some(
            (prior) => prior.operationId === row.operationId,
          ),
        ),
      priorOperations,
    );
    assert.equal(f.counts.start, 4);
  } finally {
    native.close();
    f.cleanup();
  }
}
for (const outcome of ["complete", "lost-reply", "expired"] as const)
  test(`deferred enrollment preserves the original operations through ${outcome}`, () =>
    exerciseDeferredEnrollment(outcome));
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
