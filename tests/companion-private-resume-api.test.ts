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
async function fixture(enabled = true) {
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
test("authenticated private resume review pins the local model and creates no grant before explicit confirmation", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.ok()).canSetup, true);
    const r = await f.ok("/prepare", f.request());
    assert.equal(r.choices.modelDigest, "a".repeat(64));
    assert.equal(
      JSON.stringify(r).includes("SYNTHETIC_PRIVATE_RESUME_TASK"),
      false,
    );
    assert.deepEqual(f.e.store.remoteResumes.history(f.e.owner), []);
    r.choices.modelDigest = "b".repeat(64);
    const approved = await f.ok("/confirm", {
      reviewId: r.id,
      confirmed: true,
      acknowledged: true,
    });
    assert.equal(approved.grants[0].choices.modelDigest, "a".repeat(64));
    assert.equal(
      f.e.store.remoteResumes.history(f.e.owner)[0]!.permission!.approval
        .privatePeerBound,
      true,
    );
    assert.equal(
      (
        await f.call("/confirm", {
          reviewId: r.id,
          confirmed: true,
          acknowledged: true,
        })
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});
test("private resume API denies missing identity, foreign origin, caller digest and disabled configuration", async () => {
  const f = await fixture(false);
  try {
    assert.equal((await f.ok()).canSetup, false);
    for (const headers of [
      { Authorization: "Bearer invalid" },
      { Origin: "https://foreign.example" },
    ])
      assert.equal(
        (await f.call("/prepare", f.request(), headers)).status,
        "Origin" in headers ? 403 : 401,
      );
    assert.equal((await f.call("/prepare", f.request())).status, 400);
    assert.equal(
      (
        await f.call("/prepare", {
          ...f.request(),
          modelDigest: "a".repeat(64),
        })
      ).status,
      400,
    );
    assert.deepEqual(f.e.store.remoteResumes.history(f.e.owner), []);
  } finally {
    await f.close();
  }
});
test("private resume confirmation rejects changed local model and cross-panel review invalidation", async () => {
  const f = await fixture();
  try {
    const r = await f.ok("/prepare", f.request());
    f.setDigest("b".repeat(64));
    assert.equal(
      (
        await f.call("/confirm", {
          reviewId: r.id,
          confirmed: true,
          acknowledged: true,
        })
      ).status,
      409,
    );
    f.setDigest("a".repeat(64));
    const next = await f.ok("/prepare", f.request());
    await f.controls.prepare({
      action: "replace",
      expectedRevision: f.controls.status().state.revision,
    });
    assert.equal(
      (
        await f.call("/confirm", {
          reviewId: next.id,
          confirmed: true,
          acknowledged: true,
        })
      ).status,
      400,
    );
    assert.deepEqual(f.e.store.remoteResumes.history(f.e.owner), []);
  } finally {
    await f.close();
  }
});
test("private resume model review uses shared native lock and host invalidation fences pending work", async () => {
  const f = await fixture();
  try {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      started = new Promise<void>((r) => {
        entered = r;
      });
    f.pinHook(async () => {
      entered();
      await gate;
    });
    const pending = f.controls.prepareResumePermission(f.request());
    await started;
    await assert.rejects(
      f.controls.prepare({
        action: "replace",
        expectedRevision: f.controls.status().state.revision,
      }),
      /BUSY/,
    );
    f.controls.invalidate();
    release();
    await assert.rejects(pending, /DENIED/);
    assert.deepEqual(f.e.store.remoteResumes.history(f.e.owner), []);
  } finally {
    await f.close();
  }
});
test("authenticated local resume API opens peer ciphertext and returns one original encrypted receipt", async () => {
  const f = await fixture();
  try {
    const saved = await f.approve(),
      permissionId = saved.grants[0].id;
    const key = await f.e.remote.withVerifiedDevice(async (scope) =>
      f.e.keys(scope.current).resolve(),
    );
    const sender = await f.a.remote.withVerifiedDevice(async (scope) =>
      f.a.keys(scope.current).resolve(),
    );
    const now = f.clock(),
      cmd = {
        version: 1,
        id: randomUUID(),
        deviceId: f.e.grant.deviceId,
        permissionId,
        taskId: f.task.id,
        expectedRevision: f.task.revision,
        command: "resume",
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60000).toISOString(),
      };
    const h = {
      version: 1,
      suite: privateEnvelopeSuite,
      ownerId: f.e.grant.ownerId,
      senderId: f.a.grant.deviceId,
      recipientId: f.e.grant.deviceId,
      senderKeyEpoch: sender.proof.keyEpoch,
      recipientKeyEpoch: key.proof.keyEpoch,
      messageId: randomUUID(),
      operationId: cmd.id,
      sequence: 900,
      issuedAt: now,
      expiresAt: now + 60000,
    };
    const envelope = await sealPrivateEnvelope(
      h,
      new TextEncoder().encode(
        JSON.stringify({ version: 1, type: "task.resume", command: cmd }),
      ),
      { senderKey: sender.pair, recipientPublicKey: key.pair.publicKey },
      f.clock,
    );
    const input = { permissionId, envelope, confirmed: true };
    const accepted = await f.ok("/receive", input),
      duplicate = await f.ok("/receive", input);
    assert.equal(accepted.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(accepted.receipt, duplicate.receipt);
    assert.equal(f.e.store.get(f.e.owner, f.task.id).status, "queued");
    const receipt = await f.ok("/receipt", {
      permissionId,
      commandId: cmd.id,
      confirmed: true,
    });
    assert.deepEqual(
      await f.ok("/receipt", {
        permissionId,
        commandId: cmd.id,
        confirmed: true,
      }),
      receipt,
    );
    const opened = await openPrivateEnvelope(
      receipt,
      receipt.header,
      { recipientKey: sender.pair, senderPublicKey: key.pair.publicKey },
      f.clock,
    );
    try {
      assert.deepEqual(
        JSON.parse(new TextDecoder().decode(opened.plaintext)).receipt,
        accepted.receipt,
      );
    } finally {
      opened.plaintext.fill(0);
    }
  } finally {
    await f.close();
  }
});
