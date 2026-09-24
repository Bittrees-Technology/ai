import { checkPrivateRelayHttp } from "./private-relay-http-integration.js";
import { checkBrowserDeviceHttp } from "./browser-device-http-integration.js";
import { RemoteTemplateReceiver } from "../modules/remote/template-receiver.js";
import { checkTemplateHttp } from "./remote-template-http-integration.js";
import { RemoteReceiver } from "../modules/remote/receiver.js";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer, request } from "node:https";
import {
  createServer as httpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
} from "node:http";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { Wallet } from "ethers";
import type { Pool } from "pg";
import { RemoteClient } from "../modules/remote/client.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { createRemoteApp } from "../modules/remote/http.js";

export async function checkRemoteHttp(pool: Pool) {
  const temp = await mkdtemp(join(tmpdir(), "bittrees-relay-tls-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-keyout",
      join(temp, "key.pem"),
      "-out",
      join(temp, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  const key = await readFile(join(temp, "key.pem")),
    cert = await readFile(join(temp, "cert.pem"));
  const origin = "https://ai.bittrees.org";
  const config = {
    origin,
    assets: fileURLToPath(new URL("../dist/remote-web", import.meta.url)),
    chainId: 1,
    sessionMs: 3600000,
    requestsPerMinute: 1000,
    quotas: {
      pendingPairings: 1000,
      devicesPerOwner: 200,
      statusesPerDevice: 2,
    },
    deviceMs: 3600000,
    retentionMs: 86400000,
  };
  const app = createRemoteApp(pool, config);
  const server = createServer({ key, cert }, app),
    plain = httpServer(app);
  const limited = createServer(
    { key, cert },
    createRemoteApp(pool, { ...config, requestsPerMinute: 2 }),
  );
  const privateRelayPolicy = {
    version: 1,
    origin,
    chainId: 1,
    receivedContent: "until-deleted",
    unreceivedContent: { mode: "until-deleted" },
    operationalMetadataMs: 604800000,
    maxMessagesPerOwner: 100,
    maxBytesPerOwner: 1048576,
  };
  for (const invalid of [
    null,
    {},
    { ...privateRelayPolicy, origin: "https://other.invalid" },
    { ...privateRelayPolicy, chainId: 2 },
  ])
    assert.throws(
      () => createRemoteApp(pool, { ...config, privateRelayPolicy: invalid }),
      /INVALID_INPUT/,
    );
  const privateServer = createServer(
    { key, cert },
    createRemoteApp(pool, { ...config, privateRelayPolicy }),
  );
  const servers = [server, plain, limited, privateServer];
  try {
    for (const s of servers)
      await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    const port = (s: typeof server | typeof plain) =>
      (s.address() as { port: number }).port;
    let requestCount = 0;
    async function call(
      path: string,
      body: unknown,
      headers: Record<string, string> = {},
      target: typeof server | typeof plain = server,
      method = "POST",
    ) {
      requestCount++;
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      return new Promise<{
        status: number;
        headers: IncomingHttpHeaders;
        body: any;
      }>((resolve, reject) => {
        const tls = target !== plain;
        const req = (tls ? request : httpRequest)(
          {
            hostname: "127.0.0.1",
            port: port(target),
            path,
            method,
            ...(tls ? { ca: cert, servername: "localhost" } : {}),
            headers: {
              Host: "ai.bittrees.org",
              "Content-Type": "application/json",
              "Content-Length": String(Buffer.byteLength(payload)),
              ...headers,
            },
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              text += chunk;
            });
            res.on("end", () => {
              try {
                resolve({
                  status: res.statusCode!,
                  headers: res.headers,
                  body: res.headers["content-type"]?.includes(
                    "application/json",
                  )
                    ? JSON.parse(text)
                    : text,
                });
              } catch (e) {
                reject(e);
              }
            });
          },
        );
        req.setTimeout(5000, () => req.destroy(Error("test request timeout")));
        req.on("error", (e) =>
          reject(
            Error(
              `HTTP integration connection ${requestCount} failed: ${path}, TLS=${tls}, ${e.message}`,
            ),
          ),
        );
        req.end(payload);
      });
    }
    await checkPrivateRelayHttp(
      (path, body, headers) => call(path, body, headers, privateServer),
      (path, body, headers) => call(path, body, headers),
    );
    await checkBrowserDeviceHttp((path, body, headers) =>
      call(path, body, headers),
    );
    const browser = {
      Origin: origin,
      "X-Bittrees-Request": "1",
      "Sec-Fetch-Site": "same-origin",
    };
    const page = await call("/", {}, {}, server, "GET");
    assert.equal(page.status, 200);
    assert.match(page.body, /Your companion, connected/);
    assert.match(
      String(page.headers["content-security-policy"]),
      /script-src 'self'/,
    );
    assert.equal(
      (await call("/settings.json", {}, {}, server, "GET")).body.chainId,
      1,
    );
    assert.equal((await call("/app.js", {}, {}, server, "GET")).status, 200);
    const icon = await call("/favicon.svg", {}, {}, server, "GET");
    assert.equal(icon.status, 200);
    assert.match(String(icon.headers["content-type"]), /image\/svg\+xml/);
    const stylesheet = String(page.body).match(
      /href="(\/assets\/remote-[^"]+\.css)"/,
    )?.[1];
    assert.ok(stylesheet);
    const css = await call(stylesheet, {}, {}, server, "GET");
    assert.equal(css.status, 200);
    assert.match(String(css.headers["content-type"]), /text\/css/);
    for (const blocked of [
      "/controller.js",
      "/.env",
      "/assets/remote-index-deadbeef.js.map",
      "/modules/remote/browser-key-host.ts",
    ])
      assert.equal((await call(blocked, {}, {}, server, "GET")).status, 405);

    const wallet = Wallet.createRandom();
    assert.equal(
      (await call("/browser/login/challenge", { address: wallet.address }))
        .status,
      403,
    );
    assert.equal(
      (
        await call(
          "/browser/login/challenge",
          { address: wallet.address },
          { ...browser, Origin: "https://evil.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/browser/login/challenge",
          { address: wallet.address },
          { ...browser, "Sec-Fetch-Site": "same-site" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/browser/login/challenge",
          {},
          { ...browser, Host: "evil.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/browser/login/challenge",
          {},
          { ...browser, "X-Forwarded-Proto": "https" },
          plain,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/browser/login/challenge",
          {},
          { ...browser, "Content-Type": "text/plain" },
        )
      ).status,
      415,
    );
    assert.equal(
      (await call("/browser/session", {}, browser, server, "GET")).status,
      405,
    );
    assert.equal(
      (await call("/browser/login/challenge", "{", browser)).status,
      400,
    );
    assert.equal(
      (
        await call(
          "/browser/login/challenge",
          { junk: "PRIVATE".repeat(6000) },
          browser,
        )
      ).status,
      400,
    );
    const login = await call(
      "/browser/login/challenge",
      { address: wallet.address },
      browser,
    );
    assert.equal(login.status, 200);
    assert.equal(login.body.browserToken, undefined);
    const loginSet = login.headers["set-cookie"]![0]!;
    for (const flag of ["Secure", "HttpOnly", "SameSite=Strict", "Path=/"])
      assert.ok(loginSet.includes(flag));
    const loginCookie = loginSet.split(";")[0]!;
    const signed = {
      message: login.body.message,
      signature: await wallet.signMessage(login.body.message),
    };
    assert.equal(
      (await call("/browser/login/verify", signed, browser)).status,
      403,
    );
    assert.equal(
      (
        await call("/browser/login/verify", signed, {
          ...browser,
          Cookie: loginCookie + "; " + loginCookie,
        })
      ).status,
      403,
    );
    const verified = await call("/browser/login/verify", signed, {
      ...browser,
      Cookie: loginCookie,
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.token, undefined);
    assert.equal(
      (
        await call("/browser/login/verify", signed, {
          ...browser,
          Cookie: loginCookie,
        })
      ).status,
      403,
    );
    const sessionCookie = verified.headers["set-cookie"]!.find((x) =>
      x.startsWith("__Host-bittrees-session="),
    )!.split(";")[0]!;
    const owner = {
      ...browser,
      Cookie: sessionCookie,
      "X-Bittrees-Account": verified.body.ownerId,
    };
    assert.equal(
      (await call("/browser/session", {}, owner)).body.ownerId,
      verified.body.ownerId,
    );
    assert.equal(
      (
        await call(
          "/browser/session",
          {},
          {
            ...owner,
            Authorization: "Bearer " + randomBytes(32).toString("base64url"),
          },
        )
      ).status,
      403,
    );
    const verifier = randomBytes(32).toString("base64url"),
      challenge = createHash("sha256").update(verifier).digest("base64url");
    assert.equal(
      (await call("/device/pairings", { challenge }, browser)).status,
      403,
    );
    const pair = await call("/device/pairings", { challenge });
    assert.equal(pair.status, 200);
    const approval = {
      id: pair.body.id,
      approvalCode: pair.body.approvalCode,
      confirmed: true,
    };
    assert.equal(
      (
        await call(
          "/browser/pairings/approve",
          { ...approval, ownerId: verified.body.ownerId },
          owner,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await call(
          "/browser/pairings/approve",
          { ...approval, confirmed: false },
          owner,
        )
      ).status,
      400,
    );
    assert.equal(
      (await call("/browser/pairings/approve", approval, owner)).status,
      200,
    );
    const redeemed = await call("/device/redeem", {
      id: pair.body.id,
      verifier,
      expectedOwnerId: verified.body.ownerId,
    });
    assert.equal(redeemed.status, 200);
    const device = { Authorization: "Bearer " + redeemed.body.credential };
    const deviceIdentity = await call("/device/identity", {}, device);
    assert.equal(deviceIdentity.status, 200);
    assert.deepEqual(deviceIdentity.body, {
      version: 1,
      ownerId: redeemed.body.ownerId,
      deviceId: redeemed.body.deviceId,
      credentialEpoch: 1,
      expiresAt: redeemed.body.expiresAt,
    });
    assert.equal(deviceIdentity.headers["cache-control"], "no-store");
    assert.equal(
      deviceIdentity.headers["access-control-allow-origin"],
      undefined,
    );
    assert.equal(
      (await call("/device/identity", { ownerId: randomUUID() }, device))
        .status,
      400,
    );
    assert.equal((await call("/device/identity", {}, {})).status, 403);
    assert.equal((await call("/device/identity", {}, owner)).status, 403);
    assert.equal(
      (await call("/device/identity", {}, { ...device, Cookie: sessionCookie }))
        .status,
      403,
    );
    assert.equal(
      (await call("/device/identity", {}, device, plain)).status,
      403,
    );
    const item = {
      id: randomUUID(),
      deviceId: redeemed.body.deviceId,
      status: "queued",
      revision: 1,
      updatedAt: new Date().toISOString(),
    };
    assert.equal(
      (
        await call(
          "/device/status",
          { sequence: 1, items: [item] },
          { ...device, Cookie: sessionCookie },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/device/status",
          { sequence: 1, items: [{ ...item, title: "PRIVATE" }] },
          device,
        )
      ).status,
      400,
    );
    assert.equal(
      (await call("/device/status", { sequence: 1, items: [item] }, device))
        .status,
      200,
    );
    const listed = await call(
      "/browser/status",
      { deviceId: item.deviceId },
      owner,
    );
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.items, [item]);
    assert.equal(listed.headers["cache-control"], "no-store");
    assert.equal(listed.headers["access-control-allow-origin"], undefined);
    const otherWallet = Wallet.createRandom();
    const otherLogin = await call(
      "/browser/login/challenge",
      { address: otherWallet.address },
      browser,
    );
    const otherVerified = await call(
      "/browser/login/verify",
      {
        message: otherLogin.body.message,
        signature: await otherWallet.signMessage(otherLogin.body.message),
      },
      {
        ...browser,
        Cookie: otherLogin.headers["set-cookie"]![0]!.split(";")[0]!,
      },
    );
    assert.equal(otherVerified.status, 200);
    const otherCookie = otherVerified.headers["set-cookie"]!.find((x) =>
      x.startsWith("__Host-bittrees-session="),
    )!.split(";")[0]!;
    const otherOwner = {
      ...browser,
      Cookie: otherCookie,
      "X-Bittrees-Account": otherVerified.body.ownerId,
    };
    assert.equal(
      (await call("/browser/status", { deviceId: item.deviceId }, otherOwner))
        .status,
      403,
    );
    assert.equal(
      (
        await call(
          "/browser/devices/revoke",
          { deviceId: item.deviceId },
          otherOwner,
        )
      ).status,
      403,
    );
    const deviceList = await call("/browser/devices", {}, owner);
    assert.ok(deviceList.body.items.some((d: any) => d.id === item.deviceId));
    const otherList = await call("/browser/devices", {}, otherOwner);
    assert.ok(!otherList.body.items.some((d: any) => d.id === item.deviceId));
    assert.equal(
      (
        await call(
          "/browser/devices",
          {},
          { ...owner, "X-Bittrees-Account": otherVerified.body.ownerId },
        )
      ).status,
      403,
    );
    const { browserApi } = await import(
      new URL("../apps/remote-web/controller.js", import.meta.url).href
    );
    let displayedOwner = verified.body.ownerId;
    const pageApi = browserApi(
      async (path: string, init: RequestInit) => {
        const response = await call(path, JSON.parse(String(init.body)), {
          ...browser,
          Cookie: sessionCookie,
          ...(init.headers as Record<string, string>),
        });
        return Response.json(response.body, { status: response.status });
      },
      () => displayedOwner,
    );
    assert.ok(
      (await pageApi("/browser/devices", {})).items.some(
        (d: any) => d.id === item.deviceId,
      ),
    );
    displayedOwner = otherVerified.body.ownerId;
    await assert.rejects(pageApi("/browser/devices", {}), /DENIED/);
    const identity = await call("/browser/session", {}, owner);
    assert.equal(identity.body.address, wallet.address.toLowerCase());
    assert.equal(identity.body.chainId, 1);
    const extraDevices = Array.from({ length: 100 }, () => randomUUID());
    await pool.query(
      "INSERT INTO remote_devices(id,owner_id,epoch,expires_at) SELECT id,$2,1,$3 FROM unnest($1::uuid[]) AS id",
      [extraDevices, verified.body.ownerId, Date.now() + 3600000],
    );
    const firstDevices = await call("/browser/devices", {}, owner);
    assert.equal(firstDevices.body.items.length, 100);
    assert.ok(firstDevices.body.nextCursor);
    const finalDevices = await call(
      "/browser/devices",
      { after: firstDevices.body.nextCursor },
      owner,
    );
    assert.equal(finalDevices.body.items.length, 1);
    assert.equal(finalDevices.body.nextCursor, null);
    assert.deepEqual(
      [...firstDevices.body.items, ...finalDevices.body.items].map(
        (d: any) => d.id,
      ),
      [...extraDevices, item.deviceId].sort(),
    );
    // Separate browser approval + native confirmation + narrowly scoped token.
    const controlApproval = {
      deviceId: item.deviceId,
      expectedEpoch: 1,
      confirmed: true,
    };
    assert.equal((await call("/device/commands/poll", {}, device)).status, 403);
    assert.equal(
      (await call("/device/controls/enable", { confirmed: true }, device))
        .status,
      403,
    );
    assert.equal(
      (await call("/browser/controls/approve", controlApproval, otherOwner))
        .status,
      403,
    );
    assert.equal(
      (
        await call(
          "/browser/controls/approve",
          { ...controlApproval, confirmed: false },
          owner,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await call(
          "/browser/controls/approve",
          { ...controlApproval, expectedEpoch: 2 },
          owner,
        )
      ).status,
      403,
    );
    assert.equal(
      (await call("/browser/controls/approve", controlApproval, owner)).status,
      200,
    );
    assert.equal((await call("/device/commands/poll", {}, device)).status, 403);
    assert.equal(
      (await call("/device/controls/enable", { confirmed: false }, device))
        .status,
      400,
    );
    const grants = await Promise.all([
      call("/device/controls/enable", { confirmed: true }, device),
      call("/device/controls/enable", { confirmed: true }, device),
    ]);
    assert.deepEqual(grants.map((g) => g.status).sort(), [200, 403]);
    const controlGrant = grants.find((g) => g.status === 200)!.body;
    assert.equal(controlGrant.scope, "controls:pause-cancel");
    assert.equal(controlGrant.expiresAt, redeemed.body.expiresAt);
    const controls = { Authorization: "Bearer " + controlGrant.credential };
    assert.equal((await call("/device/identity", {}, controls)).status, 403);
    assert.equal(
      (await call("/device/status", { sequence: 1, items: [item] }, controls))
        .status,
      403,
    );
    assert.equal((await call("/device/rotate", {}, controls)).status, 403);
    const controlLocal = new Store(":memory:", new Vault(randomBytes(32)));
    const localOwner = { userId: "control-test", tenantId: "personal" };
    const task = controlLocal.create(
      localOwner,
      {
        conversationId: "control",
        kind: "query",
        prompt: "PRIVATE CONTROL TASK",
        modelProfileId: "m",
      },
      "control",
    );
    const controlBatch = {
      sequence: 2,
      items: [
        {
          ...item,
          id: task.id,
          updatedAt: new Date(task.updatedAt).toISOString(),
        },
      ],
    };
    let queuedId = "";
    try {
      assert.equal(
        (await call("/device/status", controlBatch, device)).status,
        200,
      );
      const command = {
        id: randomUUID(),
        deviceId: item.deviceId,
        taskId: task.id,
        command: "pause",
        expectedRevision: task.revision,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
      assert.equal(
        (
          await call(
            "/browser/commands",
            { command, confirmed: true },
            otherOwner,
          )
        ).status,
        403,
      );
      assert.equal(
        (await call("/browser/commands", { command, confirmed: false }, owner))
          .status,
        400,
      );
      assert.equal(
        (
          await call(
            "/browser/commands",
            { command: { ...command, command: "resume" }, confirmed: true },
            owner,
          )
        ).status,
        400,
      );
      assert.equal(
        (await call("/browser/commands", { command, confirmed: true }, owner))
          .status,
        200,
      );
      const delivery = await call("/device/commands/poll", {}, controls);
      assert.equal(delivery.status, 200);
      assert.equal(delivery.body.commands.length, 1);
      const localIdentity = {
        remoteOwnerId: delivery.body.identity.ownerId,
        deviceId: item.deviceId,
        epoch: delivery.body.identity.epoch,
        controlId: delivery.body.identity.controlId,
      };
      assert.throws(
        () =>
          controlLocal.executeRemoteControl(
            localOwner,
            localIdentity,
            delivery.body.commands[0],
          ),
        /NOT_FOUND/,
      );
      controlLocal.allowRemoteControls(localOwner, {
        ...localIdentity,
        expiresAt: controlGrant.expiresAt,
      });
      const executed = controlLocal.executeRemoteControl(
        localOwner,
        localIdentity,
        delivery.body.commands[0],
      );
      assert.equal(executed.receipt.outcome, "applied");
      assert.equal(controlLocal.get(localOwner, task.id).status, "paused");
      assert.equal(
        (await call("/device/commands/receipt", executed.receipt, device))
          .status,
        403,
      );
      assert.equal(
        (await call("/device/commands/receipt", executed.receipt, controls))
          .body.duplicate,
        false,
      );
      assert.equal(
        (await call("/device/commands/receipt", executed.receipt, controls))
          .body.duplicate,
        true,
      );
      assert.equal(
        (await call("/browser/commands/receipt", { id: command.id }, owner))
          .body.state,
        "acknowledged",
      );
      assert.equal(
        (
          await call(
            "/browser/commands/receipt",
            { id: command.id },
            otherOwner,
          )
        ).status,
        403,
      );
      queuedId = randomUUID();
      assert.equal(
        (
          await call(
            "/browser/commands",
            {
              command: { ...command, id: queuedId, command: "cancel" },
              confirmed: true,
            },
            owner,
          )
        ).status,
        200,
      );
      const staleIdentity = delivery.body.identity;
      assert.equal(
        (
          await call(
            "/browser/controls/disable",
            { deviceId: item.deviceId },
            owner,
          )
        ).status,
        200,
      );
      assert.equal(
        (await call("/device/commands/poll", {}, controls)).status,
        403,
      );
      assert.equal(
        (await call("/browser/commands/receipt", { id: queuedId }, owner)).body
          .state,
        "cancelled",
      );
      assert.equal(
        (await call("/browser/controls/approve", controlApproval, owner))
          .status,
        200,
      );
      const again = await call(
        "/device/controls/enable",
        { confirmed: true },
        device,
      );
      assert.equal(again.status, 200);
      assert.notEqual(again.body.controlId, controlGrant.controlId);
      assert.equal(
        (await call("/device/commands/poll", {}, controls)).status,
        403,
      );
      assert.deepEqual(
        (
          await call(
            "/device/commands/poll",
            {},
            { Authorization: "Bearer " + again.body.credential },
          )
        ).body.commands,
        [],
      );
      const { RemoteCommandStore } =
        await import("../modules/remote/commands.js");
      await assert.rejects(
        new RemoteCommandStore(pool, 86400000).poll(staleIdentity),
        /DENIED/,
      );
      // Status key rotation must revoke even the replacement control permission.
      Object.assign(controls, {
        Authorization: "Bearer " + again.body.credential,
      });
    } finally {
      controlLocal.close();
    }
    const templateHeaders = await checkTemplateHttp(
      call,
      owner,
      otherOwner,
      device,
      controls,
      item.deviceId,
    );
    const overCapacity = await call(
      "/device/status",
      { sequence: 3, items: [{ ...item, id: randomUUID() }] },
      device,
    );
    assert.equal(overCapacity.status, 429);
    assert.deepEqual(overCapacity.body, { error: "CAPACITY" });
    const rotated = await call("/device/rotate", {}, device);
    assert.equal(rotated.status, 200);
    assert.equal(
      (await call("/device/templates/poll", {}, templateHeaders)).status,
      403,
    );
    assert.equal(
      (await call("/device/commands/poll", {}, controls)).status,
      403,
    );
    assert.equal(
      (await call("/device/status", controlBatch, device)).status,
      403,
    );
    assert.equal(
      (
        await call("/device/status", controlBatch, {
          Authorization: "Bearer " + rotated.body.credential,
        })
      ).body.duplicate,
      true,
    );
    assert.equal(
      (
        await call(
          "/browser/devices/revoke",
          { deviceId: item.deviceId },
          owner,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call("/device/status", controlBatch, {
          Authorization: "Bearer " + rotated.body.credential,
        })
      ).status,
      403,
    );
    const logout = await call("/browser/logout", {}, owner);
    assert.equal(logout.status, 200);
    for (const name of ["__Host-bittrees-session", "__Host-bittrees-login"])
      assert.ok(
        logout.headers["set-cookie"]!.some(
          (value) =>
            value.startsWith(name + "=;") &&
            value.includes("Expires=Thu, 01 Jan 1970"),
        ),
      );
    assert.equal((await call("/browser/session", {}, owner)).status, 403);
    assert.equal((await call("/browser/logout", {}, owner)).status, 200);
    assert.equal((await call("/browser/logout", {}, browser)).status, 200);
    assert.equal(
      (
        await call(
          "/browser/logout",
          {},
          { ...browser, Cookie: sessionCookie + "; " + sessionCookie },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/browser/logout",
          {},
          { ...browser, Cookie: "__Host-bittrees-session=invalid" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/browser/logout",
          {},
          { ...browser, Origin: "https://other.example" },
        )
      ).status,
      403,
    );
    // Exercise the actual Mac-side protocol client over the same verified TLS transport.
    // Secret storage is an in-memory test double; this is not native Keychain acceptance.
    let savedSecret: Uint8Array | undefined;
    const secret = {
      getSecret: async () => savedSecret,
      setSecret: async (value: Uint8Array) => {
        savedSecret = Uint8Array.from(value);
      },
      deleteCredential: async () => {
        savedSecret = undefined;
        return true;
      },
    };
    const transport: typeof fetch = async (url, init) => {
      assert.ok(String(url).startsWith(origin + "/device/"));
      assert.equal(init?.redirect, "error");
      assert.equal(init?.credentials, "omit");
      const r = await call(
        new URL(String(url)).pathname,
        JSON.parse(String(init?.body)),
        init?.headers as Record<string, string>,
      );
      return Response.json(r.body, { status: r.status });
    };
    const local = new Store(":memory:", new Vault(randomBytes(32)));
    const clientOwner = {
      userId: "synthetic-local-owner",
      tenantId: "personal",
    };
    const executor = {
      allow: (binding: unknown) =>
        local.allowRemoteControls(clientOwner, binding),
      allowed: (identity: unknown) =>
        local.remoteControlsAllowed(clientOwner, identity),
      revoke: (deviceId: string) =>
        local.revokeRemoteControls(clientOwner, deviceId),
      execute: (identity: unknown, command: unknown) =>
        local.executeRemoteControl(clientOwner, identity, command),
      interrupt: (_taskId: string) => {},
    };
    const templateExecutor = {
      approve: (raw: unknown) =>
        local.remoteTemplates.approve(clientOwner, raw),
      allowed: (raw: unknown) =>
        local.remoteTemplates.allowed(clientOwner, raw),
      revoke: (deviceId: string, templateId?: string) => {
        local.remoteTemplates.revoke(clientOwner, deviceId, templateId);
      },
      execute: (identity: unknown, command: unknown) =>
        local.remoteTemplates.execute(clientOwner, identity, command),
    };
    const client = new RemoteClient(
      "synthetic-local-owner",
      secret,
      transport,
      Date.now,
      executor,
      templateExecutor,
    );
    const clientPair = await client.begin();
    assert.equal(
      (
        await call(
          "/browser/pairings/approve",
          {
            id: clientPair.id,
            approvalCode: clientPair.approvalCode,
            confirmed: true,
          },
          otherOwner,
        )
      ).status,
      200,
    );
    await client.finish(otherVerified.body.ownerId);
    try {
      let previousIdentity: (() => unknown) | undefined;
      await client.withVerifiedDevice(async (scope) => {
        const saved = (await client.status())!;
        assert.deepEqual(scope.current(), {
          ownerId: saved.ownerId,
          deviceId: saved.deviceId,
          credentialEpoch: saved.epoch,
          expiresAt: saved.expiresAt,
        });
        previousIdentity = scope.current;
      });
      assert.equal(previousIdentity!(), null);
      const localTask = local.create(
        { userId: "synthetic-local-owner", tenantId: "personal" },
        {
          conversationId: "PRIVATE_CONVERSATION",
          kind: "draft",
          prompt: "PRIVATE_PROMPT",
          modelProfileId: "PRIVATE_MODEL",
          dependencies: [],
          priority: "normal",
          tags: [],
        },
        randomUUID(),
      );
      await client.publish([localTask]);
      const paired = (await client.status())!;
      assert.equal(
        (
          await call(
            "/browser/controls/approve",
            { deviceId: paired.deviceId, expectedEpoch: 1, confirmed: true },
            otherOwner,
          )
        ).status,
        200,
      );
      await client.enableControls();
      assert.equal((await client.status())?.controls, "enabled");
      const pause = {
        id: randomUUID(),
        deviceId: paired.deviceId,
        taskId: localTask.id,
        command: "pause",
        expectedRevision: localTask.revision,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
      assert.equal(
        (
          await call(
            "/browser/commands",
            { command: pause, confirmed: true },
            otherOwner,
          )
        ).status,
        200,
      );
      const receivingClient = new RemoteClient(
        "synthetic-local-owner",
        secret,
        transport,
        Date.now,
        executor,
      );
      let runReceiver!: () => void, done!: () => void;
      const delivered = new Promise<void>((resolve) => {
        done = resolve;
      });
      let deliveredReceipts = 0;
      const receiver = new RemoteReceiver(
        {
          get running() {
            return receivingClient.running;
          },
          status: () => receivingClient.status(),
          setReceiving: (enabled) => receivingClient.setReceiving(enabled),
          pollControls: async (signal) => {
            try {
              const result = await receivingClient.pollControls(signal);
              deliveredReceipts = result.receipts.length;
              return result;
            } finally {
              done();
            }
          },
        },
        (fn) => {
          runReceiver = fn;
          return { cancel() {} };
        },
      );
      try {
        await receiver.configure(true);
        runReceiver();
        await delivered;
        assert.equal(deliveredReceipts, 1);
        await receiver.configure(false);
        assert.equal(
          (await receivingClient.status())?.backgroundReceiving,
          false,
        );
      } finally {
        await receiver.shutdown();
      }
      assert.equal(local.get(clientOwner, localTask.id).status, "paused");
      assert.equal(
        (await call("/browser/commands/receipt", { id: pause.id }, otherOwner))
          .body.state,
        "acknowledged",
      );
      local.addProfile(clientOwner, {
        id: "template-model",
        runtime: "ollama",
        model: "local",
        contextTokens: 4096,
        maxOutputTokens: 1024,
        temperature: 0.2,
      });
      const template = local.saveTemplate(clientOwner, {
        id: randomUUID(),
        expectedRevision: 0,
        confirmed: true,
        definition: {
          name: "PRIVATE_TEMPLATE",
          prompt: "PRIVATE_TEMPLATE_PROMPT",
          kind: "query",
          modelProfileId: "template-model",
        },
      });
      const reviewedConnection = (await client.status())!;
      await client.shareTemplate({
        expectedConnection: {
          ownerId: reviewedConnection.ownerId,
          deviceId: reviewedConnection.deviceId,
          epoch: reviewedConnection.epoch,
        },
        templateId: template.id,
        expectedRevision: 1,
        maxRuns: 2,
        expiresAt: Date.now() + 600000,
        confirmed: true,
      });
      const templateState = (await client.status())!.templates[0]!;
      const templateIntent = {
        permissionId: templateState.permissionId,
        confirmed: true,
        command: {
          id: randomUUID(),
          deviceId: (await client.status())!.deviceId,
          templateId: template.id,
          templateRevision: 1,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      };
      assert.equal(
        (await call("/browser/templates/run", templateIntent, otherOwner))
          .status,
        200,
      );
      const resumedClient = new RemoteClient(
        "synthetic-local-owner",
        secret,
        transport,
        Date.now,
        executor,
        templateExecutor,
      );
      let templateTick: (() => void) | undefined;
      let deliveredTemplate: string | undefined;
      let finishTemplate!: () => void;
      const templateDone = new Promise<void>((resolve) => {
        finishTemplate = resolve;
      });
      const templateReceiver = new RemoteTemplateReceiver(
        {
          get running() {
            return resumedClient.running;
          },
          status: () => resumedClient.status(),
          setTemplateReceiving: (id, enabled) =>
            resumedClient.setTemplateReceiving(id, enabled),
          pollTemplate: async (id, signal) => {
            try {
              const result = await resumedClient.pollTemplate(id, signal);
              deliveredTemplate = result.receipts[0]?.taskId;
              return result;
            } finally {
              finishTemplate();
            }
          },
        },
        (fn) => {
          templateTick = fn;
          return {
            cancel() {
              templateTick = undefined;
            },
          };
        },
      );
      try {
        await templateReceiver.configure(templateState.permissionId, true);
        assert.equal(
          (await resumedClient.status())!.templates[0]!.backgroundReceiving,
          true,
        );
        templateTick!();
        await templateDone;
      } finally {
        await templateReceiver.shutdown();
      }
      const templateTask = deliveredTemplate!;
      assert.ok(templateTask);
      assert.equal(
        local.get(clientOwner, templateTask).input.prompt,
        "PRIVATE_TEMPLATE_PROMPT",
      );
      assert.equal(
        (
          await call(
            "/browser/templates/receipt",
            {
              permissionId: templateState.permissionId,
              id: templateIntent.command.id,
            },
            otherOwner,
          )
        ).body.receipt.outcome,
        "queued",
      );
      await client.rotate();
      assert.equal(local.get(clientOwner, templateTask).status, "cancelled");
      assert.deepEqual((await client.status())!.templates, []);
      assert.equal((await client.status())?.controls, "disabled");
      const reopened = new RemoteClient(
        "synthetic-local-owner",
        secret,
        transport,
      );
      await reopened.publish([local.get(clientOwner, localTask.id)]);
      const state = (await reopened.status())!;
      await reopened.withVerifiedDevice(async (scope) => {
        assert.equal(scope.current()?.credentialEpoch, 2);
        assert.equal(scope.current()?.deviceId, state.deviceId);
        assert.equal(previousIdentity!(), null);
      });
      const remote = await call(
        "/browser/status",
        { deviceId: state.deviceId },
        otherOwner,
      );
      assert.equal(remote.body.items[0].revision, 2);
      assert.equal(JSON.stringify(remote.body).includes("PRIVATE"), false);
      await call(
        "/browser/devices/revoke",
        { deviceId: state.deviceId },
        otherOwner,
      );
      await assert.rejects(
        reopened.publish([{ ...localTask, revision: 3 }]),
        /DENIED/,
      );
      await assert.rejects(
        reopened.withVerifiedDevice(async () =>
          assert.fail("revoked identity reached host"),
        ),
        /DENIED/,
      );
      assert.equal(
        (await reopened.forgetLocal()).remoteRevocationConfirmed,
        false,
      );
      assert.equal(savedSecret, undefined);
    } finally {
      local.close();
    }
    assert.equal(
      (
        await call(
          "/device/missing",
          {},
          { "X-Forwarded-For": "192.0.2.1" },
          limited,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await call(
          "/device/missing",
          {},
          { "X-Forwarded-For": "192.0.2.2" },
          limited,
        )
      ).status,
      404,
    );
    const exhausted = await call(
      "/device/missing",
      {},
      { "X-Forwarded-For": "192.0.2.3" },
      limited,
    );
    assert.equal(exhausted.status, 429);
    assert.ok(exhausted.headers["retry-after"]);
  } finally {
    for (const s of servers) {
      s.closeAllConnections();
      if (s.listening)
        await new Promise<void>((resolve, reject) =>
          s.close((e) => (e ? reject(e) : resolve())),
        );
    }
    await rm(temp, { recursive: true, force: true });
  }
}
