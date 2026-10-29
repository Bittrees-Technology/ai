import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  randomBytes,
  randomUUID,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Vault } from "../modules/storage/vault.js";
import {
  initializeNativeWorkflowIdentity,
  readNativeWorkflowIdentity,
} from "../modules/task-sync/native-identity-review.js";
import { NativeInitialPairingSession } from "../modules/task-sync/initial-pairing-native-session.js";
import {
  INITIAL_PAIRING_START,
  INITIAL_PAIRING_AUDIENCE,
  initialPairingClaimMessage,
  pairingDigest,
  type InitialPairingConsent,
} from "../modules/task-sync/initial-pairing.js";
import { openNativeInitialPairingJournal } from "../modules/task-sync/initial-pairing-native-journal.js";

// All keys, owners, claims and network responses here are synthetic, never source admission evidence.
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "native-pair-session-"));
  const taskStatePath = join(dir, "task-sync.db"),
    journalPath = join(dir, "pairing.db"),
    vault = new Vault(randomBytes(32));
  initializeNativeWorkflowIdentity(taskStatePath, vault, () => true);
  const inspected = readNativeWorkflowIdentity(taskStatePath, vault);
  if (inspected.status !== "existing") throw Error("synthetic fixture");
  const identity = {
    principal: inspected.principal,
    publicKey: inspected.publicKey,
  };
  const source = generateKeyPairSync("ed25519"),
    rolesPublicKey = source.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
  const state = {
    consent: {
      id: randomUUID(),
      principal: identity.principal,
      keyFingerprint: inspected.credentialId,
      expiresAt: Date.now() + 60000,
    } as InitialPairingConsent | null,
    admitted: true,
    resolves: 0,
    sends: 0,
    admissions: 0,
  };
  const pairingId = randomUUID(),
    ownerProfile = randomUUID();
  let initial: any;
  const sessions: NativeInitialPairingSession[] = [];
  const network = {
    resolve: (async () => {
      state.resolves++;
      return [{ address: "8.8.8.8", family: 4 }];
    }) as any,
    send: ((url: any, options: any, callback: any) => {
      state.sends++;
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.headers.Cookie, undefined);
      const req = new EventEmitter() as any;
      req.end = (raw: string) =>
        setImmediate(() => {
          const body = JSON.parse(raw);
          let result;
          if (url.href === INITIAL_PAIRING_START) {
            initial = body.request;
            result = {
              status: "pending",
              pairingId,
              pollSecret: "b".repeat(64),
              requestDigest: pairingDigest(initial),
              reviewUrl:
                "https://roles.bittrees.org/profile?pairingRequest=" +
                pairingId,
              expiresAt: initial.expiresAt,
              permissionsGranted: false,
            };
          } else {
            const now = Date.now(),
              claim = {
                version: 1,
                issuer: "https://roles.bittrees.org",
                audience: INITIAL_PAIRING_AUDIENCE,
                purpose: "metadata-only-owner-pairing",
                pairingId,
                operationId: initial.operationId,
                requestDigest: pairingDigest(initial),
                pollRequestDigest: pairingDigest(body.request),
                principal: identity.principal,
                keyFingerprint: inspected.credentialId,
                ownerProfile,
                personPrincipal: "person:" + ownerProfile,
                policyDigest: "c".repeat(64),
                activePerson: true,
                applicableRole: true,
                checkedAt: now,
                expiresAt: now + 2000,
                permissionsGranted: false,
                rolesCredentialId: null,
                runtimeEnrolled: false,
                workspace: null,
                nativeLease: null,
                agentController: null,
              };
            result = {
              status: "paired",
              proof: {
                claim,
                signature: sign(
                  null,
                  Buffer.from(initialPairingClaimMessage(claim)),
                  source.privateKey,
                ).toString("base64"),
              },
            };
          }
          const res = new PassThrough() as any;
          res.statusCode = 200;
          res.headers = { "content-type": "application/json" };
          callback(res);
          res.end(JSON.stringify(result));
        });
      return req;
    }) as any,
  };
  const options = {
    identity,
    taskStatePath,
    journalPath,
    vault,
    rolesPublicKey,
    currentConsent: () => state.consent,
    admitSource: (review: any) => {
      state.admissions++;
      assert.equal(review.purpose, "metadata-only-owner-pairing");
      if (!state.admitted) throw Error("source purpose denied");
    },
    network,
  };
  function session(overrides: Partial<typeof options> = {}) {
    const s = new NativeInitialPairingSession({ ...options, ...overrides });
    sessions.push(s);
    return s;
  }
  t.after(async () => {
    for (const s of sessions) await s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    state,
    options,
    session,
    journalPath,
    vault,
    identity,
    inspected,
    network,
  };
}
test("construction and denied native/source consent perform no journal or network I/O", async (t) => {
  const f = fixture(t),
    s = f.session();
  assert.equal(existsSync(f.journalPath), false);
  assert.equal(f.state.admissions, 0);
  f.state.admitted = false;
  await assert.rejects(s.start(), /source purpose/);
  assert.equal(existsSync(f.journalPath), false);
  f.state.admitted = true;
  f.state.consent = null;
  await assert.rejects(s.start());
  assert.equal(existsSync(f.journalPath), false);
  assert.equal(f.state.resolves, 0);
  assert.equal(f.state.sends, 0);
});
test("real synthetic native key, encrypted journal, fixed HTTPS and source proof compose without credentials or grants", async (t) => {
  const f = fixture(t),
    s = f.session();
  const start = await s.start();
  assert.equal(start.permissionsGranted, false);
  const result = await s.poll();
  assert.equal(result.status, "paired");
  assert.ok("runtimeEnrolled" in result);
  assert.equal(result.runtimeEnrolled, false);
  assert.equal(result.rolesCredentialId, null);
  assert.equal(result.agentController, null);
  assert.equal(f.state.sends, 2);
  await s.close();
  const j = openNativeInitialPairingJournal(f.journalPath, f.vault, {
    principal: f.identity.principal,
    keyFingerprint: f.inspected.credentialId,
  });
  try {
    const saved = (await j.store.load()) as any;
    assert.equal(saved.phase, "paired");
    assert.equal(saved.calls, 2);
  } finally {
    j.close();
  }
  await assert.rejects(s.poll(), /closed/);
});
test("unknown initial outcome remains held across session recreation without another socket", async (t) => {
  const f = fixture(t);
  const s = f.session({
    network: {
      ...f.network,
      send: (() => {
        f.state.sends++;
        throw Error("synthetic unknown outcome");
      }) as any,
    },
  });
  await assert.rejects(s.start(), /unknown/);
  await s.close();
  assert.equal(f.state.sends, 1);
  const next = f.session();
  await assert.rejects(next.start(), /Reconcile existing/);
  assert.equal(f.state.sends, 1);
});
test("cancel during DNS drains the action before closing its durable held journal", async (t) => {
  const f = fixture(t);
  let release!: (v: any) => void, entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  const s = f.session({
    network: {
      ...f.network,
      resolve: (() => {
        entered();
        return new Promise((r) => (release = r));
      }) as any,
    },
  });
  const start = s.start();
  const rejected = assert.rejects(start);
  await ready;
  const closing = s.close();
  await rejected;
  await closing;
  release([{ address: "8.8.8.8", family: 4 }]);
  assert.equal(f.state.sends, 0);
  const next = f.session();
  await assert.rejects(next.start(), /Reconcile existing/);
  assert.equal(f.state.sends, 0);
});
test("revoked native consent after DNS denies before socket and retains held outcome", async (t) => {
  const f = fixture(t),
    s = f.session({
      network: {
        ...f.network,
        resolve: (async () => {
          f.state.consent = null;
          return [{ address: "8.8.8.8", family: 4 }];
        }) as any,
      },
    });
  await assert.rejects(s.start());
  assert.equal(f.state.sends, 0);
  await s.close();
  const j = openNativeInitialPairingJournal(f.journalPath, f.vault, {
    principal: f.identity.principal,
    keyFingerprint: f.inspected.credentialId,
  });
  try {
    assert.equal(((await j.store.load()) as any).phase, "held");
  } finally {
    j.close();
  }
});
