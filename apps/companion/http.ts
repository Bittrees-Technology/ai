import type { MailConnector } from "../../modules/connectors/mail.js";
import type { MailTasks } from "../../modules/connectors/mail-tasks.js";
import type { RolesConnector } from "../../modules/connectors/roles.js";
import { AutoNoteReviews } from "../../modules/connectors/autonote-reviews.js";
import type { AutoNoteConnector } from "../../modules/connectors/autonote.js";
import type { AutoNoteTasks } from "../../modules/connectors/autonote-tasks.js";
import { SourceTasks } from "../../modules/connectors/source-tasks.js";
import { ImportError } from "../../modules/models/imports.js";
import type { ImportJobs } from "../../modules/models/jobs.js";
import { CrmPublications } from "../../modules/connectors/crm-publications.js";
import express, { type ErrorRequestHandler } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { z, ZodError } from "zod";
import { Store, StoreError, type Owner } from "../../modules/storage/store.js";
import { requestSchema } from "../../modules/contracts/index.js";
import { MemoryStore } from "../../modules/memory/store.js";
import { Ollama, ModelError } from "../../modules/models/ollama.js";
import type { CrmTasks } from "../../modules/connectors/crm-tasks.js";
import type { Task } from "../../modules/storage/store.js";
import { CrmConnector, ConnectorError } from "../../modules/connectors/crm.js";
export interface LocalApiOptions {
  deviceStatus?: () => Promise<import("./device.js").DeviceStatus>;
  imports?: ImportJobs;
  roles?: RolesConnector;
  mail?: MailConnector;
  mailSources?: MailTasks;
  crm?: CrmConnector;
  sources?: CrmTasks;
  autonote?: AutoNoteConnector;
  autonoteSources?: AutoNoteTasks;
  cancelSourceRun?: (app?: "crm" | "autonote" | "mail") => void;
  store: Store;
  owner: Owner;
  token: string;
  port: number;
  memory?: MemoryStore;
  runtime?: Pick<Ollama, "listModels" | "pin">;
  cancelRun?: (id: string) => void;
}
export function localApi({
  store,
  owner,
  token,
  port,
  memory,
  runtime,
  cancelRun,
  crm,
  roles,
  mail,
  mailSources,
  sources,
  autonote,
  autonoteSources,
  cancelSourceRun,
  deviceStatus,
  imports,
}: LocalApiOptions) {
  if (token.length < 32) throw new Error("A strong local token is required");
  const publications =
    crm && sources
      ? new CrmPublications(store, owner, crm, sources)
      : undefined;
  const autoReviews =
    autonote && autonoteSources
      ? new AutoNoteReviews(store, owner, autonote, autonoteSources)
      : undefined;
  const sourceRouter = new SourceTasks(sources, autonoteSources, mailSources);
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
  if (deviceStatus)
    app.get("/v1/device", async (_req, res) => res.json(await deviceStatus()));
  if (imports) {
    app.get("/v1/imports", (_req, res) => res.json({ items: imports.list() }));
    app.post("/v1/imports/local", (req, res) =>
      res.status(202).json(imports.local(req.body)),
    );
    app.post("/v1/imports/huggingface", (req, res) =>
      res.status(202).json(imports.huggingface(req.body)),
    );
    for (const action of ["download", "install"] as const)
      app.post(`/v1/imports/:id/${action}`, (req, res) => {
        const { digest } = z
          .strictObject({ digest: z.string().regex(/^[a-f0-9]{64}$/) })
          .parse(req.body);
        res.status(202).json(imports[action](req.params.id, digest));
      });
    app.post("/v1/imports/:id/reconcile", (req, res) => {
      z.strictObject({}).parse(req.body);
      res.status(202).json(imports.reconcile(req.params.id));
    });
    app.post("/v1/imports/:id/cancel", async (req, res) => {
      z.strictObject({}).parse(req.body);
      res.json(await imports.cancel(req.params.id));
    });
    app.delete("/v1/imports/:id", async (req, res) => {
      if (req.header("X-Confirm-Delete") !== "local-import-record-and-files")
        throw new StoreError("INVALID_INPUT");
      await imports.remove(req.params.id);
      res.status(204).end();
    });
  }
  app.get("/v1/health", (_req, res) =>
    res.json({
      status: "ok",
      mode: "local",
      connectorsEnabled: !!crm || !!autonote || !!roles || !!mail,
    }),
  );
  for (const [name, connector] of [
    ["crm", crm],
    ["autonote", autonote],
    ["roles", roles],
    ["mail", mail],
  ] as const) {
    app.get(`/v1/connections/${name}`, async (_req, res) => {
      res.json({
        available: !!connector,
        connection: connector ? await connector.status() : null,
      });
    });
    if (connector) {
      app.post(`/v1/connections/${name}/begin`, async (req, res) => {
        if (name === "roles" && roles) {
          const options = z
            .strictObject({ includePolicy: z.boolean().optional() })
            .parse(req.body);
          res.json(await roles.begin(options));
        } else {
          z.strictObject({}).parse(req.body);
          res.json(await connector.begin());
        }
      });
      app.post(`/v1/connections/${name}/finish`, async (req, res) => {
        const body = z
          .strictObject({
            id: z.uuid(),
            code: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .parse(req.body);
        res.json(await connector.finish(body.id, body.code));
      });
      app.post(`/v1/connections/${name}/disconnect`, async (req, res) => {
        z.strictObject({}).parse(req.body);
        if (name !== "roles") cancelSourceRun?.(name);
        await connector.disconnect();
        res.status(204).end();
      });
      app.delete(`/v1/connections/${name}/local`, async (req, res) => {
        if (req.header("X-Confirm-Delete") !== `local-${name}-credential`)
          throw new StoreError("INVALID_INPUT");
        if (name !== "roles") cancelSourceRun?.(name);
        await connector.forgetLocal();
        res.status(204).end();
      });
    }
  }
  if (roles) {
    app.post("/v1/connections/roles/policy", async (req, res) => {
      z.strictObject({}).parse(req.body);
      res.json(await roles.readPolicy());
    });
    app.post("/v1/connections/roles/access", async (req, res) => {
      z.strictObject({}).parse(req.body);
      res.json(await roles.read());
    });
  }
  const concealed = (task: Task) =>
    task.input.sourceRefs.length
      ? {
          ...task,
          input: { ...task.input, sourceRefs: [] },
          result: null,
          sourceAccess: "unavailable",
          sourceBound: true,
          sourceApp: task.input.sourceRefs[0]?.app,
        }
      : task;
  const project = async (task: Task) => {
    if (!task.input.sourceRefs.length) return task;
    try {
      const binding = store.sourceBinding(owner, task.id);
      if (!binding) return concealed(task);
      await sourceRouter.validate(binding);
      return {
        ...task,
        sourceAccess: "current",
        sourceBound: true,
        sourceApp: binding.authority.sourceApp,
      };
    } catch {
      return concealed(task);
    }
  };
  if (sources) {
    app.post("/v1/connections/crm/records", async (req, res) => {
      z.strictObject({}).parse(req.body);
      res.json({ items: await sources.choices() });
    });
    app.post("/v1/connections/crm/drafts", async (req, res) => {
      const body = z
        .strictObject({
          conversationId: z.uuid(),
          recordIds: z
            .array(z.uuid())
            .min(1)
            .max(100)
            .refine((ids) => new Set(ids).size === ids.length),
          prompt: z.string().min(1).max(32000),
          modelProfileId: z.string().min(1).max(128),
        })
        .parse(req.body);
      store.profile(owner, body.modelProfileId);
      const task = await sources.create(
        store,
        {
          conversationId: body.conversationId,
          kind: "draft",
          prompt: body.prompt,
          modelProfileId: body.modelProfileId,
          dependencies: [],
          priority: "normal",
          tags: [],
        },
        body.recordIds,
        req.header("Idempotency-Key") ?? "",
      );
      res.status(202).json(concealed(task));
    });
  }
  if (mail) {
    app.post("/v1/connections/mail/selection", async (req, res) => {
      z.strictObject({}).parse(req.body);
      // Selection display reads metadata only; body scope is never exercised implicitly.
      const source = await mail.read("metadata");
      res.json({
        mailbox: source.mailbox,
        folder: source.folder,
        scopes: source.scopes,
        expiresAt: source.expiresAt,
        message: source.message,
      });
    });
  }
  if (mailSources) {
    app.post("/v1/connections/mail/drafts", async (req, res) => {
      const body = z
        .strictObject({
          conversationId: z.uuid(),
          kind: z.enum(["summarize", "draft"]),
          content: z.enum(["metadata", "plain", "attachment-text"]),
          prompt: z.string().min(1).max(32000),
          modelProfileId: z.string().min(1).max(128),
        })
        .parse(req.body);
      store.profile(owner, body.modelProfileId);
      const task = await mailSources.create(
        store,
        {
          conversationId: body.conversationId,
          kind: body.kind,
          prompt: body.prompt,
          modelProfileId: body.modelProfileId,
          dependencies: [],
          priority: "normal",
          tags: [],
        },
        body.content,
        req.header("Idempotency-Key") ?? "",
      );
      res.status(202).json(concealed(task));
    });
  }
  if (autonoteSources) {
    app.post("/v1/connections/autonote/meetings", async (req, res) => {
      z.strictObject({}).parse(req.body);
      res.json({ items: await autonoteSources.choices() });
    });
    app.post("/v1/connections/autonote/drafts", async (req, res) => {
      const body = z
        .strictObject({
          conversationId: z.uuid(),
          meetingId: z.uuid(),
          prompt: z.string().min(1).max(32000),
          modelProfileId: z.string().min(1).max(128),
        })
        .parse(req.body);
      store.profile(owner, body.modelProfileId);
      const task = await autonoteSources.create(
        store,
        {
          conversationId: body.conversationId,
          kind: "summarize",
          prompt: body.prompt,
          modelProfileId: body.modelProfileId,
          dependencies: [],
          priority: "normal",
          tags: [],
        },
        body.meetingId,
        req.header("Idempotency-Key") ?? "",
      );
      res.status(202).json(concealed(task));
    });
  }
  if (publications) {
    // Receipt metadata is available for reconciliation even when current source content is hidden.
    const summary = (
      item: import("../../modules/storage/store.js").Publication,
    ) => ({
      id: item.id,
      state: item.state,
      prepared: item.prepared
        ? {
            expiresAt: item.prepared.expiresAt,
            reviewUrl:
              "https://crm.bittrees.org/connect/ai?review=" +
              item.prepared.reviewId,
          }
        : null,
      receipt: item.receipt,
    });
    app.get("/v1/requests/:id/publications", (req, res) => {
      res.json({
        items: store.publications(owner, req.params.id).map(summary),
      });
    });
    app.post("/v1/requests/:id/write-permission", async (req, res) => {
      z.strictObject({}).parse(req.body);
      res.json(await publications.permission(req.params.id));
    });
    app.post("/v1/requests/:id/publications", async (req, res) => {
      res
        .status(201)
        .json(summary(await publications.reserve(req.params.id, req.body)));
    });
    app.post("/v1/publications/:id/prepare", async (req, res) => {
      z.strictObject({}).parse(req.body);
      res.json(summary(await publications.prepare(req.params.id)));
    });
    app.post("/v1/publications/:id/publish", async (req, res) => {
      z.strictObject({}).parse(req.body);
      res.json(summary(await publications.publish(req.params.id)));
    });
  }
  if (autoReviews) {
    const summary = (
      item: import("../../modules/storage/store.js").AutoNoteReview,
    ) => ({
      id: item.id,
      state: item.state,
      review: item.response
        ? {
            expiresAt: item.response.expiresAt,
            reviewUrl:
              "https://autonote.bittrees.org/connect/ai?review=" +
              item.response.reviewId,
          }
        : null,
      receipt: item.response?.receipt ?? null,
    });
    app.get("/v1/requests/:id/autonote-reviews", (req, res) =>
      res.json({
        items: store.autoNoteReviews(owner, req.params.id).map(summary),
      }),
    );
    app.post("/v1/requests/:id/autonote-reviews", async (req, res) =>
      res
        .status(201)
        .json(summary(await autoReviews.reserve(req.params.id, req.body))),
    );
    app.get("/v1/autonote-reviews/:id/content", async (req, res) => {
      const item = store.autoNoteReview(owner, req.params.id),
        binding = store.sourceBinding(owner, item.taskId);
      if (!binding) throw new ConnectorError("SOURCE_DENIED");
      await autonoteSources!.validate(binding);
      res.json({ proposal: item.proposal });
    });
    for (const action of ["prepare", "reconcile"] as const)
      app.post(`/v1/autonote-reviews/:id/${action}`, async (req, res) => {
        z.strictObject({}).parse(req.body);
        res.json(summary(await autoReviews[action](req.params.id)));
      });
  }
  app.get("/v1/requests/:id/export", async (req, res) => {
    const task = await project(store.get(owner, req.params.id));
    if ("sourceAccess" in task && task.sourceAccess === "unavailable")
      throw new ConnectorError("SOURCE_DENIED");
    res.json({
      task,
      runs: store.runHistory(owner, req.params.id),
      publications: store.publications(owner, req.params.id),
      autonoteReviews: store.autoNoteReviews(owner, req.params.id),
    });
  });
  app.post("/v1/requests", (req, res) => {
    const body = requestSchema.parse(req.body);
    // Source authority is constructed only through the dedicated trusted adapter.
    if (body.sourceRefs.length)
      return res
        .status(403)
        .json({ error: "FORBIDDEN", correlationId: res.locals.correlationId });
    if (body.memoryIds?.length && !memory)
      throw new StoreError("INVALID_INPUT");
    res
      .status(202)
      .json(store.create(owner, body, req.header("Idempotency-Key") ?? ""));
  });
  app.get("/v1/requests", (_req, res) =>
    res.json({ items: store.list(owner).map(concealed) }),
  );
  app.get("/v1/requests/:id", async (req, res) =>
    res.json(await project(store.get(owner, req.params.id))),
  );
  app.post("/v1/requests/:id/commands", async (req, res) => {
    const task = store.command(owner, req.params.id, req.body);
    if (task.status === "cancelled" || task.status === "paused")
      cancelRun?.(task.id);
    res.json(await project(task));
  });
  app.get("/v1/requests/:id/runs", async (req, res) => {
    const task = await project(store.get(owner, req.params.id));
    res.json({
      items:
        "sourceAccess" in task && task.sourceAccess === "unavailable"
          ? []
          : store.runHistory(owner, req.params.id),
    });
  });
  app.post("/v1/requests/:id/model", async (req, res) => {
    const body = z
      .strictObject({
        profileId: z.string(),
        expectedRevision: z.number().int().positive(),
      })
      .parse(req.body);
    const task = store.switchModel(
      owner,
      req.params.id,
      body.profileId,
      body.expectedRevision,
    );
    cancelRun?.(task.id);
    res.json(await project(task));
  });
  app.get("/v1/models", async (_req, res) => {
    if (!runtime) throw new ModelError("MODEL_UNAVAILABLE");
    res.json({ items: await runtime.listModels() });
  });
  app.get("/v1/profiles", (_req, res) =>
    res.json({
      items: store.profiles(owner),
      defaultProfile: store.defaultProfile(owner),
    }),
  );
  app.post("/v1/profiles", async (req, res) => {
    if (!runtime) throw new ModelError("MODEL_UNAVAILABLE");
    const pinned = await runtime.pin(req.body);
    res.status(201).json(store.addProfile(owner, pinned.profile));
  });
  app.put("/v1/profiles/default", (req, res) => {
    const body = z.strictObject({ profileId: z.string() }).parse(req.body);
    store.setDefaultProfile(owner, body.profileId);
    res.status(204).end();
  });
  if (memory) {
    app.get("/v1/memories", async (_req, res) =>
      res.json({ items: await memory.export(owner) }),
    );
    app.post("/v1/memories/search", async (req, res) => {
      const body = z
        .strictObject({ query: z.string().max(512) })
        .parse(req.body);
      res.json({ items: await memory.search(owner, body.query) });
    });
    app.post("/v1/requests/:id/memories", async (req, res) => {
      const body = z
        .strictObject({
          text: z.string().min(1).max(16000),
          type: z.enum([
            "preference",
            "fact",
            "decision",
            "outcome",
            "procedure",
          ]),
        })
        .parse(req.body);
      const task = store.get(owner, req.params.id);
      if (task.status !== "completed" || task.input.sourceRefs.length)
        throw new StoreError("CONFLICT");
      res.status(201).json(
        await memory.add(owner, {
          ...body,
          origin: "user",
          sources: [
            {
              app: "local",
              tenantId: owner.tenantId,
              resourceId: task.id,
              revision: String(task.revision),
            },
          ],
        }),
      );
    });
    app.patch("/v1/memories/:id", async (req, res) => {
      const body = z
        .strictObject({
          revision: z.number().int().positive(),
          approve: z.boolean().optional(),
          text: z.string().min(1).max(16000).optional(),
          pinned: z.boolean().optional(),
        })
        .parse(req.body);
      const { revision, ...change } = body;
      res.json(await memory.review(owner, req.params.id, revision, change));
    });
    app.delete("/v1/memories/:id", (req, res) => {
      memory.forget(owner, req.params.id);
      res.status(204).end();
    });
    app.post("/v1/memories/:id/feedback", async (req, res) => {
      const body = z
        .strictObject({
          id: z.string(),
          outcome: z.enum(["accepted", "edited", "rejected"]),
        })
        .parse(req.body);
      await memory.feedback(owner, req.params.id, body.id, body.outcome);
      res.status(204).end();
    });
    app.delete("/v1/memories", (req, res) => {
      if (req.header("X-Confirm-Delete") !== "all-local-memory")
        throw new StoreError("INVALID_INPUT");
      memory.deleteAll(owner);
      res.status(204).end();
    });
  }
  app.get("/v1/events", (req, res) => {
    const after = Number(req.query.after ?? 0);
    if (!Number.isSafeInteger(after) || after < 0)
      throw new StoreError("INVALID_INPUT");
    res.json({ items: store.events(owner, after) });
  });

  app.get("/v1/inboxes", (_req, res) =>
    res.json({ items: store.inboxes(owner) }),
  );
  app.post("/v1/inboxes/personal", (_req, res) =>
    res.status(201).json(
      store.createInbox(owner, {
        id: "personal",
        tenantId: owner.tenantId,
        ownerId: owner.userId,
        ownerType: "user",
        memberUserIds: [owner.userId],
      }),
    ),
  );
  app.get("/v1/inboxes/:id/conversations", (req, res) =>
    res.json({ items: store.inboxConversations(owner, req.params.id) }),
  );
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
  app.get("/v1/export", async (_req, res) =>
    res.json({
      tasks: store.export(owner).map(concealed),
      messages: store.exportMessages(owner),
      profiles: store.profiles(owner),
      defaultProfile: store.defaultProfile(owner),
      memories: memory ? await memory.export(owner) : [],
    }),
  );
  app.delete("/v1/data", (req, res) => {
    if (req.header("X-Confirm-Delete") !== "all-local-task-data")
      throw new StoreError("INVALID_INPUT");
    if (publications?.busy || autoReviews?.busy)
      throw new StoreError("CONFLICT");
    memory?.deleteAll(owner);
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
      err instanceof ImportError ||
      err instanceof StoreError ||
      err instanceof ModelError ||
      err instanceof ConnectorError
        ? err.code
        : err instanceof ZodError || err instanceof SyntaxError
          ? "INVALID_INPUT"
          : "INTERNAL";
    const status =
      code === "MODEL_UNAVAILABLE"
        ? 503
        : code === "NOT_FOUND"
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
