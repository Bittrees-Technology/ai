import express, { type ErrorRequestHandler } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import { Store, StoreError, type Owner } from "../../modules/storage/store.js";
import { requestSchema } from "../../modules/contracts/index.js";
export interface LocalApiOptions {
  store: Store;
  owner: Owner;
  token: string;
  port: number;
}
export function localApi({ store, owner, token, port }: LocalApiOptions) {
  if (token.length < 32) throw new Error("A strong local token is required");
  const app = express();
  app.disable("x-powered-by");
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([...hosts].map((h) => "http://" + h));
  app.use((req, res, next) => {
    res.locals.correlationId = randomUUID();
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    const reject = (status: number, error: string) => {
      res
        .status(status)
        .json({ error, correlationId: res.locals.correlationId });
    };
    if (
      !hosts.has(req.headers.host ?? "") ||
      (req.headers.origin && !origins.has(req.headers.origin))
    )
      return reject(403, "FORBIDDEN");
    const actual = Buffer.from(req.headers.authorization ?? ""),
      expected = Buffer.from("Bearer " + token);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return reject(401, "UNAUTHORIZED");
    next();
  });
  app.use(express.json({ limit: "64kb", strict: true }));
  app.get("/v1/health", (_req, res) =>
    res.json({ status: "ok", mode: "local", connectorsEnabled: false }),
  );
  app.post("/v1/requests", (req, res) => {
    const body = requestSchema.parse(req.body);
    // Source adapters and delegation revalidation are not implemented in this increment.
    if (body.sourceRefs.length)
      return res
        .status(403)
        .json({ error: "FORBIDDEN", correlationId: res.locals.correlationId });
    res
      .status(202)
      .json(store.create(owner, body, req.header("Idempotency-Key") ?? ""));
  });
  app.get("/v1/requests", (_req, res) =>
    res.json({ items: store.list(owner) }),
  );
  app.get("/v1/requests/:id", (req, res) =>
    res.json(store.get(owner, req.params.id)),
  );
  app.post("/v1/requests/:id/commands", (req, res) =>
    res.json(store.command(owner, req.params.id, req.body)),
  );
  app.get("/v1/events", (req, res) => {
    const after = Number(req.query.after ?? 0);
    if (!Number.isSafeInteger(after) || after < 0)
      throw new StoreError("INVALID_INPUT");
    res.json({ items: store.events(owner, after) });
  });
  app.post("/v1/inboxes", (req, res) =>
    res.status(201).json(store.createInbox(owner, req.body)),
  );
  app.post("/v1/messages", (req, res) =>
    res
      .status(201)
      .json(
        store.appendMessage(
          owner,
          req.body,
          req.header("Idempotency-Key") ?? "",
        ),
      ),
  );
  app.get("/v1/messages", (req, res) => {
    const after = Number(req.query.after ?? 0);
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      typeof req.query.inboxId !== "string" ||
      typeof req.query.conversationId !== "string"
    )
      throw new StoreError("INVALID_INPUT");
    res.json({
      items: store.messages(
        owner,
        req.query.inboxId,
        req.query.conversationId,
        after,
      ),
    });
  });
  app.post("/v1/messages/:id/receipts", (req, res) => {
    const kind = req.body?.kind;
    if (!["delivered", "read", "acknowledged"].includes(kind))
      throw new StoreError("INVALID_INPUT");
    store.receipt(owner, req.params.id, kind);
    res.status(204).end();
  });
  app.get("/v1/checkins", (_req, res) =>
    res.json({ items: store.checkins(owner) }),
  );
  app.get("/v1/export", (_req, res) =>
    res.json({
      tasks: store.export(owner),
      messages: store.exportMessages(owner),
    }),
  );
  app.delete("/v1/data", (req, res) => {
    if (req.header("X-Confirm-Delete") !== "all-local-task-data")
      throw new StoreError("INVALID_INPUT");
    store.deleteAll(owner);
    res.status(204).end();
  });
  app.use((_req, res) =>
    res
      .status(404)
      .json({ error: "NOT_FOUND", correlationId: res.locals.correlationId }),
  );
  const errors: ErrorRequestHandler = (err, _req, res, _next) => {
    const code =
      err instanceof StoreError
        ? err.code
        : err instanceof ZodError || err instanceof SyntaxError
          ? "INVALID_INPUT"
          : "INTERNAL";
    const status =
      code === "NOT_FOUND"
        ? 404
        : code === "CONFLICT" || code === "STALE_CLAIM"
          ? 409
          : code === "INTERNAL"
            ? 500
            : 400;
    // Do not echo parser errors, submitted content, headers or secrets into responses/logs.
    res
      .status(status)
      .json({ error: code, correlationId: res.locals.correlationId });
  };
  app.use(errors);
  return app;
}
