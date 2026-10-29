import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Vault } from "../modules/storage/vault.js";
import {
  initializeNativeWorkflowIdentity,
  readNativeWorkflowIdentity,
} from "../modules/task-sync/native-identity-review.js";
import { pairingDigest } from "../modules/task-sync/initial-pairing.js";
import { requireSynchronousPairingAdmission } from "../modules/task-sync/initial-pairing-admission.js";
import { prepareNativeInitialPairingHelper } from "../apps/companion/initial-pairing-helper.js";

class ObservedVault extends Vault {
  opens = 0;
  override open<T>(value: Buffer, purpose: string): T {
    this.opens++;
    return super.open<T>(value, purpose);
  }
}
// Synthetic local identity/journal and fake source socket only. This is not a
// production owner, source admission, human confirmation or enrollment receipt.
function fixture(t: TestContext) {
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), "native-pair-helper-"),
  );
  const vault = new ObservedVault(randomBytes(32));
  const taskStatePath = join(directory, "task-sync.db"),
    journalPath = join(directory, "pairing.db");
  initializeNativeWorkflowIdentity(taskStatePath, vault, () => true);
  const inspected = readNativeWorkflowIdentity(taskStatePath, vault);
  if (inspected.status !== "existing")
    throw Error("Synthetic identity required");
  vault.opens = 0;
  const source = generateKeyPairSync("ed25519");
  const rolesPublicKey = source.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const expected = {
    principal: inspected.principal,
    keyFingerprint: inspected.credentialId,
    rolesKeyFingerprint: createHash("sha256")
      .update(rolesPublicKey)
      .digest("hex"),
  };
  const state = {
    binding: { ...expected } as typeof expected | null,
    admitted: true,
    admissions: 0,
    resolves: 0,
    sends: 0,
  };
  const options = {
    identity: {
      principal: inspected.principal,
      publicKey: inspected.publicKey,
    },
    rolesPublicKey,
    vault,
    taskStatePath,
    journalPath,
    coreToken: "b".repeat(64),
    currentBinding: () => state.binding,
    admitSource(scope: any) {
      state.admissions++;
      assert.equal(scope.purpose, "metadata-only-owner-pairing");
      assert.equal(scope.rolesKeyFingerprint, expected.rolesKeyFingerprint);
      assert.equal(scope.additionalSpendingUSD, 0);
      if (!state.admitted) throw Error("synthetic source purpose denied");
    },
    network: {
      resolve: (async () => {
        state.resolves++;
        return [{ address: "8.8.8.8", family: 4 }];
      }) as any,
      send: ((_url: any, config: any, callback: any) => {
        state.sends++;
        assert.equal(config.headers.Authorization, undefined);
        assert.equal(config.headers.Cookie, undefined);
        const req = new EventEmitter() as any;
        req.end = (raw: string) =>
          setImmediate(() => {
            const { request } = JSON.parse(raw),
              pairingId = randomUUID();
            const response = new PassThrough() as any;
            response.statusCode = 200;
            response.headers = { "content-type": "application/json" };
            callback(response);
            response.end(
              JSON.stringify({
                status: "pending",
                pairingId,
                pollSecret: "c".repeat(64),
                requestDigest: pairingDigest(request),
                reviewUrl:
                  "https://roles.bittrees.org/profile?pairingRequest=" +
                  pairingId,
                expiresAt: request.expiresAt,
                permissionsGranted: false,
              }),
            );
          });
        return req;
      }) as any,
    },
  };
  const helpers: ReturnType<typeof prepareNativeInitialPairingHelper>[] = [];
  const helper = () => {
    const h = prepareNativeInitialPairingHelper(options);
    helpers.push(h);
    return h;
  };
  t.after(async () => {
    for (const h of helpers) await h.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { state, vault, options, helper, expected, journalPath };
}
async function client(
  helper: ReturnType<typeof prepareNativeInitialPairingHelper>,
) {
  const native = await helper.listen();
  const send = (body: unknown, token = native.token) =>
    fetch(native.endpoint, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  return {
    native,
    send,
    async propose() {
      return (await (await send({ action: "prepare" })).json()) as any;
    },
  };
}
test("helper construction, listen and scope preparation read no identity key or journal and create no source request", async (t) => {
  const f = fixture(t),
    h = f.helper();
  assert.equal(f.vault.opens, 0);
  const c = await client(h),
    proposal = await c.propose();
  assert.deepEqual(c.native.binding.principal, f.expected.principal);
  assert.match(c.native.token, /^[a-f0-9]{64}$/);
  assert.notEqual(c.native.token, f.options.coreToken);
  assert.equal(proposal.review.keyFingerprint, f.expected.keyFingerprint);
  assert.equal(
    proposal.review.rolesKeyFingerprint,
    f.expected.rolesKeyFingerprint,
  );
  assert.equal(proposal.review.permissionsGranted, false);
  assert.equal(proposal.review.runtimeEnrolled, false);
  assert.equal(f.vault.opens, 0);
  assert.equal(f.state.admissions, 0);
  assert.equal(existsSync(f.journalPath), false);
  assert.equal(f.state.sends, 0);
  assert.equal(
    (await c.send({ action: "prepare" }, f.options.coreToken)).status,
    403,
  );
});
test("IPC exact consent reaches actual existing-key signer, owned journal and pinned transport once; revocation and restart deny replay", async (t) => {
  const f = fixture(t),
    h = f.helper(),
    c = await client(h),
    p = await c.propose();
  const response = await c.send({
    action: "approve",
    reviewId: p.review.reviewId,
    digest: p.digest,
  });
  assert.equal(response.status, 200);
  const result = (await response.json()) as any;
  assert.equal(result.status, "pending");
  assert.equal(result.permissionsGranted, false);
  assert.ok(f.vault.opens > 0);
  assert.ok(existsSync(f.journalPath));
  assert.equal(f.state.sends, 1);
  f.state.admitted = false;
  assert.equal((await c.send({ action: "poll" })).status, 400);
  assert.equal(f.state.sends, 1);
  await h.close();
  f.state.admitted = true;
  const next = await client(f.helper()),
    nextProposal = await next.propose();
  assert.notEqual(next.native.token, c.native.token);
  assert.equal(
    (
      await next.send({
        action: "approve",
        reviewId: nextProposal.review.reviewId,
        digest: nextProposal.digest,
      })
    ).status,
    400,
  );
  assert.equal(
    f.state.sends,
    1,
    "Existing durable operation requires reconciliation rather than another start",
  );
});
test("missing/changed native or source binding denies before vault, journal or source admission", async (t) => {
  const f = fixture(t);
  for (const field of [
    "principal",
    "keyFingerprint",
    "rolesKeyFingerprint",
    "missing",
  ] as const) {
    f.state.binding = { ...f.expected };
    const c = await client(f.helper()),
      p = await c.propose();
    f.state.binding =
      field === "missing"
        ? null
        : {
            ...f.expected,
            [field]:
              field === "principal" ? "agent:" + randomUUID() : "f".repeat(64),
          };
    assert.equal(
      (
        await c.send({
          action: "approve",
          reviewId: p.review.reviewId,
          digest: p.digest,
        })
      ).status,
      400,
    );
  }
  assert.equal(f.vault.opens, 0);
  assert.equal(f.state.admissions, 0);
  assert.equal(existsSync(f.journalPath), false);
  assert.equal(f.state.sends, 0);
});
test("async helper admission is denied before key read or source operation", async (t) => {
  const f = fixture(t);
  const h = prepareNativeInitialPairingHelper({
    ...f.options,
    admitSource: async () => {},
  });
  t.after(() => h.close());
  const c = await client(h),
    p = await c.propose();
  assert.equal(
    (
      await c.send({
        action: "approve",
        reviewId: p.review.reviewId,
        digest: p.digest,
      })
    ).status,
    400,
  );
  assert.equal(f.vault.opens, 0);
  assert.equal(f.state.resolves, 0);
  assert.equal(f.state.sends, 0);
  assert.equal(existsSync(f.journalPath), false);
});
test("non-void or rejected async admission verdicts are observed and denied synchronously", async () => {
  for (const callback of [
    () => true,
    () => ({ then() {} }),
    async () => {},
    async () => {
      throw Error("not admitted");
    },
  ]) {
    assert.throws(
      () => requireSynchronousPairingAdmission(callback),
      /synchronous/,
    );
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotThrow(() => requireSynchronousPairingAdmission(() => {}));
});
