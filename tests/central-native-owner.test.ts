import test from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  randomBytes,
} from "node:crypto";
import { mkdtemp, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "../modules/storage/vault.js";
import {
  CentralNativeOwner,
  type CentralNativeReview,
} from "../modules/workflows/central-native-owner.js";
import { CentralNativeService } from "../modules/workflows/central-native-service.js";
import { nativeCentralSessionFactory } from "../modules/workflows/central-native-session.js";
const fixture = () => {
  const pair = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    }),
    time = Date.now(),
    epoch = randomUUID();
  const period = { epoch, approvedAt: time - 1000, expiresAt: time + 60000 };
  const review: CentralNativeReview = {
    ownerWallet: "0x" + "a".repeat(40),
    scope: {
      ...period,
      principal: "agent:" + randomUUID(),
      publicKey: pair.publicKey,
      credentialId: createHash("sha256").update(pair.publicKey).digest("hex"),
      delegationId: randomUUID(),
      tenant: "t",
      workspace: "w",
      workflowId: "fixture",
      connectionId: randomUUID(),
    },
    budget: {
      ...period,
      costBasis: "verified-included-usage",
      maximumAttempts: 3,
      maximumMicroUSD: 0,
      attemptCeilingMicroUSD: 0,
      evidenceId: "synthetic-included-usage",
    },
  };
  return { review, time };
};
test("native central control separates approval capability and never opens a session before exact current consent", async () => {
  const f = fixture();
  let made = 0,
    closed = 0,
    admitted = true;
  const service = new CentralNativeService(
    () => f.review,
    () => admitted,
    () => {
      made++;
      return {
        dispatch: async () => Buffer.from("{}"),
        close: () => {
          closed++;
        },
      };
    },
    () => f.time,
  );
  const post = (url: string, token: string, body: unknown) =>
    fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    const endpoints = await service.listen();
    assert.notEqual(endpoints.native.token, endpoints.core.token);
    assert.equal(made, 0);
    const denied = await post(endpoints.native.url, endpoints.core.token, {
      action: "propose",
    });
    assert.equal(denied.status, 403);
    await denied.body?.cancel();
    const proposal = await (
      await post(endpoints.native.url, endpoints.native.token, {
        action: "propose",
      })
    ).json();
    assert.equal(made, 0);
    assert.throws(() => service.approve("b".repeat(64)));
    assert.equal(made, 0);
    f.review.budget.evidenceId = "changed";
    assert.throws(() => service.approve(proposal.digest));
    assert.equal(made, 0);
    const fresh = service.propose();
    service.approve(fresh.digest);
    assert.equal(made, 1);
    assert.throws(() => service.propose());
    admitted = false;
    await service.revoke();
    assert.equal(closed, 1);
    assert.throws(() => service.propose());
  } finally {
    await service.close();
  }
});
test("native central owner cancels immediately but drains active work before closing storage", async () => {
  const f = fixture();
  let started!: () => void,
    release!: (value: Uint8Array) => void,
    closed = 0;
  const began = new Promise<void>((r) => {
      started = r;
    }),
    response = new Promise<Uint8Array>((r) => {
      release = r;
    });
  const owner = new CentralNativeOwner(
    f.review,
    () => f.review,
    () => ({
      dispatch: async () => {
        started();
        return response;
      },
      close: () => {
        closed++;
      },
    }),
    () => f.time,
  );
  const pending = owner.dispatch({}, new AbortController().signal);
  void pending.catch(() => {});
  await began;
  const closing = owner.close();
  assert.equal(closed, 0);
  await assert.rejects(owner.dispatch({}, new AbortController().signal));
  release(Buffer.from("{}"));
  await assert.rejects(pending);
  await closing;
  assert.equal(closed, 1);
  assert.equal(owner.close(), closing);
});
test("native central session requires matching live scope/budget and admission before storage or credential access", async () => {
  const f = fixture(),
    dir = await mkdtemp(join(tmpdir(), "central-session-")),
    path = join(dir, "budget.db");
  let tokens = 0,
    admitted = false;
  const factory = nativeCentralSessionFactory({
    path,
    vault: new Vault(randomBytes(32)),
    credential: () => {
      tokens++;
      return "fixture-token-123456";
    },
    admitted: () => admitted,
    now: () => f.time,
  });
  try {
    assert.throws(() => factory(() => f.review));
    await assert.rejects(access(path));
    assert.equal(tokens, 0);
    admitted = true;
    const bad = structuredClone(f.review);
    bad.budget.epoch = randomUUID();
    assert.throws(() => factory(() => bad));
    await assert.rejects(access(path));
    const session = factory(() => f.review);
    assert.equal(tokens, 0);
    admitted = false;
    await assert.rejects(session.dispatch({}, new AbortController().signal));
    session.close();
    assert.equal(tokens, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("failed native storage close holds future approvals and still closes both helper ports", async () => {
  const f = fixture(),
    service = new CentralNativeService(
      () => f.review,
      () => true,
      () => ({
        dispatch: async () => Buffer.from("{}"),
        close: () => {
          throw Error("storage hold");
        },
      }),
      () => f.time,
    );
  const endpoints = await service.listen(),
    proposal = service.propose();
  service.approve(proposal.digest);
  await assert.rejects(service.revoke(), /storage hold/);
  assert.throws(() => service.propose());
  await assert.rejects(service.close());
  await assert.rejects(fetch(endpoints.core.url));
  await assert.rejects(fetch(endpoints.native.url));
});
