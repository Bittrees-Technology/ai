import { RemoteTemplateReceiver } from "../modules/remote/template-receiver.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { RemoteClient } from "../modules/remote/client.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { localApi } from "../apps/companion/http.js";
const owner = { userId: "local", tenantId: "personal" };
function fixture() {
  let now = Date.now(),
    fail = "",
    writes = 0,
    failWrite = 0,
    acknowledged = false;
  let held: Promise<void> | undefined;
  const store = new Store(":memory:", new Vault(randomBytes(32)), () => now);
  store.addProfile(owner, {
    id: "p",
    runtime: "ollama",
    model: "local",
    contextTokens: 4096,
    maxOutputTokens: 1024,
    temperature: 0.2,
  });
  const template = store.saveTemplate(owner, {
    id: randomUUID(),
    expectedRevision: 0,
    confirmed: true,
    definition: {
      name: "PRIVATE_NAME",
      prompt: "PRIVATE_PROMPT",
      kind: "query",
      modelProfileId: "p",
    },
  });
  let grant = {
    ownerId: randomUUID(),
    deviceId: randomUUID(),
    epoch: 1,
    credential: randomBytes(32).toString("base64url"),
    expiresAt: now + 3600000,
    scope: "status:publish",
  };
  let saved: Uint8Array | undefined = Buffer.from(
    JSON.stringify({
      localOwner: JSON.stringify(owner),
      grant,
      mode: "active",
      sequence: 1,
    }),
  );
  let command: any, publication: any;
  const calls: { path: string; body: any }[] = [];
  const state = () => JSON.parse(Buffer.from(saved!).toString("utf8"));
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
  const executor = {
    approve: (raw: unknown) => store.remoteTemplates.approve(owner, raw),
    allowed: (raw: unknown) => store.remoteTemplates.allowed(owner, raw),
    revoke: (deviceId: string, templateId?: string) => {
      store.remoteTemplates.revoke(owner, deviceId, templateId);
    },
    execute: (identity: unknown, raw: unknown) =>
      store.remoteTemplates.execute(owner, identity, raw),
  };
  const transport: typeof fetch = async (url, init) => {
    const path = String(url).split("/device/")[1]!,
      body = JSON.parse(String(init?.body));
    calls.push({ path, body });
    assert.ok(String(url).startsWith("https://ai.bittrees.org/device/"));
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    const entry = state().templates?.[0];
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      "Bearer " +
        (path === "templates/poll" || path === "templates/receipt"
          ? entry.credential
          : grant.credential),
    );
    if (fail === "denied")
      return Response.json({ error: "DENIED" }, { status: 403 });
    if (path === "templates/publish") {
      assert.equal(entry.mode, "publication_pending");
      assert.equal(
        body.credentialHash,
        createHash("sha256").update(entry.credential).digest("hex"),
      );
      const duplicate = !!publication;
      publication = body;
      if (fail === path) throw Error("accepted, response lost");
      const {
        credentialHash: _hash,
        confirmed: _confirmed,
        ...metadata
      } = body;
      return Response.json({
        template: { ...metadata, deviceId: grant.deviceId, submittedRuns: 0 },
        duplicate,
      });
    }
    if (path === "templates/poll") {
      if (held) await held;
      const identity = entry.approval.identity;
      return Response.json({
        identity: fail === "identity" ? { ...identity, epoch: 2 } : identity,
        commands: acknowledged || !command ? [] : [command],
      });
    }
    if (path === "templates/receipt") {
      acknowledged = true;
      if (fail === path) throw Error("accepted, receipt response lost");
      return Response.json({ receipt: body, duplicate: false });
    }
    if (path === "templates/revoke") {
      if (fail === path) throw Error("offline");
      return Response.json({ revoked: true });
    }
    if (path === "rotate") {
      grant = {
        ...grant,
        epoch: 2,
        credential: randomBytes(32).toString("base64url"),
      };
      return Response.json(grant);
    }
    throw Error("Unexpected request");
  };
  const client = () =>
    new RemoteClient(
      JSON.stringify(owner),
      secret,
      transport,
      () => now,
      undefined,
      executor,
    );
  return {
    store,
    template,
    calls,
    client,
    state,
    get saved() {
      return saved;
    },
    get grant() {
      return grant;
    },
    get now() {
      return now;
    },
    setTime: (n: number) => {
      now = n;
    },
    fail: (value: string) => {
      fail = value;
    },
    failNextWrite: (offset = 1) => {
      failWrite = writes + offset;
    },
    hold: (promise: Promise<void>) => {
      held = promise;
    },
    share: () => ({
      expectedConnection: {
        ownerId: grant.ownerId,
        deviceId: grant.deviceId,
        epoch: grant.epoch,
      },
      templateId: template.id,
      expectedRevision: 1,
      maxRuns: 2,
      expiresAt: now + 600000,
      confirmed: true,
    }),
    queue: () => {
      const a = state().templates[0].approval;
      command = {
        id: randomUUID(),
        deviceId: grant.deviceId,
        templateId: a.templateId,
        templateRevision: a.templateRevision,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60000).toISOString(),
      };
      return command;
    },
    permission: () => state().templates[0].approval.identity.permissionId,
    rePair: (change: Partial<typeof grant>) => {
      grant = { ...grant, ...change };
      const next = state();
      next.grant = grant;
      saved = Buffer.from(JSON.stringify(next));
    },
  };
}
test("template client persists before publishing and recovers lost acknowledgements after lease expiry without duplicate tasks", async () => {
  const f = fixture();
  try {
    f.fail("templates/publish");
    await assert.rejects(f.client().shareTemplate(f.share()), /UNAVAILABLE/);
    assert.equal(f.state().templates[0].mode, "publication_pending");
    const id = f.permission();
    f.fail("");
    await f.client().retryTemplatePublication(id);
    assert.equal((await f.client().status())?.templates[0]?.state, "active");
    const command = f.queue();
    f.fail("templates/receipt");
    await assert.rejects(f.client().pollTemplate(id), /UNAVAILABLE/);
    assert.equal(f.state().templates[0].pendingCommand.id, command.id);
    const task = f.store.list(owner)[0]!;
    assert.equal(task.input.prompt, "PRIVATE_PROMPT");
    f.setTime(f.now + 61000);
    f.fail("");
    const retried = await f.client().pollTemplate(id);
    assert.equal(retried.receipts[0]?.taskId, task.id);
    assert.equal(f.store.list(owner).length, 1);
    assert.equal(f.state().templates[0].pendingCommand, undefined);
    assert.equal(
      f.store.remoteTemplates.export(owner).permissions[0]?.remaining,
      1,
    );
    assert.equal(JSON.stringify(f.calls).includes("PRIVATE"), false);
    assert.equal(
      JSON.stringify(await f.client().status()).includes(
        f.state().templates[0].credential,
      ),
      false,
    );
  } finally {
    f.store.close();
  }
});
test("template credential-write failures revoke permission before any uncertain restart can execute", async () => {
  for (const offset of [1, 2]) {
    const f = fixture();
    try {
      f.failNextWrite(offset);
      await assert.rejects(
        f.client().shareTemplate(f.share()),
        /STORAGE_UNAVAILABLE/,
      );
      assert.equal(f.store.remoteTemplates.export(owner).permissions.length, 0);
      if (offset === 1) assert.equal(f.calls.length, 0);
      else {
        const id = f.permission();
        assert.equal(
          (await f.client().status())?.templates[0]?.state,
          "confirmation_required",
        );
        await assert.rejects(
          f.client().retryTemplatePublication(id),
          /TEMPLATE_CONFIRMATION_REQUIRED/,
        );
      }
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    await f.client().shareTemplate(f.share());
    f.queue();
    f.failNextWrite();
    await assert.rejects(
      f.client().pollTemplate(f.permission()),
      /STORAGE_UNAVAILABLE/,
    );
    assert.equal(f.store.list(owner).length, 0);
    assert.equal(f.store.remoteTemplates.export(owner).permissions.length, 0);
  } finally {
    f.store.close();
  }
});
test("template edit, remote denial and local-first revoke prevent further delivery", async () => {
  const f = fixture();
  try {
    await f.client().shareTemplate(f.share());
    const id = f.permission();
    f.queue();
    await f.client().pollTemplate(id);
    const task = f.store.list(owner)[0]!;
    f.fail("templates/revoke");
    await assert.rejects(f.client().revokeTemplate(id), /UNAVAILABLE/);
    assert.equal(f.store.get(owner, task.id).status, "cancelled");
    assert.equal(f.state().templates[0].mode, "revoke_pending");
    await assert.rejects(
      f.client().pollTemplate(id),
      /TEMPLATE_CONFIRMATION_REQUIRED/,
    );
    f.fail("");
    await f.client().revokeTemplate(id);
    assert.deepEqual(f.state().templates, []);
    await f.client().shareTemplate(f.share());
    f.fail("denied");
    await assert.rejects(f.client().pollTemplate(f.permission()), /DENIED/);
    assert.equal(f.store.remoteTemplates.export(owner).permissions.length, 0);
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    await g.client().shareTemplate(g.share());
    const id = g.permission();
    g.store.saveTemplate(owner, {
      id: g.template.id,
      expectedRevision: 1,
      confirmed: true,
      definition: { ...g.template.definition, prompt: "changed" },
    });
    await assert.rejects(
      g.client().pollTemplate(id),
      /TEMPLATE_CONFIRMATION_REQUIRED/,
    );
    assert.equal(g.calls.filter((c) => c.path === "templates/poll").length, 0);
  } finally {
    g.store.close();
  }
});
test("template delivery rejects mismatched identities and aborts delayed responses before execution", async () => {
  const f = fixture();
  try {
    await f.client().shareTemplate(f.share());
    const id = f.permission();
    f.queue();
    f.fail("identity");
    await assert.rejects(f.client().pollTemplate(id), /INVALID_RESPONSE/);
    assert.equal(f.store.list(owner).length, 0);
    f.fail("");
    let release!: () => void;
    f.hold(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const abort = new AbortController(),
      client = f.client(),
      pending = client.pollTemplate(id, abort.signal);
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(client.rotate(), /BUSY/);
    abort.abort();
    release();
    await assert.rejects(pending);
    assert.equal(f.store.list(owner).length, 0);
    assert.equal(f.state().templates[0].pendingCommand, undefined);
  } finally {
    f.store.close();
  }
});
test("rotation, local removal and full task deletion revoke template permission before changing saved state", async () => {
  for (const action of ["rotate", "forget", "delete"]) {
    const f = fixture();
    try {
      const client = f.client();
      await client.shareTemplate(f.share());
      f.queue();
      await client.pollTemplate(f.permission());
      if (action === "rotate") await client.rotate();
      if (action === "forget") await client.forgetLocal();
      if (action === "delete")
        await client.clearTaskData(() => f.store.deleteAll(owner));
      assert.equal(f.store.remoteTemplates.export(owner).permissions.length, 0);
      if (action !== "delete")
        assert.equal(f.store.list(owner)[0]!.status, "cancelled");
      if (action === "forget") assert.equal(f.saved, undefined);
      if (action === "rotate") assert.equal(f.state().templates, undefined);
    } finally {
      f.store.close();
    }
  }
});
test("authenticated local template routes require review and use the fixed local owner", async () => {
  const f = fixture(),
    server = createServer(),
    token = randomBytes(32).toString("hex");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const remote = f.client();
  const templateReceiver = new RemoteTemplateReceiver(remote, () => ({
    cancel() {},
  }));
  server.on(
    "request",
    localApi({ store: f.store, owner, token, port, remote, templateReceiver }),
  );
  const headers = {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    url = `http://127.0.0.1:${port}`;
  const call = (path: string, body: unknown) =>
    fetch(url + path, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    assert.equal(
      (
        await fetch(url + "/v1/remote/templates/share", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(f.share()),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await call("/v1/remote/templates/share", {
          ...f.share(),
          confirmed: false,
        })
      ).status,
      400,
    );
    assert.equal(
      (await call("/v1/remote/templates/share", { ...f.share(), identity: {} }))
        .status,
      400,
    );
    assert.equal(
      (
        await call("/v1/remote/templates/share", {
          ...f.share(),
          templateId: randomUUID(),
        })
      ).status,
      404,
    );
    assert.equal(
      (await call("/v1/remote/templates/share", f.share())).status,
      200,
    );
    const receiving = {
      permissionId: f.permission(),
      enabled: true,
      confirmed: true,
    };
    assert.equal(
      (
        await call("/v1/remote/templates/receiving", {
          ...receiving,
          confirmed: false,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call("/v1/remote/templates/receiving", {
          ...receiving,
          permissionId: randomUUID(),
        })
      ).status,
      400,
    );
    assert.equal(
      (await call("/v1/remote/templates/receiving", receiving)).status,
      200,
    );
    assert.equal(
      (await remote.status())!.templates[0]!.backgroundReceiving,
      true,
    );
    assert.equal(
      (
        await call("/v1/remote/templates/receiving", {
          ...receiving,
          enabled: false,
        })
      ).status,
      200,
    );
    assert.equal(
      (await remote.status())!.templates[0]!.backgroundReceiving,
      false,
    );
    f.queue();
    const body = { permissionId: f.permission(), confirmed: true };
    assert.equal(
      (await call("/v1/remote/templates/check", { ...body, confirmed: false }))
        .status,
      400,
    );
    const checked = await call("/v1/remote/templates/check", body);
    assert.equal(checked.status, 200);
    assert.equal((await checked.json()).receipts[0].outcome, "queued");
    assert.equal((await call("/v1/remote/templates/revoke", body)).status, 200);
  } finally {
    await templateReceiver.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.store.close();
  }
});

test("template background preference requires live permission, survives reopen and fails closed on opt-out write failure", async () => {
  const f = fixture();
  try {
    await f.client().shareTemplate(f.share());
    const id = f.permission();
    assert.equal(
      (await f.client().status())!.templates[0]!.backgroundReceiving,
      false,
    );
    const before = f.calls.length;
    await f.client().setTemplateReceiving(id, true);
    assert.equal(f.calls.length, before);
    assert.equal(
      (await f.client().status())!.templates[0]!.backgroundReceiving,
      true,
    );
    f.failNextWrite();
    await assert.rejects(f.client().setTemplateReceiving(id, false));
    assert.equal(
      (await f.client().status())!.templates[0]!.state,
      "confirmation_required",
    );
    await assert.rejects(f.client().pollTemplate(id), /CONFIRMATION/);
    await assert.rejects(
      f.client().setTemplateReceiving(id, true),
      /CONFIRMATION/,
    );
    assert.equal(f.calls.length, before);
  } finally {
    f.store.close();
  }
});
test("expired and unpublished template permissions cannot enable background receiving", async () => {
  const f = fixture();
  try {
    f.fail("templates/publish");
    await assert.rejects(f.client().shareTemplate(f.share()));
    await assert.rejects(
      f.client().setTemplateReceiving(f.permission(), true),
      /CONFIRMATION/,
    );
    f.fail("");
    await f.client().retryTemplatePublication(f.permission());
    f.setTime(f.now + 600001);
    await assert.rejects(
      f.client().setTemplateReceiving(f.permission(), true),
      /CONFIRMATION/,
    );
    await f.client().setTemplateReceiving(f.permission(), false);
    assert.equal(
      (await f.client().status())!.templates[0]!.backgroundReceiving,
      false,
    );
  } finally {
    f.store.close();
  }
});

test("template sharing rejects changed account, device or credential epoch before any local approval or upload", async () => {
  for (const change of [
    { ownerId: randomUUID() },
    { deviceId: randomUUID() },
    { epoch: 2 },
  ]) {
    const f = fixture();
    try {
      const reviewed = f.share();
      f.rePair(change);
      const before = Buffer.from(f.saved!);
      await assert.rejects(
        f.client().shareTemplate(reviewed),
        /TEMPLATE_CONFIRMATION_REQUIRED/,
      );
      assert.deepEqual(Buffer.from(f.saved!), before);
      assert.equal(f.calls.length, 0);
      assert.equal(f.store.remoteTemplates.export(owner).permissions.length, 0);
      await f.client().shareTemplate(f.share());
      assert.equal(f.calls.length, 1);
    } finally {
      f.store.close();
    }
  }
});
test("reviewed template connection cannot survive actual credential rotation or omit its binding", async () => {
  const f = fixture();
  try {
    const reviewed = f.share();
    await f.client().rotate();
    const before = f.calls.length;
    await assert.rejects(
      f.client().shareTemplate(reviewed),
      /TEMPLATE_CONFIRMATION_REQUIRED/,
    );
    const { expectedConnection: _binding, ...missing } = f.share();
    await assert.rejects(f.client().shareTemplate(missing));
    assert.equal(f.calls.length, before);
    await f.client().shareTemplate(f.share());
    assert.equal((await f.client().status())!.epoch, 2);
  } finally {
    f.store.close();
  }
});
