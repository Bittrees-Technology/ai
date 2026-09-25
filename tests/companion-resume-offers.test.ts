import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { privateEndpoints } from "./helpers/private-endpoints.js";
import { CompanionPrivateKeys } from "../apps/companion/private-keys.js";
import { localApi } from "../apps/companion/http.js";
import { resumeTaskAccess } from "../apps/companion/resume-access.js";
import { SourceTasks } from "../modules/connectors/source-tasks.js";
import {
  sealPrivateEnvelope,
  openPrivateEnvelope,
  privateEnvelopeSuite,
} from "../modules/remote/private-envelope.js";
const profile = {
  id: "resume-http",
  runtime: "ollama" as const,
  model: "synthetic",
  contextTokens: 4096,
  maxOutputTokens: 1000,
  temperature: 0,
};
async function fixture(enabled = true, questions = false) {
  const f = await privateEndpoints(true),
    e = f.b;
  e.store.addProfile(e.owner, profile);
  let task = e.store.create(
    e.owner,
    {
      conversationId: randomUUID(),
      kind: "query",
      prompt: "SYNTHETIC_PRIVATE_RESUME_TASK",
      modelProfileId: profile.id,
      allowQuestions: questions,
    },
    randomUUID(),
  );
  task = e.store.command(e.owner, task.id, {
    command: "pause",
    expectedRevision: task.revision,
  });
  let digest = "a".repeat(64),
    hook: undefined | (() => Promise<void>);
  const runtime = {
    pin: async () => {
      await hook?.();
      return { profile, digest };
    },
  };
  const controls = new CompanionPrivateKeys(
    e.store,
    e.vault,
    e.owner,
    e.entries,
    e.remote,
    true,
    f.clock,
    true,
    {},
    {
      enabled,
      runtime,
      taskAccess: resumeTaskAccess(
        e.store,
        e.owner,
        new SourceTasks(),
        runtime,
        undefined,
        f.clock,
      ),
    },
  );
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port,
    token = randomBytes(32).toString("hex");
  server.on(
    "request",
    localApi({
      store: e.store,
      owner: e.owner,
      privateKeys: controls,
      token,
      port,
    }),
  );
  const call = (path = "", body?: unknown, headers = {}) =>
    fetch(`http://127.0.0.1:${port}/v1/private-resume${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const ok = async (path = "", body?: unknown) => {
    const response = await call(path, body),
      value = (await response.json()) as any;
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  const request = () => {
    const s = controls.resumePermissionStatus();
    return {
      action: "grant",
      expectedRevision: s.revision,
      expectedKeyRevision: s.keyRevision,
      expectedPeerRevision: s.peerRevision,
      peerId: f.a.grant.deviceId,
      peerKeyEpoch: 1,
      taskId: task.id,
      taskRevision: task.revision,
      minutes: 15,
    };
  };
  const approve = async () => {
    const r = await ok("/prepare", request());
    return ok("/confirm", {
      reviewId: r.id,
      confirmed: true,
      acknowledged: true,
    });
  };
  return {
    ...f,
    e,
    task,
    controls,
    call,
    ok,
    request,
    approve,
    setDigest: (value: string) => {
      digest = value;
    },
    pinHook: (value?: () => Promise<void>) => {
      hook = value;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r, j) =>
        server.close((error) => (error ? j(error) : r())),
      );
      f.close();
    },
  };
}

const confirmation = (r: any) => ({
  reviewId: r.id,
  confirmed: true,
  acknowledged: true,
});
async function createReview(f: Awaited<ReturnType<typeof fixture>>) {
  const state = await f.approve();
  return f.ok("/offers/prepare", {
    action: "create",
    permissionId: state.grants[0].id,
    expectedConsentRevision: state.revision,
  });
}
test("resume offer HTTP review is authenticated and does not allocate or disclose ciphertext until exact confirmation", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.call("/offers", undefined, { Authorization: "Bearer wrong" }))
        .status,
      401,
    );
    assert.equal(
      (
        await f.call("/offers", undefined, {
          Origin: "https://untrusted.invalid",
        })
      ).status,
      403,
    );
    const r = await createReview(f);
    assert.equal(r.action, "create");
    assert.equal(r.choices.taskId, f.task.id);
    assert.equal("envelope" in r, false);
    assert.equal(
      JSON.stringify(r).includes("SYNTHETIC_PRIVATE_RESUME_TASK"),
      false,
    );
    assert.deepEqual((await f.ok("/offers")).offers, []);
    const saved = await f.ok("/offers/confirm", confirmation(r));
    assert.equal(saved.offer.state, "ready");
    assert.ok(saved.envelope);
    const sender = await f.e.remote.withVerifiedDevice((scope) =>
        f.e.keys(scope.current).resolve(),
      ),
      recipient = await f.a.remote.withVerifiedDevice((scope) =>
        f.a.keys(scope.current).resolve(),
      );
    const opened = await openPrivateEnvelope(
      saved.envelope,
      saved.envelope.header,
      { senderPublicKey: sender.pair.publicKey, recipientKey: recipient.pair },
      f.clock,
    );
    try {
      const body = JSON.parse(new TextDecoder().decode(opened.plaintext));
      assert.equal(body.type, "task.resume.offer");
      assert.equal(body.permissionId, r.permissionId);
      assert.equal(body.modelDigest, "a".repeat(64));
    } finally {
      opened.plaintext.fill(0);
    }
    assert.equal(f.e.store.get(f.e.owner, f.task.id).status, "paused");
    assert.equal(
      (await f.call("/offers/confirm", confirmation(r))).status,
      400,
    );
    assert.equal((await f.ok("/offers")).offers.length, 1);
  } finally {
    await f.close();
  }
});
test("resume offer confirmation rechecks model and task revision with no offer allocation", async () => {
  const f = await fixture();
  try {
    const r = await createReview(f);
    f.setDigest("b".repeat(64));
    assert.equal(
      (await f.call("/offers/confirm", confirmation(r))).status,
      409,
    );
    assert.deepEqual((await f.ok("/offers")).offers, []);
    f.setDigest("a".repeat(64));
    const state = f.controls.resumePermissionStatus();
    const next = await f.ok("/offers/prepare", {
      action: "create",
      permissionId: state.grants[0]!.id,
      expectedConsentRevision: state.revision,
    });
    f.e.store.command(f.e.owner, f.task.id, {
      command: "resume",
      expectedRevision: f.task.revision,
    });
    assert.equal(
      (await f.call("/offers/confirm", confirmation(next))).status,
      409,
    );
    assert.deepEqual((await f.ok("/offers")).offers, []);
  } finally {
    await f.close();
  }
});
test("resume offer reveal keeps original ciphertext and reviewed stop cannot reveal it again", async () => {
  const f = await fixture();
  try {
    const created = await f.ok(
      "/offers/confirm",
      confirmation(await createReview(f)),
    );
    const request = {
      id: created.offer.id,
      expectedRevision: created.offer.revision,
    };
    const reveal = await f.ok("/offers/prepare", {
      action: "reveal",
      ...request,
    });
    const saved = await f.ok("/offers/confirm", confirmation(reveal));
    assert.deepEqual(saved.envelope, created.envelope);
    const stop = await f.ok("/offers/prepare", { action: "stop", ...request });
    const stopped = await f.ok("/offers/confirm", confirmation(stop));
    assert.equal(stopped.offer.state, "stopped");
    assert.equal(stopped.envelope, null);
    assert.equal(
      (
        await f.call("/offers/prepare", {
          action: "reveal",
          id: stopped.offer.id,
          expectedRevision: stopped.offer.revision,
        })
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});
test("permission review and key operations invalidate pending resume offer reviews", async () => {
  const f = await fixture();
  try {
    const r = await createReview(f);
    await f.ok("/prepare", f.request());
    assert.equal(
      (await f.call("/offers/confirm", confirmation(r))).status,
      400,
    );
    const state = f.controls.resumePermissionStatus();
    const next = await f.ok("/offers/prepare", {
      action: "create",
      permissionId: state.grants[0]!.id,
      expectedConsentRevision: state.revision,
    });
    f.controls.invalidate();
    assert.equal(
      (await f.call("/offers/confirm", confirmation(next))).status,
      400,
    );
    assert.deepEqual((await f.ok("/offers")).offers, []);
  } finally {
    await f.close();
  }
});
test("resume offer reviews expire and malformed acknowledgement never prepares content", async () => {
  const f = await fixture();
  try {
    const r = await createReview(f);
    assert.equal(
      (
        await f.call("/offers/confirm", {
          ...confirmation(r),
          acknowledged: false,
        })
      ).status,
      400,
    );
    assert.equal(
      (await f.call("/offers/confirm", confirmation(r))).status,
      400,
    );
    const state = f.controls.resumePermissionStatus();
    const next = await f.ok("/offers/prepare", {
      action: "create",
      permissionId: state.grants[0]!.id,
      expectedConsentRevision: state.revision,
    });
    f.advance(120001);
    assert.equal(
      (await f.call("/offers/confirm", confirmation(next))).status,
      400,
    );
    assert.deepEqual((await f.ok("/offers")).offers, []);
  } finally {
    await f.close();
  }
});
test("resume offer setup remains disabled without explicit activation", async () => {
  const f = await fixture(false);
  try {
    assert.equal((await f.ok("/offers")).canSetup, false);
    assert.equal(
      (
        await f.call("/offers/prepare", {
          action: "create",
          permissionId: randomUUID(),
          expectedConsentRevision: 1,
        })
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});

test("invalidating an in-flight model check prevents late resume offer confirmation", async () => {
  const f = await fixture();
  try {
    const review = await createReview(f);
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.pinHook(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          entered();
        }),
    );
    const pending = f.call("/offers/confirm", confirmation(review));
    await started;
    f.controls.invalidate();
    release();
    assert.equal((await pending).status, 400);
    assert.deepEqual((await f.ok("/offers")).offers, []);
  } finally {
    await f.close();
  }
});

test("saved resume offers can be stopped with remote setup disabled", async () => {
  const f = await fixture();
  try {
    const saved = await f.ok(
      "/offers/confirm",
      confirmation(await createReview(f)),
    );
    const offline = new CompanionPrivateKeys(
      f.e.store,
      f.e.vault,
      f.e.owner,
      f.e.entries,
      undefined,
      false,
      f.clock,
    );
    assert.equal(offline.resumeOfferStatus().canSetup, false);
    const review = await offline.prepareResumeOffer({
      action: "stop",
      id: saved.offer.id,
      expectedRevision: saved.offer.revision,
    });
    const result = await offline.confirmResumeOffer(confirmation(review));
    assert.equal(result.offer.state, "stopped");
    assert.equal(result.envelope, null);
    assert.equal(f.e.store.get(f.e.owner, f.task.id).status, "paused");
  } finally {
    await f.close();
  }
});
