import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TemplateController } from "../apps/dashboard/template-state.js";
const { RemoteWebController } = await import(
  new URL("../apps/remote-web/controller.js", import.meta.url).href
);
function fixture() {
  const template = {
    id: randomUUID(),
    revision: 2,
    definition: {
      name: "Private name",
      kind: "query" as const,
      prompt: "Private prompt",
      modelProfileId: randomUUID(),
    },
  };
  const connection = {
    deviceId: randomUUID(),
    ownerId: randomUUID(),
    expiresAt: Date.now() + 180000,
    state: "paired",
    templates: [] as any[],
  };
  const permission = {
    permissionId: randomUUID(),
    deviceId: connection.deviceId,
    templateId: template.id,
    templateRevision: 2,
    approvedAt: Date.now() - 1000,
    expiresAt: connection.expiresAt,
    maxRuns: 2,
    submittedRuns: 0,
  };
  return { template, connection, permission };
}
test("Mac remote template review sends only fixed metadata after separate confirmation", async () => {
  const { template, connection } = fixture(),
    calls: any[] = [];
  const c = new TemplateController(async (path, method, body) => {
    calls.push({ path, method, body: structuredClone(body) });
    return path === "/v1/remote" ? { available: true, connection } : connection;
  });
  c.items = [template];
  c.select(template);
  await c.refreshRemote();
  assert.equal(calls.length, 1);
  for (const limits of [
    [0, 60],
    [21, 60],
    [1, 1441],
    [1.5, 60],
  ])
    assert.throws(() => c.reviewRemote(...(limits as [number, number])));
  c.reviewRemote(2, 60);
  assert.equal(c.remoteReview!.expiresAt, connection.expiresAt);
  c.confirm(true);
  await assert.rejects(c.shareRemote(), /CONFIRMATION/);
  c.confirmRemote(true);
  await c.shareRemote();
  assert.deepEqual(calls[1].body, {
    templateId: template.id,
    expectedRevision: 2,
    maxRuns: 2,
    expiresAt: connection.expiresAt,
    confirmed: true,
  });
  assert.equal(c.remoteReview, null);
  assert.match(c.notice, /Background template receiving is off/);
});
test("Mac template edits and focus loss invalidate reviews and suppress late responses", async () => {
  const { template, connection } = fixture();
  let resolve!: (v: any) => void;
  const c = new TemplateController(
    async () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  c.items = [template];
  c.select(template);
  c.remote = { available: true, connection };
  c.reviewRemote(1, 1);
  c.confirmRemote(true);
  c.edit({ prompt: "changed" });
  assert.equal(c.remoteReview, null);
  await assert.rejects(c.shareRemote());
  c.select(template);
  c.reviewRemote(1, 1);
  c.confirmRemote(true);
  const sharing = c.shareRemote();
  c.hide();
  resolve(connection);
  await sharing;
  assert.equal(c.remote, null);
  assert.equal(c.draft, null);
  assert.equal(c.notice, "");
});
test("Mac template management requires a reviewed permission and separate action confirmation", async () => {
  const { connection, permission } = fixture(),
    calls: any[] = [];
  connection.templates = [
    { ...permission, state: "publication_pending", pendingDelivery: false },
  ];
  const c = new TemplateController(async (path, method, body) => {
    calls.push({ path, body });
    return path === "/v1/remote"
      ? { available: true, connection }
      : { receipts: [] };
  });
  c.remote = { available: true, connection };
  c.reviewRemoteAction(permission.permissionId, "check");
  assert.equal(c.remoteAction, null);
  c.reviewRemoteAction(permission.permissionId, "retry");
  await c.applyRemoteAction(false);
  assert.equal(calls.length, 0);
  await c.applyRemoteAction(true);
  assert.deepEqual(calls[0], {
    path: "/v1/remote/templates/retry",
    body: { permissionId: permission.permissionId, confirmed: true },
  });
  c.reviewRemoteAction(permission.permissionId, "revoke");
  c.hide();
  await c.applyRemoteAction(true);
  assert.equal(calls.length, 2);
});
function web(api: any, connection: any) {
  const c = new RemoteWebController(api, null, { chainId: 1 }, () => {});
  c.set({
    account: { ownerId: connection.ownerId },
    devices: [
      {
        id: connection.deviceId,
        expiresAt: connection.expiresAt,
        revoked: false,
      },
    ],
  });
  return c;
}
test("Remote template requests use a fixed reviewed intent across lost responses", async () => {
  const { connection, permission } = fixture(),
    calls: any[] = [];
  let fail = true;
  const c = web(async (path: string, body: any) => {
    calls.push({ path, body: structuredClone(body) });
    if (path === "/browser/templates")
      return { items: [permission], nextCursor: null };
    if (path === "/browser/templates/run" && fail) {
      fail = false;
      throw Error("UNAVAILABLE");
    }
    if (path.endsWith("receipt"))
      return {
        state: "received",
        receipt: { outcome: "queued", taskId: randomUUID() },
      };
    return {};
  }, connection);
  await c.templates(randomUUID());
  assert.equal(calls.length, 0);
  await c.templates(connection.deviceId);
  c.reviewTemplate(randomUUID());
  assert.equal(c.state.templateReview, null);
  c.reviewTemplate(permission.permissionId);
  const intent = structuredClone(c.state.templateReview.intent);
  assert.equal(intent.command.templateRevision, 2);
  assert.ok(Date.parse(intent.command.expiresAt) <= permission.expiresAt);
  await c.submitTemplate(false);
  assert.equal(calls.length, 1);
  await c.submitTemplate(true);
  assert.deepEqual(c.state.templateReview.intent, intent);
  await c.submitTemplate(true);
  assert.deepEqual(calls[1].body, calls[2].body);
  assert.deepEqual(Object.keys(calls[2].body).sort(), [
    "command",
    "confirmed",
    "permissionId",
  ]);
  assert.equal(c.state.templateReview, null);
  assert.equal(c.state.templateResult.state, "pending");
  await c.templateReceipt();
  assert.equal(c.state.templateResult.receipt.outcome, "queued");
  assert.match(c.state.notice, /^$/);
});
test("Remote template catalogue pagination, bounds and revocation preserve review requirements", async () => {
  const { connection, permission } = fixture(),
    calls: any[] = [],
    next = randomUUID();
  const c = web(async (path: string, body: any) => {
    calls.push({ path, body });
    return {
      items: body.after
        ? [{ ...permission, permissionId: next, submittedRuns: 2 }]
        : [permission],
      nextCursor: body.after ? null : permission.permissionId,
    };
  }, connection);
  await c.templates(connection.deviceId);
  await c.templates(connection.deviceId, true);
  assert.equal(calls[1].body.after, permission.permissionId);
  assert.equal(c.state.templates.length, 2);
  c.reviewTemplate(next);
  assert.equal(c.state.templateReview, null);
  c.reviewTemplate(permission.permissionId, "revoke");
  await c.submitTemplate(false);
  assert.equal(calls.length, 2);
  await c.submitTemplate(true);
  assert.deepEqual(calls[2], {
    path: "/browser/templates/revoke",
    body: { permissionId: permission.permissionId, confirmed: true },
  });
  assert.equal(c.state.templates.length, 1);
  c.state.templates[0].expiresAt = 0;
  c.reviewTemplate(next);
  assert.equal(c.state.templateReview, null);
});
test("Hidden remote template catalogue and receipt responses cannot restore private views", async () => {
  const { connection, permission } = fixture();
  let resolve!: (v: any) => void;
  const c = web(
    async () =>
      new Promise((r) => {
        resolve = r;
      }),
    connection,
  );
  const loading = c.templates(connection.deviceId);
  c.hide();
  resolve({ items: [permission], nextCursor: null });
  await loading;
  assert.deepEqual(c.state.templates, []);
  c.set({
    templateResult: {
      permissionId: permission.permissionId,
      id: randomUUID(),
      state: "pending",
    },
  });
  const checking = c.templateReceipt();
  c.hide();
  resolve({ state: "received", receipt: { outcome: "queued" } });
  await checking;
  assert.equal(c.state.templateResult, null);
});

test("Mac background receiving review remains separate and sends only the selected permission", async () => {
  const { connection, permission } = fixture(),
    calls: any[] = [];
  connection.templates = [
    {
      ...permission,
      state: "active",
      pendingDelivery: false,
      backgroundReceiving: false,
    },
  ];
  const c = new TemplateController(async (path, _method, body) => {
    calls.push({ path, body });
    return path === "/v1/remote" ? { available: true, connection } : {};
  });
  c.remote = { available: true, connection };
  c.reviewRemoteAction(permission.permissionId, "start-receiving");
  await c.applyRemoteAction(false);
  assert.equal(calls.length, 0);
  await c.applyRemoteAction(true);
  assert.deepEqual(calls[0], {
    path: "/v1/remote/templates/receiving",
    body: {
      permissionId: permission.permissionId,
      confirmed: true,
      enabled: true,
    },
  });
  c.reviewRemoteAction(permission.permissionId, "stop-receiving");
  await c.applyRemoteAction(true);
  assert.equal(calls[2].body.enabled, false);
  assert.match(c.notice, /Existing tasks continue/);
});
