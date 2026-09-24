import {
  CompanionRelayError,
  type CompanionPrivateRelay,
} from "./private-relay.js";
import type { MailSendConnector } from "../../modules/connectors/mail-send.js";
import type { NewsConnector } from "../../modules/connectors/news.js";
import { localTaskDependencies } from "./memory.js";
import type { ExecutionControls } from "./execution-limits.js";
import { PrivatePeerCheckError } from "../../modules/remote/private-peer-checks.js";
import { PrivateKeyError } from "../../modules/remote/private-endpoint-keys.js";
import { PrivateTaskError } from "../../modules/remote/private-task-receiver.js";
import { PrivateResponseError } from "../../modules/remote/private-task-responses.js";
import { PrivateConsentError } from "../../modules/remote/private-task-consent.js";
import type { CompanionPrivateKeys } from "./private-keys.js";
import { PrivateKeyLifecycleError } from "../../modules/remote/private-key-lifecycle.js";
import { readMailEvidence } from "./mail-evidence.js";
import { contentIdPattern, type retainedContent } from "./retained-content.js";
import { MemoryCandidateError } from "../../modules/memory/candidates.js";
import type { RemoteTemplateReceiver } from "../../modules/remote/template-receiver.js";
import { shareTemplateSchema } from "../../modules/remote/template-client-state.js";
import type { RemoteReceiver } from "../../modules/remote/receiver.js";
import {
  RemoteClient,
  RemoteClientError,
} from "../../modules/remote/client.js";
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
import {
  taskQuestionViewSchema,
  taskAnswerInputSchema,
  taskAnswerReceiptSchema,
} from "../../modules/contracts/task-answer.js";
import { MemoryStore } from "../../modules/memory/store.js";
import { Ollama, ModelError } from "../../modules/models/ollama.js";
import type { CrmTasks } from "../../modules/connectors/crm-tasks.js";
import type { Task } from "../../modules/storage/store.js";
import { CrmConnector, ConnectorError } from "../../modules/connectors/crm.js";
export interface LocalApiOptions {
  privateRelay?: CompanionPrivateRelay;
  privateKeys?: CompanionPrivateKeys;
  privateKeyCleanup?: () => Promise<void>;
  retainedCopies?: ReturnType<typeof retainedContent>;
  backupDownload?: () => Promise<Buffer>;
  remote?: RemoteClient;
  receiver?: RemoteReceiver;
  templateReceiver?: RemoteTemplateReceiver;
  executionControls?: ExecutionControls;
  activeTasks?: () => number;
  deviceStatus?: () => Promise<import("./device.js").DeviceStatus>;
  imports?: ImportJobs;
  news?: NewsConnector;
  roles?: RolesConnector;
  mail?: MailConnector;
  mailSend?: MailSendConnector;
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
  privateRelay,
  privateKeys,
  privateKeyCleanup,
  retainedCopies,
  backupDownload,
  store,
  remote,
  receiver,
  templateReceiver,
  owner,
  token,
  port,
  memory,
  runtime,
  cancelRun,
  crm,
  roles,
  news,
  mail,
  mailSend,
  mailSources,
  sources,
  autonote,
  autonoteSources,
  cancelSourceRun,
  deviceStatus,
  executionControls,
  activeTasks,
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
  // A 64KiB envelope payload expands under base64url. Only this authenticated
  // ciphertext route gets the larger bound; ordinary local requests remain 64KiB.
  app.post(
    "/v1/private-tasks/receive",
    express.json({ limit: "96kb", strict: true }),
  );
  // Only explicit, authenticated reviewed-mail preparation accepts the full attachment envelope.
  app.post(
    "/v1/connections/mail-send/prepare",
    express.json({ limit: 1500000, strict: true }),
  );
  app.use(express.json({ limit: "64kb", strict: true }));
  app.get("/v1/private-relay", (_req, res) =>
    res.json(
      privateRelay?.status() ?? {
        available: false,
        canSetup: false,
        canCheckRemote: false,
        transportActive: false,
        state: store.exportPrivateRelayCredentials(owner),
      },
    ),
  );
  app.post("/v1/private-relay/review", async (req, res) => {
    if (!privateRelay) throw new StoreError("CONFLICT");
    res.json(await privateRelay.prepare(req.body));
  });
  app.post("/v1/private-relay/confirm", async (req, res) => {
    if (!privateRelay) throw new StoreError("CONFLICT");
    res.json(await privateRelay.confirm(req.body));
  });
  app.post("/v1/private-relay/inspect-task", async (req, res) => {
    if (!privateRelay || !privateKeys) throw new StoreError("CONFLICT");
    res.json(await privateKeys.inspectRelayedTask(privateRelay, req.body));
  });
  app.post("/v1/private-relay/check-task", async (req, res) => {
    if (!privateRelay || !privateKeys) throw new StoreError("CONFLICT");
    res.json(await privateKeys.checkRelayedTask(privateRelay, req.body));
  });
  app.post("/v1/private-relay/responses/prepare", async (req, res) => {
    if (!privateRelay || !privateKeys) throw new StoreError("CONFLICT");
    res.json(await privateKeys.prepareRelayedResponse(privateRelay, req.body));
  });
  app.post("/v1/private-relay/responses/send", async (req, res) => {
    if (!privateRelay || !privateKeys) throw new StoreError("CONFLICT");
    res.json(await privateKeys.sendRelayedResponse(privateRelay, req.body));
  });
  app.post("/v1/private-relay/cancel-review", (req, res) => {
    z.strictObject({ confirmed: z.literal(true) }).parse(req.body);
    privateRelay?.invalidate();
    res.status(204).end();
  });
  app.get("/v1/private-tasks", (_req, res) =>
    res.json(
      privateKeys?.taskStatus() ?? {
        available: false,
        enabled: false,
        transportActive: false,
        acceptedTasks: [],
        responses: [],
      },
    ),
  );
  app.post("/v1/private-tasks/receive", async (req, res) => {
    if (!privateKeys) throw new StoreError("CONFLICT");
    res.json(await privateKeys.receiveTask(req.body));
  });
  app.post("/v1/private-tasks/responses/prepare", async (req, res) => {
    if (!privateKeys) throw new StoreError("CONFLICT");
    res.json(await privateKeys.prepareTaskResponse(req.body));
  });
  app.post("/v1/private-tasks/responses/resume", async (req, res) => {
    if (!privateKeys) throw new StoreError("CONFLICT");
    res.json(await privateKeys.resumeTaskResponse(req.body));
  });
  app.post("/v1/private-tasks/responses/envelope", async (req, res) => {
    if (!privateKeys) throw new StoreError("CONFLICT");
    res.json(await privateKeys.taskResponseEnvelope(req.body));
  });
  app.post("/v1/private-tasks/responses/stop", async (req, res) => {
    if (!privateKeys) throw new StoreError("CONFLICT");
    res.json(await privateKeys.stopTaskResponse(req.body));
  });
  app.get("/v1/private-keys", (_req, res) =>
    res.json(
      privateKeys?.status() ?? {
        available: false,
        canSetup: false,
        state: store.exportPrivateEndpointKeys(owner),
      },
    ),
  );
  app.post("/v1/private-keys/review", async (req, res) => {
    if (!privateKeys) throw new StoreError("CONFLICT");
    res.json(await privateKeys.prepare(req.body));
  });
  app.post("/v1/private-keys/confirm", async (req, res) => {
    if (!privateKeys) throw new StoreError("CONFLICT");
    res.json(await privateKeys.confirm(req.body));
  });
  app.get("/v1/private-peers", (_req, res) => {
    res.json(
      privateKeys?.peerStatus() ?? {
        available: false,
        canSetup: false,
        revision: 0,
        keyRevision: 0,
        needsFreshPairing: false,
        hasSelectedKey: false,
        peers: [],
      },
    );
  });
  app.post("/v1/private-peers/invitation", async (req, res) => {
    if (!privateKeys) throw new StoreError("CONFLICT");
    res.json(await privateKeys.peerInvitation(req.body));
  });
  app.post("/v1/private-peers/review", async (req, res) => {
    if (!privateKeys) throw new StoreError("CONFLICT");
    res.json(await privateKeys.preparePeer(req.body));
  });
  app.post("/v1/private-peers/confirm", async (req, res) => {
    if (!privateKeys) throw new StoreError("CONFLICT");
    res.json(await privateKeys.confirmPeer(req.body));
  });
  app.get("/v1/private-peer-checks", (_req, res) =>
    res.json(
      privateKeys?.peerCheckStatus() ?? {
        available: false,
        enabled: false,
        checks: [],
      },
    ),
  );
  app.post("/v1/private-peer-checks/begin", async (req, res) => {
    if (!privateKeys) throw new StoreError("CONFLICT");
    res.json(await privateKeys.beginPeerCheck(req.body));
  });
  app.post("/v1/private-peer-checks/respond", async (req, res) => {
    if (!privateKeys) throw new StoreError("CONFLICT");
    res.json(await privateKeys.respondPeerCheck(req.body));
  });
  app.post("/v1/private-peer-checks/complete", async (req, res) => {
    if (!privateKeys) throw new StoreError("CONFLICT");
    res.json(await privateKeys.completePeerCheck(req.body));
  });
  app.post("/v1/private-peer-checks/resume", async (req, res) => {
    if (!privateKeys) throw new StoreError("CONFLICT");
    res.json(await privateKeys.resumePeerCheck(req.body));
  });
  app.post("/v1/private-peer-checks/envelope", async (req, res) => {
    if (!privateKeys) throw new StoreError("CONFLICT");
    res.json(await privateKeys.peerCheckEnvelope(req.body));
  });
  app.post("/v1/private-peer-checks/stop", async (req, res) => {
    if (!privateKeys) throw new StoreError("CONFLICT");
    res.json(await privateKeys.stopPeerCheck(req.body));
  });
  app.get("/v1/private-task-permissions", (_req, res) => {
    res.json(
      privateKeys?.permissionStatus() ?? {
        available: false,
        canSetup: false,
        revision: 0,
        keyRevision: 0,
        peerRevision: 0,
        needsFreshPairing: false,
        hasSelectedKey: false,
        peers: [],
        profiles: [],
        grants: [],
      },
    );
  });
  app.post("/v1/private-task-permissions/review", async (req, res) => {
    if (!privateKeys) throw new StoreError("CONFLICT");
    res.json(await privateKeys.preparePermission(req.body));
  });
  app.post("/v1/private-task-permissions/confirm", async (req, res) => {
    if (!privateKeys) throw new StoreError("CONFLICT");
    res.json(await privateKeys.confirmPermission(req.body));
  });
  app.get("/v1/remote", async (_req, res) =>
    res.json({
      available: !!remote,
      connection: remote ? await remote.status() : null,
      automaticSharing: false,
      ...(receiver ? { receiver: receiver.status() } : {}),
      ...(templateReceiver
        ? { templateReceiver: templateReceiver.status() }
        : {}),
    }),
  );
  const receivingPaused = async <T>(action: () => Promise<T>) => {
    await Promise.all([receiver?.pause(), templateReceiver?.pause()]);
    try {
      return await action();
    } finally {
      receiver?.start();
      templateReceiver?.start();
    }
  };
  if (remote) {
    if (receiver)
      app.post("/v1/remote/controls/receiving", async (req, res) => {
        const input = z
          .strictObject({ enabled: z.boolean(), confirmed: z.literal(true) })
          .parse(req.body);
        res.json(
          await receivingPaused(() => receiver.configure(input.enabled)),
        );
      });
    const confirmed = z.strictObject({ confirmed: z.literal(true) });
    app.post("/v1/remote/begin", async (req, res) => {
      confirmed.parse(req.body);
      res.json(await remote.begin());
    });
    app.post("/v1/remote/finish", async (req, res) => {
      const input = z
        .strictObject({ expectedOwnerId: z.uuid(), confirmed: z.literal(true) })
        .parse(req.body);
      res.json(await remote.finish(input.expectedOwnerId));
    });
    app.post("/v1/remote/publish", async (req, res) => {
      const input = z
        .strictObject({
          confirmed: z.literal(true),
          tasks: z
            .array(
              z.strictObject({
                id: z.uuid(),
                revision: z.number().int().positive(),
              }),
            )
            .min(1)
            .max(100)
            .refine(
              (items) => new Set(items.map((x) => x.id)).size === items.length,
            ),
        })
        .parse(req.body);
      const tasks = input.tasks.map((selected) => {
        const task = store.get(owner, selected.id);
        if (task.revision !== selected.revision)
          throw new StoreError("CONFLICT");
        return task;
      });
      res.json(await receivingPaused(() => remote.publish(tasks)));
    });
    app.post("/v1/remote/retry", async (req, res) => {
      confirmed.parse(req.body);
      res.json(
        await remote.retryPending(async (ids) => {
          for (const id of ids) store.get(owner, id);
        }),
      );
    });
    app.post("/v1/remote/controls/enable", async (req, res) => {
      confirmed.parse(req.body);
      res.json(await receivingPaused(() => remote.enableControls()));
    });
    app.post("/v1/remote/controls/disable", async (req, res) => {
      confirmed.parse(req.body);
      res.json(await receivingPaused(() => remote.disableControls()));
    });
    app.post("/v1/remote/controls/check", async (req, res) => {
      confirmed.parse(req.body);
      res.json(await receivingPaused(() => remote.pollControls()));
    });
    if (templateReceiver)
      app.post("/v1/remote/templates/receiving", async (req, res) => {
        const input = z
          .strictObject({
            permissionId: z.uuid(),
            enabled: z.boolean(),
            confirmed: z.literal(true),
          })
          .parse(req.body);
        res.json(
          await receivingPaused(() =>
            templateReceiver.configure(input.permissionId, input.enabled),
          ),
        );
      });
    app.post("/v1/remote/templates/share", async (req, res) => {
      const input = shareTemplateSchema.parse(req.body);
      res.json(await receivingPaused(() => remote.shareTemplate(input)));
    });
    for (const action of ["retry", "revoke", "check"] as const)
      app.post(`/v1/remote/templates/${action}`, async (req, res) => {
        const input = z
          .strictObject({ permissionId: z.uuid(), confirmed: z.literal(true) })
          .parse(req.body);
        res.json(
          await receivingPaused<unknown>(() =>
            action === "retry"
              ? remote.retryTemplatePublication(input.permissionId)
              : action === "revoke"
                ? remote.revokeTemplate(input.permissionId)
                : remote.pollTemplate(input.permissionId),
          ),
        );
      });
    app.post("/v1/remote/rotate", async (req, res) => {
      confirmed.parse(req.body);
      res.json(await receivingPaused(() => remote.rotate()));
    });
    app.delete("/v1/remote/local", async (req, res) => {
      if (req.header("X-Confirm-Delete") !== "local-remote-connection-only")
        throw new StoreError("INVALID_INPUT");
      res.json(await receivingPaused(() => remote.forgetLocal()));
    });
  }
  if (executionControls) {
    app.get("/v1/device/execution", (_req, res) =>
      res.json(executionControls.admission(activeTasks?.() ?? 0)),
    );
    app.put("/v1/device/execution", (req, res) => {
      executionControls.update(req.body);
      res.json(executionControls.admission(activeTasks?.() ?? 0));
    });
  }
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
    app.post("/v1/imports/:id/cleanup", async (req, res) => {
      z.strictObject({}).parse(req.body);
      res.json(await imports.cleanup(req.params.id));
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
  app.get("/v1/connections/mail-send", async (_req, res) =>
    res.json(
      mailSend
        ? { available: true, ...(await mailSend.status()) }
        : { available: false },
    ),
  );
  if (mailSend) {
    app.post("/v1/connections/mail-send/prepare", async (req, res) =>
      res.json(await mailSend.prepare(req.body)),
    );
    app.post("/v1/connections/mail-send/reconnect", async (req, res) =>
      res.json(await mailSend.reconnect(req.body)),
    );
    app.post("/v1/connections/mail-send/finish", async (req, res) =>
      res.json(await mailSend.finish(req.body)),
    );
    app.post("/v1/connections/mail-send/review", async (req, res) =>
      res.json(await mailSend.prepareSend(req.body)),
    );
    app.post("/v1/connections/mail-send/confirm", async (req, res) =>
      res.json(await mailSend.confirm(req.body)),
    );
    app.post("/v1/connections/mail-send/cancel", (req, res) =>
      res.json(mailSend.cancelReview(req.body)),
    );
    app.post("/v1/connections/mail-send/reconcile", async (req, res) =>
      res.json(await mailSend.reconcile(req.body)),
    );
    app.get("/v1/connections/mail-send/history", (_req, res) =>
      res.json(mailSend.history()),
    );
    app.get("/v1/connections/mail-send/history/:operationId", (req, res) =>
      res.json(mailSend.record({ operationId: req.params.operationId })),
    );
    app.post("/v1/connections/mail-send/delete", async (req, res) =>
      res.json(await mailSend.remove(req.body)),
    );
    app.post("/v1/connections/mail-send/disconnect", async (req, res) => {
      z.strictObject({}).parse(req.body);
      res.json(await mailSend.disconnect());
    });
    app.post("/v1/connections/mail-send/forget", async (req, res) => {
      z.strictObject({ confirmed: z.literal(true) }).parse(req.body);
      res.json(await mailSend.forgetLocal());
    });
  }
  app.get("/v1/connections/news", async (_req, res) => {
    res.json(
      news
        ? { available: true, ...(await news.status()) }
        : { available: false, connection: null },
    );
  });
  if (news) {
    if (news.publicationAvailable) {
      app.post("/v1/connections/news/publication/review", async (req, res) => {
        z.strictObject({}).parse(req.body);
        res.json(await news.reviewPublication());
      });
      app.post("/v1/connections/news/publication/confirm", async (req, res) =>
        res.json(await news.confirmPublication(req.body)),
      );
      app.post("/v1/connections/news/publication/cancel", (req, res) =>
        res.json(news.cancelPublication(req.body)),
      );
      app.post("/v1/connections/news/publication/reconcile", async (req, res) =>
        res.json(await news.reconcilePublication(req.body)),
      );
      app.get("/v1/connections/news/publication/history", (_req, res) =>
        res.json(news.publicationHistory()),
      );
      app.get(
        "/v1/connections/news/publication/history/:operationId",
        (req, res) =>
          res.json(
            news.publicationRecord({ operationId: req.params.operationId }),
          ),
      );
      app.post("/v1/connections/news/publication/delete", async (req, res) =>
        res.json(await news.deletePublication(req.body)),
      );
    }
    app.post("/v1/connections/news/review", async (req, res) =>
      res.json(await news.prepare(req.body)),
    );
    app.post("/v1/connections/news/confirm", async (req, res) =>
      res.json(await news.confirm(req.body)),
    );
    app.post("/v1/connections/news/cancel", async (req, res) => {
      z.strictObject({}).parse(req.body);
      await news.cancel();
      res.status(204).end();
    });
    app.post("/v1/connections/news/articles", async (req, res) => {
      z.strictObject({}).parse(req.body);
      res.json(await news.read());
    });
    app.post("/v1/connections/news/preview", async (req, res) => {
      z.strictObject({}).parse(req.body);
      res.json(await news.preview());
    });
    app.post("/v1/connections/news/curation/review", async (req, res) =>
      res.json(await news.reviewEdit(req.body)),
    );
    app.post("/v1/connections/news/curation/confirm", async (req, res) =>
      res.json(await news.confirmEdit(req.body)),
    );
    app.post("/v1/connections/news/forget", async (req, res) =>
      res.json(await news.forget(req.body)),
    );
  }
  const dependenciesCurrent = (id: string) =>
    localTaskDependencies(store, owner, id, memory);
  const requireDependencies = (id: string) => {
    if (!dependenciesCurrent(id)) throw new StoreError("NOT_FOUND");
  };
  const concealed = (task: Task) => {
    if (!dependenciesCurrent(task.id))
      return {
        ...task,
        input: {
          ...task.input,
          prompt: "Local reference unavailable",
          sourceRefs: [],
          memoryIds: [],
        },
        result: null,
        dependencyAccess: "unavailable" as const,
      };
    return task.input.sourceRefs.length
      ? {
          ...task,
          input: { ...task.input, sourceRefs: [] },
          result: null,
          sourceAccess: "unavailable",
          sourceBound: true,
          sourceApp: task.input.sourceRefs[0]?.app,
        }
      : task;
  };
  const project = async (task: Task) => {
    if (!dependenciesCurrent(task.id) || !task.input.sourceRefs.length)
      return concealed(task);
    try {
      const binding = store.sourceBinding(owner, task.id);
      if (!binding) return concealed(task);
      await sourceRouter.validate(binding);
      const current = store.get(owner, task.id);
      if (current.revision !== task.revision) throw new StoreError("CONFLICT");
      requireDependencies(task.id);
      return {
        ...current,
        sourceAccess: "current",
        sourceBound: true,
        sourceApp: binding.authority.sourceApp,
      };
    } catch {
      return concealed(store.get(owner, task.id));
    }
  };
  // Recheck after awaiting projection so local invalidation cannot land between
  // its resolved value and the response/export/review assembled by the handler.
  const finalProject = <T extends Task>(task: T) => {
    const current = store.get(owner, task.id);
    return current.revision !== task.revision || !dependenciesCurrent(task.id)
      ? concealed(current)
      : task;
  };
  const unavailable = (task: ReturnType<typeof concealed>) =>
    ("dependencyAccess" in task && task.dependencyAccess === "unavailable") ||
    ("sourceAccess" in task && task.sourceAccess === "unavailable");
  const concealMessage = (message: ReturnType<Store["message"]>) => ({
    ...message,
    input: { ...message.input, content: "Task reference unavailable" },
    taskAccess: "unavailable" as const,
  });
  const exportedMessage = (message: ReturnType<Store["message"]>) =>
    message.input.requestId &&
    unavailable(concealed(store.get(owner, message.input.requestId)))
      ? concealMessage(message)
      : message;
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
  app.post("/v1/requests/:id/mail-evidence", async (req, res) => {
    res.json(
      await readMailEvidence(
        store,
        owner,
        mailSources,
        req.params.id,
        req.body,
      ),
    );
  });
  app.get("/v1/requests/:id/export", async (req, res) => {
    const task = finalProject(await project(store.get(owner, req.params.id)));
    if (unavailable(task)) throw new ConnectorError("SOURCE_DENIED");
    res.json({
      task,
      runs: store.runHistory(owner, req.params.id),
      publications: store.publications(owner, req.params.id),
      autonoteReviews: store.autoNoteReviews(owner, req.params.id),
      qualityReview: store.taskFeedback.exportTask(owner, req.params.id),
    });
  });
  app.get("/v1/templates", (_req, res) =>
    res.json({ items: store.templates(owner) }),
  );
  app.put("/v1/templates", (req, res) =>
    res.json(store.saveTemplate(owner, req.body)),
  );
  app.delete("/v1/templates/:id", (req, res) => {
    store.deleteTemplate(owner, req.params.id, req.body);
    res.status(204).end();
  });
  app.post("/v1/templates/:id/run", (req, res) =>
    res.status(202).json(store.runTemplate(owner, req.params.id, req.body)),
  );
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
    res.json(finalProject(await project(store.get(owner, req.params.id)))),
  );
  const checkFeedbackAccess = async (id: string) => {
    const initial = store.get(owner, id),
      binding = store.sourceBinding(owner, id);
    if (initial.input.sourceRefs.length || binding) {
      if (!binding) throw new ConnectorError("SOURCE_DENIED");
      await sourceRouter.validate(binding);
    }
    requireDependencies(id);
    // Source checks are asynchronous. A deleted or changed task cannot receive
    // a review based on the earlier snapshot after that check returns.
    if (store.get(owner, id).revision !== initial.revision)
      throw new StoreError("CONFLICT");
  };
  const taskQuestion = (messageId: string) => {
    const message = store.message(owner, messageId),
      id = message.input.requestId;
    if (!id) throw new StoreError("NOT_FOUND");
    const task = store.get(owner, id),
      wait = store
        .inputWaitHistory(owner, id)
        .find((w) => w.questionId === messageId);
    if (!wait) throw new StoreError("NOT_FOUND");
    return { message, task, wait };
  };
  app.get("/v1/messages/:id/task-question", async (req, res) => {
    const before = taskQuestion(req.params.id);
    await checkFeedbackAccess(before.task.id);
    requireDependencies(before.task.id);
    const { message, task, wait } = taskQuestion(req.params.id);
    if (before.task.revision !== task.revision)
      throw new StoreError("CONFLICT");
    res.json(
      taskQuestionViewSchema.parse({
        taskId: task.id,
        questionId: message.id,
        revision: task.revision,
        inboxId: message.input.recipientInboxId,
        conversationId: message.input.conversationId,
        status: task.status,
        question: message.input.content,
        deadline: wait.deadline,
        replyId: wait.replyId,
        canAnswer:
          !wait.replyId &&
          ["awaiting_input", "paused"].includes(task.status) &&
          Date.now() >= message.createdAt &&
          Date.now() < wait.deadline,
      }),
    );
  });
  app.post("/v1/messages/:id/task-answer", async (req, res) => {
    const { confirmed: _confirmed, ...body } = taskAnswerInputSchema.parse(
      req.body,
    );
    const key = z.uuid().parse(req.header("Idempotency-Key"));
    if (body.questionId !== req.params.id) throw new StoreError("CONFLICT");
    const { task } = taskQuestion(req.params.id);
    await checkFeedbackAccess(task.id);
    const answer = store.answerInput(owner, task.id, body, key, () =>
      requireDependencies(task.id),
    );
    res.json(
      taskAnswerReceiptSchema.parse({
        taskId: task.id,
        questionId: body.questionId,
        replyId: answer.reply.id,
        revision: answer.task.revision,
        status: answer.task.status,
        duplicate: answer.duplicate,
      }),
    );
  });
  app.get("/v1/requests/:id/quality-review", async (req, res) => {
    await checkFeedbackAccess(req.params.id);
    requireDependencies(req.params.id);
    res.json(store.taskFeedback.read(owner, req.params.id));
  });
  app.put("/v1/requests/:id/quality-review", async (req, res) => {
    await checkFeedbackAccess(req.params.id);
    requireDependencies(req.params.id);
    res.json(store.taskFeedback.save(owner, req.params.id, req.body));
  });
  app.post("/v1/requests/:id/commands", async (req, res) => {
    const task = store.command(owner, req.params.id, req.body);
    if (task.status === "cancelled" || task.status === "paused")
      cancelRun?.(task.id);
    res.json(finalProject(await project(task)));
  });
  app.get("/v1/requests/:id/runs", async (req, res) => {
    const task = finalProject(await project(store.get(owner, req.params.id)));
    res.json({
      items: unavailable(task) ? [] : store.runHistory(owner, req.params.id),
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
    res.json(finalProject(await project(task)));
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
    app.post("/v1/requests/:id/memory-suggestions", (req, res) => {
      requireDependencies(req.params.id);
      res
        .status(201)
        .json(store.memoryExtractions.create(owner, req.params.id, req.body));
    });
    app.get("/v1/requests/:id/memory-suggestions", (req, res) => {
      requireDependencies(req.params.id);
      res.json(store.memoryExtractions.review(owner, req.params.id));
    });
    app.post("/v1/requests/:id/memory-suggestions/save", async (req, res) => {
      requireDependencies(req.params.id);
      const body = z
        .strictObject({
          expectedRevision: z.number().int().positive(),
          index: z.number().int().min(0).max(7),
          confirmed: z.literal(true),
        })
        .parse(req.body);
      const review = store.memoryExtractions.review(owner, req.params.id);
      const selected = review.candidates[body.index];
      if (review.revision !== body.expectedRevision || !selected)
        throw new StoreError("CONFLICT");
      const item = await memory.add(
        owner,
        {
          type: selected.type,
          text: selected.text,
          origin: "model",
          sources: [
            {
              app: "local",
              tenantId: owner.tenantId,
              resourceId: review.parentId,
              revision: String(review.parentRevision),
            },
          ],
        },
        () => {
          requireDependencies(req.params.id);
          const current = store.memoryExtractions.review(owner, req.params.id);
          if (JSON.stringify(current) !== JSON.stringify(review))
            throw new StoreError("CONFLICT");
        },
      );
      res.status(201).json(item);
    });
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
      requireDependencies(req.params.id);
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
          revision: z.number().int().positive(),
          outcome: z.enum(["accepted", "edited", "rejected"]),
        })
        .parse(req.body);
      await memory.feedback(
        owner,
        req.params.id,
        body.id,
        body.outcome,
        body.revision,
      );
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
  app.get("/v1/inboxes/:id/conversations", (req, res) => {
    if (req.query.cursor !== undefined && typeof req.query.cursor !== "string")
      throw new StoreError("INVALID_INPUT");
    res.json(
      store.inboxConversationPage(
        owner,
        req.params.id,
        req.query.cursor,
        (message) => exportedMessage(message).input.content.slice(0, 100),
      ),
    );
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
  app.get("/v1/messages", async (req, res) => {
    const after = Number(req.query.after ?? 0);
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      typeof req.query.inboxId !== "string" ||
      typeof req.query.conversationId !== "string"
    )
      throw new StoreError("INVALID_INPUT");
    const taskToken = store.changeToken(),
      memoryToken = memory?.changeToken();
    const messages = store.messages(
      owner,
      req.query.inboxId,
      req.query.conversationId,
      after,
    );
    const references = new Map<string, Awaited<ReturnType<typeof project>>>();
    for (const message of messages) {
      const id = message.input.requestId;
      if (id && !references.has(id))
        references.set(id, await project(store.get(owner, id)));
    }
    const items = messages.map((message) =>
      message.input.requestId &&
      unavailable(finalProject(references.get(message.input.requestId)!))
        ? concealMessage(message)
        : message,
    );
    if (
      taskToken !== store.changeToken() ||
      memoryToken !== memory?.changeToken()
    )
      throw new StoreError("CONFLICT");
    res.json({ items });
  });
  app.get("/v1/messages/:id", async (req, res) => {
    const taskToken = store.changeToken(),
      memoryToken = memory?.changeToken();
    const message = store.message(owner, req.params.id);
    if (
      message.input.requestId &&
      unavailable(
        finalProject(await project(store.get(owner, message.input.requestId))),
      )
    )
      throw new ConnectorError("SOURCE_DENIED");
    if (
      taskToken !== store.changeToken() ||
      memoryToken !== memory?.changeToken()
    )
      throw new StoreError("CONFLICT");
    res.json(message);
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
  app.get("/v1/recovery-copies", async (req, res) => {
    if (!retainedCopies) throw new StoreError("NOT_FOUND");
    const { after } = z
      .strictObject({ after: z.string().regex(contentIdPattern).optional() })
      .parse(req.query);
    res.json(await retainedCopies.list(after));
  });
  app.post("/v1/recovery-copies/delete", async (req, res) => {
    if (!retainedCopies) throw new StoreError("NOT_FOUND");
    const body = z
      .strictObject({
        id: z.string().regex(contentIdPattern),
        review: z.string().regex(/^[a-f0-9]{64}$/),
        confirmed: z.literal(true),
      })
      .parse(req.body);
    res.json(await retainedCopies.remove(body.id, body.review));
  });
  app.post("/v1/backup", async (req, res) => {
    z.strictObject({ confirmed: z.literal(true) }).parse(req.body);
    if (!backupDownload) throw new StoreError("NOT_FOUND");
    const bytes = await backupDownload();
    res.set(
      "Content-Disposition",
      'attachment; filename="bittrees-ai-content.aib"',
    );
    res.type("application/octet-stream").send(bytes);
  });
  app.get("/v1/export", async (_req, res) => {
    const taskToken = store.changeToken(),
      memoryToken = memory?.changeToken();
    const memories = memory ? await memory.export(owner) : [];
    const payload = {
      tasks: store.export(owner).map(concealed),
      messages: store.exportMessages(owner).map(exportedMessage),
      inputWaits: store.exportInputWaits(owner),
      remoteControls: store.exportRemoteControls(owner),
      privateRelayCredentials: store.exportPrivateRelayCredentials(owner),
      privateTaskConsent: store.exportPrivateTaskConsent(owner),
      privatePeerChecks: store.exportPrivatePeerChecks(owner),
      privatePeerTrust: store.exportPrivatePeerTrust(owner),
      privateEndpointKeys: store.exportPrivateEndpointKeys(owner),
      privateTaskReceipts: store.exportPrivateTaskReceipts(owner),
      privateTaskOutbox: store.exportPrivateTaskOutbox(owner),
      privateTaskResponses: store.exportPrivateTaskResponses(owner),
      newsPublications: store.newsPublications.list(owner),
      mailSends: store.mailSends.list(owner),
      templates: store.templates(owner),
      remoteTemplates: store.remoteTemplates.export(owner),
      memoryExtractions: store.memoryExtractions
        .export(owner)
        .filter((item) => dependenciesCurrent(item.taskId)),
      qualityReviews: store.taskFeedback
        .exportLocal(owner)
        .filter((item) => dependenciesCurrent(item.taskId)),
      profiles: store.profiles(owner),
      defaultProfile: store.defaultProfile(owner),
      memories,
    };
    if (
      taskToken !== store.changeToken() ||
      memoryToken !== memory?.changeToken()
    )
      throw new StoreError("CONFLICT");
    res.json(payload);
  });
  app.delete("/v1/data", async (req, res) => {
    if (req.header("X-Confirm-Delete") !== "all-local-task-data")
      throw new StoreError("INVALID_INPUT");
    await receivingPaused(async () => {
      if (
        mailSend?.busy ||
        news?.publicationBusy ||
        publications?.busy ||
        autoReviews?.busy ||
        remote?.running ||
        privateKeys?.busy ||
        privateRelay?.busy
      )
        throw new StoreError("CONFLICT");
      privateKeys?.invalidate();
      privateRelay?.invalidate();
      const relayState = store.exportPrivateRelayCredentials(owner);
      if (relayState.items.length) {
        if (!privateRelay) throw new StoreError("CONFLICT");
        await privateRelay.clearAll();
      }
      const keyState = store.exportPrivateEndpointKeys(owner);
      if (
        keyState.slots.some((v) => v.state !== "deleted") ||
        keyState.pendingKeyDeletionCount
      ) {
        if (privateKeys) await privateKeys.clearAll();
        else if (privateKeyCleanup) await privateKeyCleanup();
        else throw new StoreError("CONFLICT");
        const remaining = store.exportPrivateEndpointKeys(owner);
        if (
          remaining.slots.some((v) => v.state !== "deleted") ||
          remaining.pendingKeyDeletionCount
        )
          throw new StoreError("CONFLICT");
      }
      const remove = () => {
        store.deleteAll(owner, () => {
          if (mailSend?.busy) throw new StoreError("CONFLICT");
          mailSend?.invalidateReview();
          news?.invalidatePublicationReview();
          // Remote journal cleanup may await storage. Fence another connection's
          // new key selection at the actual deletion commit, under a write lock.
          const relayRecords = store.exportPrivateRelayCredentials(owner);
          if (relayRecords.items.some((r) => r.phase !== "deleted"))
            throw new StoreError("CONFLICT");
          const currentKeys = store.exportPrivateEndpointKeys(owner);
          if (
            currentKeys.slots.some((v) => v.state !== "deleted") ||
            currentKeys.pendingKeyDeletionCount
          )
            throw new StoreError("CONFLICT");
          memory?.deleteAll(owner);
        });
      };
      if (remote) await remote.clearTaskData(remove);
      else remove();
    });
    res.status(204).end();
  });
  app.use((_req, res) =>
    res
      .status(404)
      .json({ error: "NOT_FOUND", correlationId: res.locals.correlationId }),
  );
  const errors: ErrorRequestHandler = (err, _req, res, _next) => {
    const code =
      err?.type === "entity.too.large"
        ? "PAYLOAD_TOO_LARGE"
        : err instanceof CompanionRelayError ||
            err instanceof PrivatePeerCheckError ||
            err instanceof PrivateTaskError ||
            err instanceof PrivateResponseError ||
            err instanceof PrivateConsentError ||
            err instanceof PrivateKeyError ||
            err instanceof PrivateKeyLifecycleError ||
            err instanceof RemoteClientError ||
            err instanceof ImportError ||
            err instanceof MemoryCandidateError ||
            err instanceof StoreError ||
            err instanceof ModelError ||
            err instanceof ConnectorError
          ? err.code
          : err instanceof ZodError || err instanceof SyntaxError
            ? "INVALID_INPUT"
            : "INTERNAL";
    const status =
      code === "PAYLOAD_TOO_LARGE"
        ? 413
        : code === "MODEL_UNAVAILABLE" ||
            ((err instanceof CompanionRelayError ||
              err instanceof PrivateKeyError ||
              err instanceof PrivateKeyLifecycleError) &&
              code === "STORAGE_UNAVAILABLE")
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
