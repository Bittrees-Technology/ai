import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { RemoteClient } from "../modules/remote/client.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { LocalWorker } from "../apps/companion/worker.js";
const owner = { userId: "local", tenantId: "personal" };
function fixture() {
  const now = Date.now();
  const store = new Store(":memory:", new Vault(randomBytes(32)), () => now);
  const task = store.create(
    owner,
    {
      conversationId: "c",
      kind: "query",
      prompt: "PRIVATE",
      modelProfileId: "p",
    },
    "key",
  );
  const grant = {
    deviceId: randomUUID(),
    ownerId: randomUUID(),
    epoch: 1,
    credential: randomBytes(32).toString("base64url"),
    expiresAt: now + 3600000,
    scope: "status:publish",
  };
  const control = {
    ...grant,
    credential: randomBytes(32).toString("base64url"),
    controlId: randomUUID(),
    scope: "controls:pause-cancel",
  };
  const identity = {
    ownerId: grant.ownerId,
    deviceId: grant.deviceId,
    epoch: grant.epoch,
    controlId: control.controlId,
  };
  const command = {
    id: randomUUID(),
    deviceId: grant.deviceId,
    taskId: task.id,
    command: "pause",
    expectedRevision: 1,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
  };
  let saved: Uint8Array | undefined = Buffer.from(
    JSON.stringify({
      localOwner: JSON.stringify(owner),
      grant,
      sequence: 1,
      mode: "active",
    }),
  );
  let fail = "",
    failWrite = 0,
    writes = 0,
    acknowledged = false,
    interrupts = 0;
  let heldPoll: Promise<void> | undefined;
  const calls: string[] = [];
  const secret = {
    getSecret: async () => saved,
    setSecret: async (bytes: Uint8Array) => {
      if (++writes === failWrite) throw Error("write failed");
      saved = Uint8Array.from(bytes);
    },
    deleteCredential: async () => {
      saved = undefined;
      return true;
    },
  };
  const transport: typeof fetch = async (url, init) => {
    const path = String(url).split("/device/")[1]!;
    calls.push(path);
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      "Bearer " +
        (path.startsWith("commands/") ? control.credential : grant.credential),
    );
    if (fail === path) throw Error("lost response");
    if (fail === "denied" && path.startsWith("commands/"))
      return Response.json({}, { status: 403 });
    if (path === "controls/enable") return Response.json(control);
    if (path === "controls/disable") return Response.json({ disabled: true });
    if (path === "commands/poll" && heldPoll) await heldPoll;
    if (path === "commands/poll")
      return Response.json({
        identity:
          fail === "wrong_identity"
            ? { ...identity, controlId: randomUUID() }
            : identity,
        commands: acknowledged ? [] : [command],
      });
    if (path === "commands/receipt") {
      const result = { duplicate: acknowledged };
      acknowledged = true;
      assert.equal(JSON.stringify(init?.body).includes("PRIVATE"), false);
      if (fail === "lost_ack") throw Error("receipt accepted, response lost");
      return Response.json(result);
    }
    if (path === "rotate")
      return Response.json({
        ...grant,
        epoch: 2,
        credential: randomBytes(32).toString("base64url"),
      });
    throw Error("unexpected route");
  };
  let interrupt = (_id: string) => {
    interrupts++;
  };
  const executor = {
    allow: (binding: unknown) => store.allowRemoteControls(owner, binding),
    allowed: (identity: unknown) =>
      store.remoteControlsAllowed(owner, identity),
    revoke: (id: string) => store.revokeRemoteControls(owner, id),
    execute: (identity: unknown, command: unknown) =>
      store.executeRemoteControl(owner, identity, command),
    interrupt: (id: string) => interrupt(id),
  };
  const client = () =>
    new RemoteClient(
      JSON.stringify(owner),
      secret,
      transport,
      () => now,
      executor,
    );
  return {
    now,
    store,
    task,
    grant,
    control,
    command,
    calls,
    client,
    executor,
    fail: (value: string) => {
      fail = value;
    },
    failWrite: (value: number) => {
      failWrite = value;
    },
    pending: () => {
      acknowledged = false;
    },
    interrupts: () => interrupts,
    interrupt: (fn: (id: string) => void) => {
      interrupt = fn;
    },
    delayPoll: () => {
      let release!: () => void;
      heldPoll = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    close: () => store.close(),
  };
}
test("Mac control permission survives reopen; response loss retries exact receipt without another task transition", async () => {
  const f = fixture();
  try {
    assert.equal((await f.client().status())?.controls, "disabled");
    assert.equal(f.calls.length, 0);
    await assert.rejects(
      f.client().pollControls(),
      /CONTROL_CONFIRMATION_REQUIRED/,
    );
    await f.client().enableControls();
    assert.equal((await f.client().status())?.controls, "enabled");
    f.fail("lost_ack");
    await assert.rejects(f.client().pollControls(), /UNAVAILABLE/);
    const revision = f.store.get(owner, f.task.id).revision;
    assert.equal(f.store.get(owner, f.task.id).status, "paused");
    f.fail("");
    f.pending();
    assert.equal(
      (await f.client().pollControls()).receipts[0]!.outcome,
      "applied",
    );
    assert.equal(f.store.get(owner, f.task.id).revision, revision);
    assert.equal(f.interrupts(), 1);
    assert.equal(f.store.exportRemoteControls(owner).length, 1);
  } finally {
    f.close();
  }
});
test("lost enablement and final Keychain write failure never grant silent control after reopening", async () => {
  for (const failure of ["network", "storage"]) {
    const f = fixture();
    try {
      if (failure === "network") f.fail("controls/enable");
      else f.failWrite(3);
      await assert.rejects(f.client().enableControls(), /UNAVAILABLE/);
      assert.equal(
        (await f.client().status())?.controls,
        "confirmation_required",
      );
      const count = f.calls.length;
      await assert.rejects(
        f.client().pollControls(),
        /CONTROL_CONFIRMATION_REQUIRED/,
      );
      await assert.rejects(
        f.client().enableControls(),
        /CONTROL_CONFIRMATION_REQUIRED/,
      );
      assert.equal(f.calls.length, count);
      f.fail("");
      f.failWrite(0);
      assert.equal((await f.client().disableControls()).remoteConfirmed, true);
      await f.client().enableControls();
      assert.equal((await f.client().status())?.controls, "enabled");
    } finally {
      f.close();
    }
  }
});
test("disable failure, rotation, local removal and data deletion revoke local permission", async () => {
  for (const action of ["disable", "rotate", "forget", "delete"]) {
    const f = fixture();
    try {
      await f.client().enableControls();
      const identity = {
        remoteOwnerId: f.grant.ownerId,
        deviceId: f.grant.deviceId,
        epoch: 1,
        controlId: f.control.controlId,
      };
      assert.equal(f.executor.allowed(identity), true);
      if (action === "disable") {
        f.fail("controls/disable");
        await assert.rejects(f.client().disableControls(), /UNAVAILABLE/);
      }
      if (action === "rotate") await f.client().rotate();
      if (action === "forget") await f.client().forgetLocal();
      if (action === "delete")
        await f.client().clearTaskData(() => f.store.deleteAll(owner));
      assert.equal(f.executor.allowed(identity), false);
      await assert.rejects(
        f.client().pollControls(),
        /CONTROL_CONFIRMATION_REQUIRED|PAIRING_REQUIRED/,
      );
    } finally {
      f.close();
    }
  }
});
test("wrong permission identity is rejected before execution; remote denial revokes locally; restored consent is not recreated", async () => {
  const f = fixture();
  try {
    await f.client().enableControls();
    f.fail("wrong_identity");
    await assert.rejects(f.client().pollControls(), /INVALID_RESPONSE/);
    assert.equal(f.store.get(owner, f.task.id).revision, 1);
    f.fail("denied");
    await assert.rejects(f.client().pollControls(), /DENIED/);
    assert.equal(
      (await f.client().status())?.controls,
      "confirmation_required",
    );
    f.fail("");
    await f.client().disableControls();
    await f.client().enableControls();
    f.store.revokeRemoteControls(owner, f.grant.deviceId);
    const count = f.calls.length;
    assert.equal(
      (await f.client().status())?.controls,
      "confirmation_required",
    );
    await assert.rejects(
      f.client().pollControls(),
      /CONTROL_CONFIRMATION_REQUIRED/,
    );
    assert.equal(f.calls.length, count);
  } finally {
    f.close();
  }
});
test("delivered pause interrupts the active worker and blocks its late output", async () => {
  const f = fixture();
  const profile = {
    id: "p",
    runtime: "ollama" as const,
    model: "local",
    contextTokens: 2048,
    maxOutputTokens: 100,
    temperature: 0.2,
  };
  let begin!: () => void, finish!: (text: string) => void;
  const started = new Promise<void>((resolve) => {
    begin = resolve;
  });
  let signal: AbortSignal | undefined;
  const worker = new LocalWorker(
    f.store,
    owner,
    {
      pin: async () => ({ profile, digest: "a".repeat(64) }),
      generate: async (_p, _messages, received) => {
        signal = received;
        begin();
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      },
    },
    () => profile,
  );
  let running: Promise<boolean> | undefined;
  try {
    await f.client().enableControls();
    f.interrupt((id) => worker.cancel(id));
    running = worker.runOnce();
    await started;
    f.command.expectedRevision = f.store.get(owner, f.task.id).revision;
    await f.client().pollControls();
    assert.equal(signal?.aborted, true);
    finish("LATE PRIVATE OUTPUT");
    await running;
    running = undefined;
    assert.equal(f.store.get(owner, f.task.id).status, "paused");
    assert.equal(f.store.get(owner, f.task.id).result, null);
  } finally {
    if (running) {
      finish("cleanup");
      await running;
    }
    f.close();
  }
});

test("Background receiving is a separate saved opt-in and aborted checks cannot execute", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.client().setReceiving(true),
      /CONTROL_CONFIRMATION_REQUIRED/,
    );
    await f.client().enableControls();
    assert.equal((await f.client().status())?.backgroundReceiving, false);
    await f.client().setReceiving(true);
    assert.equal((await f.client().status())?.backgroundReceiving, true);
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(f.client().pollControls(stop.signal));
    assert.equal(f.store.get(owner, f.task.id).revision, 1);
    await f.client().setReceiving(false);
    assert.equal((await f.client().status())?.backgroundReceiving, false);
    await f.client().setReceiving(true);
    await f.client().rotate();
    assert.equal((await f.client().status())?.backgroundReceiving, false);
  } finally {
    f.close();
  }
});

test("A delayed response arriving after stop cannot execute even when transport ignores cancellation", async () => {
  const f = fixture();
  try {
    const client = f.client();
    await client.enableControls();
    const release = f.delayPoll(),
      stop = new AbortController();
    const checking = client.pollControls(stop.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(f.calls.includes("commands/poll"));
    stop.abort();
    release();
    await assert.rejects(checking);
    assert.equal(f.store.get(owner, f.task.id).revision, 1);
    assert.equal(f.calls.includes("commands/receipt"), false);
  } finally {
    f.close();
  }
});

test("Failed persistence of a stop revokes local consent so reopen cannot resume receiving", async () => {
  const f = fixture();
  try {
    await f.client().enableControls();
    await f.client().setReceiving(true);
    f.failWrite(5);
    await assert.rejects(f.client().setReceiving(false), /STORAGE_UNAVAILABLE/);
    assert.equal(
      (await f.client().status())?.controls,
      "confirmation_required",
    );
    await assert.rejects(
      f.client().pollControls(),
      /CONTROL_CONFIRMATION_REQUIRED/,
    );
  } finally {
    f.close();
  }
});
