import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
type Headers = Record<string, string>;
type Call = (
  path: string,
  body: unknown,
  headers?: Headers,
) => Promise<{ status: number; headers: IncomingHttpHeaders; body: any }>;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function checkTemplateHttp(
  call: Call,
  owner: Headers,
  otherOwner: Headers,
  device: Headers,
  controls: Headers,
  deviceId: string,
) {
  const localOwner = { userId: "template-http", tenantId: "personal" };
  const store = new Store(":memory:", new Vault(randomBytes(32)));
  store.addProfile(localOwner, {
    id: "p",
    runtime: "ollama",
    model: "local",
    contextTokens: 4096,
    maxOutputTokens: 1024,
    temperature: 0.2,
  });
  const template = store.saveTemplate(localOwner, {
    id: randomUUID(),
    expectedRevision: 0,
    confirmed: true,
    definition: {
      name: "PRIVATE_TEMPLATE_NAME",
      prompt: "PRIVATE_TEMPLATE_PROMPT",
      kind: "query",
      modelProfileId: "p",
    },
  });
  const credential = randomBytes(32).toString("base64url"),
    permissionId = randomUUID(),
    now = Date.now();
  const native = { Authorization: "Bearer " + credential };
  const identity = {
    scope: "templates:run",
    remoteOwnerId: owner["X-Bittrees-Account"],
    deviceId,
    epoch: 1,
    permissionId,
  };
  const approval = {
    identity,
    templateId: template.id,
    templateRevision: 1,
    maxRuns: 2,
    expiresAt: now + 600000,
    confirmed: true,
  };
  const approved = store.remoteTemplates.approve(localOwner, approval);
  const publication = {
    permissionId,
    templateId: template.id,
    templateRevision: 1,
    maxRuns: 2,
    approvedAt: approved.approvedAt,
    expiresAt: approval.expiresAt,
    credentialHash: hash(credential),
    confirmed: true,
  };
  try {
    for (const headers of [
      {},
      controls,
      native,
      { ...device, Origin: "https://ai.bittrees.org" },
      { ...device, Cookie: owner.Cookie! },
    ])
      assert.equal(
        (await call("/device/templates/publish", publication, headers)).status,
        403,
      );
    assert.equal(
      (
        await call(
          "/device/templates/publish",
          { ...publication, confirmed: false },
          device,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await call(
          "/device/templates/publish",
          { ...publication, prompt: "PRIVATE" },
          device,
        )
      ).status,
      400,
    );
    const published = await call(
      "/device/templates/publish",
      publication,
      device,
    );
    assert.equal(published.status, 200);
    assert.equal(published.body.duplicate, false);
    assert.equal(
      JSON.stringify(published.body).includes("credentialHash"),
      false,
    );
    assert.equal(JSON.stringify(published.body).includes("PRIVATE"), false);
    assert.equal(
      (await call("/device/templates/publish", publication, device)).body
        .duplicate,
      true,
    );
    for (const headers of [
      {},
      otherOwner,
      { ...owner, "X-Bittrees-Account": randomUUID() },
      { ...owner, Authorization: device.Authorization! },
      { ...owner, Origin: "https://foreign.test" },
    ])
      assert.equal(
        (await call("/browser/templates", { deviceId }, headers)).status,
        403,
      );
    const listed = await call("/browser/templates", { deviceId }, owner);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items[0].permissionId, permissionId);
    assert.equal(listed.headers["cache-control"], "no-store");
    const { browserApi, RemoteWebController } = await import(
      new URL("../apps/remote-web/controller.js", import.meta.url).href
    );
    const controller = new RemoteWebController(
      browserApi(
        async (path: string, init: RequestInit) => {
          const response = await call(path, JSON.parse(String(init.body)), {
            ...owner,
            ...(init.headers as Record<string, string>),
          });
          return Response.json(response.body, { status: response.status });
        },
        () => controller.state.account?.ownerId,
      ),
      null,
      { chainId: 1 },
      () => {},
    );
    await controller.refresh();
    await controller.devices();
    // The existing fixture has a paginated owner device list.
    while (
      !controller.state.devices.some((d: any) => d.id === deviceId) &&
      controller.state.deviceCursor
    )
      await controller.devices(true);
    await controller.templates(deviceId);
    assert.equal(controller.state.templates[0].permissionId, permissionId);
    controller.reviewTemplate(permissionId);
    const intent = {
      ...controller.state.templateReview.intent,
      confirmed: true,
    };
    assert.equal(
      (await call("/browser/templates/run", intent, otherOwner)).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/browser/templates/run",
          { ...intent, confirmed: false },
          owner,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await call(
          "/browser/templates/run",
          { ...intent, command: { ...intent.command, prompt: "override" } },
          owner,
        )
      ).status,
      400,
    );
    await controller.submitTemplate(true);
    assert.equal(controller.state.error, "");
    assert.equal(controller.state.templateResult.id, intent.command.id);
    assert.equal(controller.state.templateResult.state, "pending");
    assert.equal(
      (await call("/browser/templates/run", intent, owner)).body.duplicate,
      true,
    );
    for (const headers of [
      device,
      controls,
      { ...native, Origin: "https://ai.bittrees.org" },
      { ...native, Cookie: owner.Cookie! },
    ])
      assert.equal(
        (await call("/device/templates/poll", {}, headers)).status,
        403,
      );
    assert.equal(
      (await call("/device/status", { sequence: 1, items: [] }, native)).status,
      403,
    );
    assert.equal((await call("/device/commands/poll", {}, native)).status, 403);
    assert.equal((await call("/device/rotate", {}, native)).status, 403);
    const batch = await call("/device/templates/poll", {}, native);
    assert.equal(batch.status, 200);
    assert.deepEqual(batch.body.identity, identity);
    assert.deepEqual(batch.body.commands, [intent.command]);
    const executed = store.remoteTemplates.execute(
      localOwner,
      batch.body.identity,
      batch.body.commands[0],
    );
    assert.equal(
      store.get(localOwner, executed.receipt.taskId!).input.prompt,
      "PRIVATE_TEMPLATE_PROMPT",
    );
    assert.equal(
      (await call("/device/templates/receipt", executed.receipt, device))
        .status,
      403,
    );
    assert.equal(
      (
        await call(
          "/device/templates/receipt",
          { ...executed.receipt, result: "PRIVATE" },
          native,
        )
      ).status,
      400,
    );
    assert.equal(
      (await call("/device/templates/receipt", executed.receipt, native))
        .status,
      200,
    );
    assert.equal(
      (await call("/device/templates/receipt", executed.receipt, native)).body
        .duplicate,
      true,
    );
    await controller.templateReceipt();
    assert.equal(controller.state.error, "");
    assert.equal(controller.state.templateResult.state, "received");
    assert.deepEqual(controller.state.templateResult.receipt, executed.receipt);
    const receiptRequest = { permissionId, id: intent.command.id };
    assert.equal(
      (await call("/browser/templates/receipt", receiptRequest, otherOwner))
        .status,
      403,
    );
    assert.deepEqual(
      (await call("/browser/templates/receipt", receiptRequest, owner)).body,
      { state: "received", receipt: executed.receipt },
    );
    assert.equal(
      (await call("/device/templates/poll", {}, native)).body.commands.length,
      0,
    );
    // Another genuinely paired device of the same owner cannot revoke this grant.
    const verifier = randomBytes(32).toString("base64url");
    const pairing = await call("/device/pairings", {
      challenge: createHash("sha256").update(verifier).digest("base64url"),
    });
    assert.equal(pairing.status, 200);
    assert.equal(
      (
        await call(
          "/browser/pairings/approve",
          {
            id: pairing.body.id,
            approvalCode: pairing.body.approvalCode,
            confirmed: true,
          },
          owner,
        )
      ).status,
      200,
    );
    const paired = await call("/device/redeem", {
      id: pairing.body.id,
      verifier,
      expectedOwnerId: owner["X-Bittrees-Account"],
    });
    assert.equal(paired.status, 200);
    assert.equal(
      (
        await call("/device/templates/publish", publication, {
          Authorization: "Bearer " + paired.body.credential,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/device/templates/publish",
          { ...publication, deviceId },
          device,
        )
      ).status,
      400,
    );

    const revoke = { permissionId, confirmed: true };
    assert.equal(
      (
        await call("/device/templates/revoke", revoke, {
          Authorization: "Bearer " + paired.body.credential,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/device/templates/revoke",
          { ...revoke, confirmed: false },
          device,
        )
      ).status,
      400,
    );
    assert.equal(
      (await call("/device/templates/revoke", revoke, device)).status,
      200,
    );
    assert.equal(
      (await call("/device/templates/poll", {}, native)).status,
      403,
    );
    assert.deepEqual(
      (await call("/browser/templates/receipt", receiptRequest, owner)).body,
      { state: "received", receipt: executed.receipt },
    );
    const nextSecret = randomBytes(32).toString("base64url"),
      nextPermission = randomUUID();
    const next = {
      ...publication,
      permissionId: nextPermission,
      maxRuns: 1,
      credentialHash: hash(nextSecret),
    };
    assert.equal(
      (await call("/device/templates/publish", next, device)).status,
      200,
    );
    const nextIntent = {
      ...intent,
      permissionId: nextPermission,
      command: { ...intent.command, id: randomUUID() },
    };
    assert.equal(
      (await call("/browser/templates/run", nextIntent, owner)).status,
      200,
    );
    const atCapacity = await call(
      "/browser/templates/run",
      { ...nextIntent, command: { ...nextIntent.command, id: randomUUID() } },
      owner,
    );
    assert.equal(atCapacity.status, 429);
    assert.deepEqual(atCapacity.body, { error: "CAPACITY" });
    assert.equal(
      (
        await call(
          "/browser/templates/revoke",
          { permissionId: nextPermission, confirmed: false },
          owner,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await call(
          "/browser/templates/revoke",
          { permissionId: nextPermission, confirmed: true },
          otherOwner,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/browser/templates/revoke",
          { permissionId: nextPermission, confirmed: true },
          owner,
        )
      ).status,
      200,
    );
    assert.deepEqual(
      (
        await call(
          "/browser/templates/receipt",
          { permissionId: nextPermission, id: nextIntent.command.id },
          owner,
        )
      ).body,
      { state: "cancelled" },
    );
    assert.equal(
      (
        await call(
          "/device/templates/poll",
          {},
          { Authorization: "Bearer " + nextSecret },
        )
      ).status,
      403,
    );
    // Leave an active scoped key for the surrounding status-key rotation test.
    const rotationSecret = randomBytes(32).toString("base64url");
    assert.equal(
      (
        await call(
          "/device/templates/publish",
          {
            ...publication,
            permissionId: randomUUID(),
            credentialHash: hash(rotationSecret),
          },
          device,
        )
      ).status,
      200,
    );
    return { Authorization: "Bearer " + rotationSecret };
  } finally {
    store.close();
  }
}
