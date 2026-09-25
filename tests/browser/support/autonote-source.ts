import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { AutoNoteConnector } from "../../../modules/connectors/autonote.js";
import { AutoNoteApprovalConnector } from "../../../modules/connectors/autonote-approval.js";
import { AutoNoteTasks } from "../../../modules/connectors/autonote-tasks.js";
import { AutoNoteReviews } from "../../../modules/connectors/autonote-reviews.js";
import { SourceTasks } from "../../../modules/connectors/source-tasks.js";
import { LocalWorker } from "../../../apps/companion/worker.js";
import type { retainedMac } from "./retained-mac.js";

/** Actual pinned AutoNote routes in the existing disposable CI database.
 * Model output is synthetic; source authorization, review, save and recovery are real. */
export async function autoNoteSource(
  mac: Awaited<ReturnType<typeof retainedMac>>,
) {
  const database = process.env.BROWSER_TEST_DATABASE_URL;
  const root = process.env.AUTONOTE_REPO;
  if (
    process.env.CI !== "true" ||
    !database ||
    !root ||
    new URL(database).pathname !== "/browser_identity_test"
  )
    throw Error("Disposable browser CI and pinned AutoNote checkout required");
  const namespace = "browser_auto_" + randomUUID().replaceAll("-", "");
  const admin = new Pool({ connectionString: database });
  const env = {
    DATABASE_URL: (() => {
      const url = new URL(database);
      url.searchParams.set("options", "-c search_path=" + namespace);
      return url.href;
    })(),
    AUTH_SECRET: "synthetic-browser-autonote-only",
    AI_CONNECTOR_ENABLED: "true",
    AI_REMOTE_APPROVAL_ENABLED: "true",
    AUTONOTE_MODE: "live",
    APP_URL: "https://autonote.bittrees.org",
    AUTONOTE_URL: "https://autonote.bittrees.org",
    CRM_URL: "https://crm.bittrees.org",
  };
  const previous = Object.fromEntries(
    Object.keys(env).map((k) => [k, process.env[k]]),
  );
  let db: any;
  let saves = 0;
  const close = async () => {
    try {
      if (db) await db.pool().end();
    } finally {
      try {
        await admin.query("DROP SCHEMA IF EXISTS " + namespace + " CASCADE");
      } finally {
        await admin.end();
        for (const [k, v] of Object.entries(previous)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    }
  };
  try {
    await admin.query("CREATE SCHEMA " + namespace);
    Object.assign(process.env, env);
    const load = (path: string): Promise<any> =>
      import(pathToFileURL(resolve(root, path)).href);
    db = await load("lib/db.ts");
    await db.pool().query(db.schema);
    const ai = await load("lib/ai.ts"),
      reviews = await load("lib/ai-reviews.ts"),
      approvals = await load("lib/ai-approval.ts"),
      route = await load("app/api/integrations/ai/[action]/route.ts");
    const user = randomUUID(),
      workspace = randomUUID(),
      meetingId = randomUUID();
    await db
      .pool()
      .query("INSERT INTO users(id,name) VALUES($1,'Synthetic source owner')", [
        user,
      ]);
    await db
      .pool()
      .query("INSERT INTO workspaces(id,name) VALUES($1,'Synthetic source')", [
        workspace,
      ]);
    await db
      .pool()
      .query("INSERT INTO members VALUES($1,$2,'owner')", [workspace, user]);
    await db
      .pool()
      .query(
        "INSERT INTO meetings(id,workspace_id,creator_id,title,status,transcript) VALUES($1,$2,$3,'Synthetic relay meeting','ready',$4)",
        [
          meetingId,
          workspace,
          user,
          JSON.stringify([
            {
              id: "s1",
              start: 2,
              end: 8,
              speaker: "Alex",
              text: "We agreed to review the plan. Alex may prepare a draft; no deadline is agreed.",
            },
          ]),
        ],
      );
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (
        url.origin !== "https://autonote.bittrees.org" ||
        !url.pathname.startsWith("/api/integrations/ai/")
      )
        throw Error("External source request prohibited");
      const action = url.pathname.split("/").at(-1)!;
      const response = await route.POST(new Request(url, init), {
        params: Promise.resolve({ action }),
      });
      if (action === "approval-save") {
        saves++;
        if (response.ok) throw Error("Synthetic lost source save response");
      }
      return response;
    };
    const secrets = () => {
      let value: Uint8Array | undefined;
      return {
        getSecret: async () => value,
        setSecret: async (v: Uint8Array) => {
          value = v;
        },
        deleteCredential: async () => {
          value = undefined;
          return true;
        },
      };
    };
    const connector = new AutoNoteConnector(
      JSON.stringify(mac.owner),
      secrets(),
      transport,
    );
    const start = await connector.begin();
    const issued = await ai.authorize(user, {
      workspaceId: workspace,
      meetingId,
      actions: ["read_transcript"],
      challenge: new URL(start.consentUrl).searchParams.get("challenge"),
      expiresInDays: 1,
    });
    await connector.finish(start.id, issued.code);
    const adapter = new AutoNoteTasks(
      connector,
      mac.owner,
      mac.binding.deviceId,
    );
    const task = await adapter.create(
      mac.store,
      {
        conversationId: randomUUID(),
        kind: "summarize",
        prompt: "Summarize with cited actions",
        modelProfileId: "synthetic",
        dependencies: [],
        priority: "normal",
        tags: [],
      },
      meetingId,
      randomUUID(),
    );
    const profile = {
      id: "synthetic",
      runtime: "ollama" as const,
      model: "synthetic",
      contextTokens: 4096,
      maxOutputTokens: 1000,
      temperature: 0,
    };
    const worker = new LocalWorker(
      mac.store,
      mac.owner,
      {
        pin: async () => ({ profile, digest: "c".repeat(64) }),
        generate: async () =>
          JSON.stringify({
            summary: [{ text: "Review the plan", evidence: ["s1"] }],
            actions: [
              {
                text: "Prepare a draft",
                evidence: ["s1"],
                owner: "Alex",
                dueDate: null,
              },
            ],
          }),
      },
      () => profile,
      "synthetic-browser-worker",
      undefined,
      new SourceTasks(undefined, adapter),
    );
    await worker.runOnce();
    assert.equal(mac.store.get(mac.owner, task.id).status, "completed");
    const approval = new AutoNoteApprovalConnector(
      JSON.stringify(mac.owner),
      secrets(),
      connector,
      transport,
    );
    const grantId = (await connector.status())!.grantId;
    await reviews.allowReviews(user, grantId, true);
    const setup = await approval.begin();
    const approvalIssued = await approvals.authorizeApproval(user, {
      grantId,
      expectedReviewEpoch: (
        await db
          .pool()
          .query("SELECT review_epoch FROM ai_grants WHERE id=$1", [grantId])
      ).rows[0].review_epoch,
      actions: ["approve_meeting_notes"],
      expiresInMinutes: 15,
      challenge: new URL(setup.consentUrl).searchParams.get(
        "approval_challenge",
      ),
    });
    await approval.finish(setup.id, approvalIssued.code);
    const ledger = new AutoNoteReviews(
      mac.store,
      mac.owner,
      connector,
      adapter,
      approval,
    );
    const operationId = randomUUID();
    await ledger.reserve(task.id, { operationId });
    const prepared = await ledger.prepare(operationId);
    // Compare the source's JSON wire representation, including its ISO expiry.
    // PostgreSQL returns a Date in-process; the actual route serializes that date.
    const detail = JSON.parse(
      JSON.stringify(
        await reviews.reviewDetail(user, prepared.response!.reviewId),
      ),
    );
    return {
      approval,
      adapter,
      ledger,
      operationId,
      meetingId,
      detail,
      saves: () => saves,
      sourceMeeting: async () =>
        (
          await db
            .pool()
            .query("SELECT * FROM meetings WHERE id=$1", [meetingId])
        ).rows[0],
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
