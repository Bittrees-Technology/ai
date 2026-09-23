import { RemoteBrowserDeviceStore } from "./browser-devices.js";
import { RemoteTemplateStore } from "./templates.js";
import { resolve } from "node:path";
import express, { type Request, type Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { RemoteSessionStore } from "./sessions.js";
import { RemoteCommandStore } from "./commands.js";
import { remoteControlSchema } from "./status.js";
import { RemoteDeviceStore } from "./devices.js";
import { RemoteStatusError, RemoteStatusStore } from "./status-store.js";
const loginCookie = "__Host-bittrees-login",
  sessionCookie = "__Host-bittrees-session",
  browserDeviceCookie = "__Host-bittrees-browser-device";
const opaque = /^[A-Za-z0-9_-]{43}$/;
function cookie(req: Request, name: string) {
  const values = (req.headers.cookie ?? "")
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x.startsWith(name + "="));
  if (values.length !== 1) throw new RemoteStatusError("DENIED");
  return values[0]!.slice(name.length + 1);
}
function token(req: Request) {
  const header = req.headers.authorization ?? "";
  if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(header))
    throw new RemoteStatusError("DENIED");
  return header.slice(7);
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RemoteStatusError("INVALID_INPUT");
  return result.data;
}
/** No listener or migrations. Direct TLS only; deliberately does not trust proxy headers. */
export function createRemoteApp(
  pool: Pool,
  config: {
    assets?: string;
    origin: string;
    chainId: number;
    sessionMs: number;
    deviceMs: number;
    retentionMs: number;
    requestsPerMinute?: number;
    quotas?: {
      pendingPairings: number;
      devicesPerOwner: number;
      statusesPerDevice: number;
    };
    templateQuotas?: {
      permissionsPerDevice: number;
      commandsPerDevice: number;
      pendingPerDevice: number;
    };
    now?: () => number;
  },
) {
  const now = config.now ?? Date.now;
  const sessions = new RemoteSessionStore(
    pool,
    config.origin,
    config.chainId,
    config.sessionMs,
    now,
  );
  const devices = new RemoteDeviceStore(
    pool,
    config.deviceMs,
    now,
    config.quotas,
  );
  const status = new RemoteStatusStore(
    pool,
    config.retentionMs,
    now,
    config.quotas?.statusesPerDevice,
  );
  const commands = new RemoteCommandStore(pool, config.retentionMs, now);
  const templates = new RemoteTemplateStore(
    pool,
    config.retentionMs,
    now,
    config.templateQuotas,
  );
  const browserDevices = new RemoteBrowserDeviceStore(
    pool,
    config.origin,
    config.chainId,
    config.deviceMs,
    now,
    config.quotas?.devicesPerOwner,
  );
  const host = new URL(config.origin).host;
  const budget = config.requestsPerMinute ?? 120;
  if (!Number.isInteger(budget) || budget < 1 || budget > 1000)
    throw new RemoteStatusError("INVALID_INPUT");
  const counts = new Map<string, { count: number; until: number }>();
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Strict-Transport-Security": "max-age=31536000",
    });
    if (!req.secure || req.headers.host !== host)
      return res.status(403).json({ error: "DENIED" });
    const time = now();
    for (const [key, value] of counts)
      if (value.until <= time) counts.delete(key);
    const peer = req.socket.remoteAddress ?? "unknown";
    let entry = counts.get(peer);
    if (!entry) {
      if (counts.size >= 4096)
        return res.status(429).json({ error: "RATE_LIMITED" });
      entry = { count: 0, until: time + 60000 };
      counts.set(peer, entry);
    }
    if (++entry.count > budget) {
      res.set(
        "Retry-After",
        String(Math.max(1, Math.ceil((entry.until - time) / 1000))),
      );
      return res.status(429).json({ error: "RATE_LIMITED" });
    }
    if (req.method === "GET" && config.assets) {
      if (req.path === "/settings.json")
        return res.json({ origin: config.origin, chainId: config.chainId });
      const files: Record<string, string> = {
        "/": "index.html",
        "/app.js": "app.js",
      };
      const file = Object.hasOwn(files, req.path)
        ? files[req.path]
        : /^\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(
              req.path,
            )
          ? req.path.slice(1)
          : undefined;
      if (file) {
        res.set(
          "Content-Security-Policy",
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        );
        return res.sendFile(file, {
          root: resolve(config.assets),
          dotfiles: "deny",
          cacheControl: false,
          lastModified: false,
        });
      }
    }
    if (req.method !== "POST")
      return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
    if (!req.is("application/json"))
      return res.status(415).json({ error: "JSON_REQUIRED" });
    if (req.path.startsWith("/browser/")) {
      if (
        req.headers.origin !== config.origin ||
        req.headers["x-bittrees-request"] !== "1" ||
        req.headers.authorization ||
        (req.headers["sec-fetch-site"] &&
          req.headers["sec-fetch-site"] !== "same-origin")
      )
        return res.status(403).json({ error: "DENIED" });
    } else if (req.path.startsWith("/device/")) {
      if (
        req.headers.origin ||
        req.headers.cookie ||
        req.headers["sec-fetch-site"]
      )
        return res.status(403).json({ error: "DENIED" });
    } else return res.status(404).json({ error: "NOT_FOUND" });
    next();
  });
  app.use(express.json({ limit: "32kb", strict: true, inflate: false }));
  const cookieOptions = {
    secure: true,
    httpOnly: true,
    sameSite: "strict" as const,
    path: "/",
  };
  const owner = async (req: Request) => {
    const auth = await sessions.authenticate(cookie(req, sessionCookie));
    if (req.headers["x-bittrees-account"] !== auth.ownerId)
      throw new RemoteStatusError("DENIED");
    return auth;
  };
  app.post("/browser/login/challenge", async (req, res) => {
    const input = parse(
      z.strictObject({ address: z.string().max(42) }),
      req.body,
    );
    const challenge = await sessions.begin(input.address);
    res.cookie(loginCookie, challenge.id + "." + challenge.browserToken, {
      ...cookieOptions,
      maxAge: 300000,
    });
    res.json({
      id: challenge.id,
      message: challenge.message,
      expiresAt: challenge.expiresAt,
    });
  });
  app.post("/browser/login/verify", async (req, res) => {
    const input = parse(
      z.strictObject({
        message: z.string().max(2048),
        signature: z.string().max(132),
      }),
      req.body,
    );
    const [id, browserToken, extra] = cookie(req, loginCookie).split(".");
    if (extra || !browserToken || !opaque.test(browserToken))
      throw new RemoteStatusError("DENIED");
    const verified = await sessions.verify({ id, browserToken, ...input });
    res.clearCookie(loginCookie, cookieOptions);
    res.cookie(sessionCookie, verified.token, {
      ...cookieOptions,
      maxAge: Math.max(0, verified.expiresAt - now()),
    });
    res.json({ ownerId: verified.ownerId, expiresAt: verified.expiresAt });
  });
  app.post("/browser/session", async (req, res) => {
    parse(z.strictObject({}), req.body);
    res.json(await sessions.identity(cookie(req, sessionCookie)));
  });
  app.post("/browser/logout", async (req, res) => {
    parse(z.strictObject({}), req.body);
    // Clearing an already absent session is successful too. Still reject
    // malformed/ambiguous supplied credentials instead of selecting one.
    const supplied = (req.headers.cookie ?? "")
      .split(";")
      .some((part) => part.trim().startsWith(sessionCookie + "="));
    if (supplied) await sessions.logout(cookie(req, sessionCookie));
    res.clearCookie(sessionCookie, cookieOptions);
    res.clearCookie(loginCookie, cookieOptions);
    res.json({ loggedOut: true });
  });
  const browserCredential = (req: Request) => {
    const parts = (req.headers.cookie ?? "")
      .split(";")
      .map((x) => x.trim())
      .filter((x) => x.startsWith(browserDeviceCookie + "="));
    if (!parts.length) return null;
    return cookie(req, browserDeviceCookie);
  };
  const browserAuthority = (req: Request) => {
    const account = req.headers["x-bittrees-account"];
    if (typeof account !== "string") throw new RemoteStatusError("DENIED");
    return { session: cookie(req, sessionCookie), account };
  };
  app.post("/browser/registration/inspect", async (req, res) => {
    parse(z.strictObject({}), req.body);
    const { session, account } = browserAuthority(req);
    res.json(
      await browserDevices.inspect(session, account, browserCredential(req)),
    );
  });
  app.post("/browser/registration/identity", async (req, res) => {
    parse(z.strictObject({}), req.body);
    const { session, account } = browserAuthority(req);
    res.json(
      await browserDevices.identify(session, account, browserCredential(req)),
    );
  });
  app.post("/browser/registration/create", async (req, res) => {
    const { session, account } = browserAuthority(req);
    const made = await browserDevices.register(
      session,
      account,
      browserCredential(req),
      req.body,
    );
    res.cookie(browserDeviceCookie, made.credential, {
      ...cookieOptions,
      maxAge: Math.max(0, made.identity.binding.expiresAt - now()),
    });
    res.json(made.identity);
  });
  app.post("/browser/registration/list", async (req, res) => {
    const { session, account } = browserAuthority(req);
    res.json(await browserDevices.list(session, account, req.body));
  });
  app.post("/browser/registration/revoke", async (req, res) => {
    const { session, account } = browserAuthority(req);
    res.json(await browserDevices.revoke(session, account, req.body));
  });
  app.post("/browser/pairings/approve", async (req, res) => {
    const input = parse(
      z.strictObject({
        id: z.uuid(),
        approvalCode: z.string().max(43),
        confirmed: z.literal(true),
      }),
      req.body,
    );
    const auth = await owner(req);
    await devices.approve(auth.ownerId, input.id, input.approvalCode);
    res.json({ approved: true, ownerId: auth.ownerId });
  });
  app.post("/browser/pairings/cancel", async (req, res) => {
    const input = parse(z.strictObject({ id: z.uuid() }), req.body);
    await devices.cancel((await owner(req)).ownerId, input.id);
    res.json({ cancelled: true });
  });
  app.post("/browser/devices", async (req, res) => {
    const input = parse(
      z.strictObject({ after: z.uuid().optional() }),
      req.body,
    );
    res.json(await status.devices((await owner(req)).ownerId, input.after));
  });
  app.post("/browser/status", async (req, res) => {
    const input = parse(
      z.strictObject({
        deviceId: z.uuid(),
        after: z.uuid().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      req.body,
    );
    const { deviceId, ...options } = input;
    res.json(
      await status.listPage((await owner(req)).ownerId, deviceId, options),
    );
  });
  app.post("/browser/devices/revoke", async (req, res) => {
    const input = parse(z.strictObject({ deviceId: z.uuid() }), req.body);
    await status.revoke((await owner(req)).ownerId, input.deviceId);
    res.json({ revoked: true });
  });
  app.post("/browser/controls/approve", async (req, res) => {
    const input = parse(
      z.strictObject({
        deviceId: z.uuid(),
        expectedEpoch: z.number().int().positive().max(2147483647),
        confirmed: z.literal(true),
      }),
      req.body,
    );
    res.json(
      await devices.approveControls(
        (await owner(req)).ownerId,
        input.deviceId,
        input.expectedEpoch,
      ),
    );
  });
  app.post("/browser/controls/disable", async (req, res) => {
    const input = parse(z.strictObject({ deviceId: z.uuid() }), req.body);
    await devices.disableControls((await owner(req)).ownerId, input.deviceId);
    res.json({ disabled: true });
  });
  app.post("/browser/commands", async (req, res) => {
    const input = parse(
      z.strictObject({
        command: remoteControlSchema,
        confirmed: z.literal(true),
      }),
      req.body,
    );
    res.json(await commands.submit((await owner(req)).ownerId, input.command));
  });
  app.post("/browser/commands/receipt", async (req, res) => {
    const input = parse(z.strictObject({ id: z.uuid() }), req.body);
    res.json(await commands.inspect((await owner(req)).ownerId, input.id));
  });
  app.post("/browser/templates", async (req, res) => {
    const input = parse(
      z.strictObject({ deviceId: z.uuid(), after: z.uuid().optional() }),
      req.body,
    );
    res.json(
      await templates.list(
        (await owner(req)).ownerId,
        input.deviceId,
        input.after,
      ),
    );
  });
  app.post("/browser/templates/revoke", async (req, res) => {
    const input = parse(
      z.strictObject({ permissionId: z.uuid(), confirmed: z.literal(true) }),
      req.body,
    );
    res.json(
      await templates.revoke((await owner(req)).ownerId, input.permissionId),
    );
  });
  app.post("/browser/templates/run", async (req, res) => {
    res.json(await templates.submit((await owner(req)).ownerId, req.body));
  });
  app.post("/browser/templates/receipt", async (req, res) => {
    const input = parse(
      z.strictObject({ permissionId: z.uuid(), id: z.uuid() }),
      req.body,
    );
    res.json(
      await templates.inspect(
        (await owner(req)).ownerId,
        input.permissionId,
        input.id,
      ),
    );
  });
  app.post("/device/templates/publish", async (req, res) => {
    res.json(
      await templates.publish(await devices.authenticate(token(req)), req.body),
    );
  });
  app.post("/device/templates/revoke", async (req, res) => {
    const input = parse(
      z.strictObject({ permissionId: z.uuid(), confirmed: z.literal(true) }),
      req.body,
    );
    res.json(
      await templates.revokeFromDevice(
        await devices.authenticate(token(req)),
        input.permissionId,
      ),
    );
  });
  app.post("/device/templates/poll", async (req, res) => {
    parse(z.strictObject({}), req.body);
    res.json(await templates.poll(await templates.authenticate(token(req))));
  });
  app.post("/device/templates/receipt", async (req, res) => {
    res.json(
      await templates.acknowledge(
        await templates.authenticate(token(req)),
        req.body,
      ),
    );
  });
  app.post("/device/controls/enable", async (req, res) => {
    parse(z.strictObject({ confirmed: z.literal(true) }), req.body);
    res.json(await devices.enableControls(token(req)));
  });
  app.post("/device/controls/disable", async (req, res) => {
    parse(z.strictObject({}), req.body);
    const auth = await devices.authenticate(token(req));
    await devices.disableControls(auth.ownerId, auth.deviceId);
    res.json({ disabled: true });
  });
  app.post("/device/commands/poll", async (req, res) => {
    parse(z.strictObject({}), req.body);
    const auth = await devices.authenticateControls(token(req));
    res.json({ identity: auth, commands: await commands.poll(auth) });
  });
  app.post("/device/commands/receipt", async (req, res) => {
    res.json(
      await commands.acknowledge(
        await devices.authenticateControls(token(req)),
        req.body,
      ),
    );
  });
  app.post("/device/pairings", async (req, res) => {
    const input = parse(
      z.strictObject({ challenge: z.string().max(43) }),
      req.body,
    );
    res.json(await devices.begin(input.challenge));
  });
  app.post("/device/redeem", async (req, res) => {
    const input = parse(
      z.strictObject({
        id: z.uuid(),
        verifier: z.string().max(128),
        expectedOwnerId: z.uuid(),
      }),
      req.body,
    );
    res.json(
      await devices.redeem(input.id, input.verifier, input.expectedOwnerId),
    );
  });
  app.post("/device/status", async (req, res) => {
    const auth = await devices.authenticate(token(req));
    res.json(await status.publish(auth, req.body));
  });
  app.post("/device/identity", async (req, res) => {
    parse(z.strictObject({}), req.body);
    res.json(await devices.identify(token(req)));
  });
  app.post("/device/rotate", async (req, res) => {
    parse(z.strictObject({}), req.body);
    res.json(await devices.rotate(token(req)));
  });
  app.use((_req, res) => {
    res.status(404).json({ error: "NOT_FOUND" });
  });
  app.use((error: unknown, _req: Request, res: Response, _next: unknown) => {
    if (error instanceof RemoteStatusError) {
      const code = error.code;
      res
        .status(
          code === "CAPACITY"
            ? 429
            : code === "DENIED"
              ? 403
              : code === "CONFLICT"
                ? 409
                : code === "INVALID_INPUT"
                  ? 400
                  : 503,
        )
        .json({ error: code });
    } else if (
      typeof error === "object" &&
      error &&
      "type" in error &&
      [
        "entity.parse.failed",
        "entity.too.large",
        "encoding.unsupported",
      ].includes(String(error.type))
    ) {
      res.status(400).json({ error: "INVALID_INPUT" });
    } else res.status(503).json({ error: "UNAVAILABLE" });
  });
  return app;
}
