import express from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { localApi, type LocalApiOptions } from "./http.js";
const equal = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function dashboardServer(
  options: LocalApiOptions & {
    assets: string;
    pairCode: string;
    now?: () => number;
  },
) {
  const app = express(),
    now = options.now ?? Date.now,
    expiry = now() + 10 * 60_000;
  let attempts = 0,
    paired = false,
    session = "";
  const origin = `http://127.0.0.1:${options.port}`,
    cookieName = `bittrees_ai_${options.port}`;
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    if (
      req.headers.host !== `127.0.0.1:${options.port}` ||
      (req.headers.origin && req.headers.origin !== origin)
    )
      return res.status(403).json({ error: "FORBIDDEN" });
    if (!["GET", "HEAD"].includes(req.method) && req.headers.origin !== origin)
      return res.status(403).json({ error: "FORBIDDEN" });
    next();
  });
  app.post("/pair", express.json({ limit: "1kb" }), (req, res) => {
    if (
      paired ||
      now() >= expiry ||
      ++attempts > 10 ||
      typeof req.body?.code !== "string" ||
      !equal(req.body.code, options.pairCode)
    )
      return res.status(403).json({ error: "PAIRING_DENIED" });
    paired = true;
    session = randomBytes(32).toString("hex");
    res.set(
      "Set-Cookie",
      `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
    );
    res.status(204).end();
  });
  const sessionExpiry = now() + 8 * 60 * 60_000;
  app.use((req, res, next) => {
    const cookie =
      (req.headers.cookie ?? "")
        .split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith(cookieName + "="))
        ?.slice(cookieName.length + 1) ?? "";
    if (session && now() < sessionExpiry && equal(cookie, session))
      req.headers.authorization = "Bearer " + options.token;
    if (req.path === "/logout") {
      if (
        req.method !== "POST" ||
        req.headers.authorization !== "Bearer " + options.token
      )
        return res.status(401).json({ error: "UNAUTHORIZED" });
      session = "";
      options.privateKeys?.invalidate();
      res.set(
        "Set-Cookie",
        `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      );
      return res.status(204).end();
    }
    next();
  });
  const api = localApi(options);
  app.use("/v1", (req, res, next) => {
    req.url = "/v1" + req.url;
    api(req, res, next);
  });
  app.use(
    express.static(options.assets, { index: "index.html", dotfiles: "deny" }),
  );
  app.use((_req, res) => res.status(404).end());
  app.use(((
    _err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) =>
    res
      .status(400)
      .json({ error: "INVALID_INPUT" })) as express.ErrorRequestHandler);
  return app;
}
