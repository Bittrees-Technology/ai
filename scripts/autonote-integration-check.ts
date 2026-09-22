// Actual three-repository code, isolated synthetic databases, no external requests.
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { AutoNoteConnector } from "../modules/connectors/autonote.js";
import { AutoNoteTasks } from "../modules/connectors/autonote-tasks.js";
import { AutoNoteReviews } from "../modules/connectors/autonote-reviews.js";
import { SourceTasks } from "../modules/connectors/source-tasks.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { LocalWorker } from "../apps/companion/worker.js";
const database = process.env.DATABASE_URL!;
if (!database || !new URL(database).pathname.endsWith("/autonote_test"))
  throw Error("Dedicated autonote_test database required");
const sourceRoot = process.env.AUTONOTE_REPO,
  crmRoot = process.env.CRM_REPO;
if (!sourceRoot || !crmRoot)
  throw Error("AUTONOTE_REPO and CRM_REPO are required");
const load = (root: string, path: string): Promise<any> =>
  import(pathToFileURL(resolve(root, path)).href);
const admin = new Pool({ connectionString: database });
const namespaces = ["cross_auto_", "cross_crm_"].map(
  (p) => p + randomUUID().replaceAll("-", ""),
);
const store = new Store(":memory:", new Vault(randomBytes(32)));
const originalFetch = globalThis.fetch;
let sourceDb: any, crmDb: any;
let crmDispatches = 0,
  losePublication = true,
  losePreparation = true;
try {
  for (const name of namespaces) await admin.query("CREATE SCHEMA " + name);
  process.env.AUTH_SECRET = "synthetic-cross-app-only-secret";
  process.env.AI_CONNECTOR_ENABLED = "true";
  process.env.AUTONOTE_MODE = "live";
  process.env.APP_URL = "https://autonote.bittrees.org";
  process.env.CRM_URL = "https://crm.bittrees.org";
  process.env.AUTONOTE_URL = "https://autonote.bittrees.org";
  function selectDatabase(name: string) {
    const url = new URL(database);
    url.searchParams.set("options", "-c search_path=" + name);
    process.env.DATABASE_URL = url.href;
  }
  selectDatabase(namespaces[0]!);
  sourceDb = await load(sourceRoot, "lib/db.ts");
  await sourceDb.pool().query(sourceDb.schema);
  selectDatabase(namespaces[1]!);
  crmDb = await load(crmRoot, "lib/db.ts");
  await crmDb.pool().query(crmDb.schema);
  const ai = await load(sourceRoot, "lib/ai.ts"),
    reviews = await load(sourceRoot, "lib/ai-reviews.ts"),
    route = await load(sourceRoot, "app/api/integrations/ai/[action]/route.ts"),
    sourceService = await load(sourceRoot, "lib/service.ts"),
    sourceCrm = await load(sourceRoot, "lib/crm.ts"),
    sourceAuth = await load(sourceRoot, "lib/auth.ts"),
    sourceSecrets = await load(sourceRoot, "lib/secrets.ts"),
    crm = await load(crmRoot, "lib/autonote.ts");
  const user = randomUUID(),
    workspace = randomUUID(),
    meeting = randomUUID(),
    destinationUser = randomUUID(),
    destinationWorkspace = randomUUID(),
    target = randomUUID();
  await sourceDb
    .pool()
    .query("INSERT INTO users(id,name) VALUES($1,'Synthetic source owner')", [
      user,
    ]);
  await sourceDb
    .pool()
    .query("INSERT INTO workspaces(id,name) VALUES($1,'Synthetic source')", [
      workspace,
    ]);
  await sourceDb
    .pool()
    .query("INSERT INTO members VALUES($1,$2,'owner')", [workspace, user]);
  await sourceDb
    .pool()
    .query(
      "INSERT INTO meetings(id,workspace_id,creator_id,title,status,transcript) VALUES($1,$2,$3,'Synthetic integration meeting','ready',$4)",
      [
        meeting,
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
  await crmDb
    .pool()
    .query(
      "INSERT INTO users(id,name) VALUES($1,'Synthetic destination owner')",
      [destinationUser],
    );
  await crmDb
    .pool()
    .query(
      "INSERT INTO workspaces(id,name) VALUES($1,'Synthetic destination')",
      [destinationWorkspace],
    );
  await crmDb
    .pool()
    .query(
      "INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
      [destinationWorkspace, destinationUser],
    );
  await crmDb
    .pool()
    .query(
      "INSERT INTO records(id,workspace_id,kind,data) VALUES($1,$2,'projects',$3)",
      [target, destinationWorkspace, { name: "Synthetic project" }],
    );
  // Dispatch only to real route/module code in this process. Any other request fails.
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (
      url.origin === "https://autonote.bittrees.org" &&
      url.pathname.startsWith("/api/integrations/ai/")
    ) {
      const action = url.pathname.split("/").at(-1)!;
      const response = await route.POST(new Request(url, init), {
        params: Promise.resolve({ action }),
      });
      if (action === "review-prepare" && response.ok && losePreparation) {
        losePreparation = false;
        throw Error("Synthetic lost staging response");
      }
      return response;
    }
    if (
      url.origin === "https://crm.bittrees.org" &&
      url.pathname.startsWith("/api/integrations/autonote/")
    ) {
      const body = JSON.parse(String(init?.body));
      const action = url.pathname.split("/").at(-1);
      if (action === "exchange") return Response.json(await crm.exchange(body));
      if (action === "publish") {
        crmDispatches++;
        const bearer = new Headers(init?.headers)
          .get("authorization")!
          .slice(7);
        const result = await crm.publish(bearer, body);
        if (losePublication) {
          losePublication = false;
          throw Error("Synthetic lost publication response");
        }
        return Response.json(result);
      }
    }
    throw Error("External requests prohibited in synthetic acceptance");
  };
  const owner = { userId: "synthetic-local", tenantId: "personal" };
  let credential: Uint8Array | undefined;
  const connector = new AutoNoteConnector(JSON.stringify(owner), {
    getSecret: async () => credential,
    setSecret: async (v) => {
      credential = v;
    },
    deleteCredential: async () => {
      credential = undefined;
      return true;
    },
  });
  const began = await connector.begin();
  const issued = await ai.authorize(user, {
    workspaceId: workspace,
    meetingId: meeting,
    actions: ["read_transcript"],
    challenge: new URL(began.consentUrl).searchParams.get("challenge"),
    expiresInDays: 1,
  });
  await connector.finish(began.id, issued.code);
  const adapter = new AutoNoteTasks(connector, owner, "synthetic-device");
  assert.equal((await adapter.choices())[0]!.id, meeting);
  const task = await adapter.create(
    store,
    {
      conversationId: "integration",
      kind: "summarize",
      prompt: "Summarize with cited actions",
      modelProfileId: "synthetic",
      dependencies: [],
      priority: "normal",
      tags: [],
    },
    meeting,
    "one",
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
    store,
    owner,
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
    "synthetic-worker",
    undefined,
    new SourceTasks(undefined, adapter),
  );
  await worker.runOnce();
  assert.equal(store.get(owner, task.id).status, "completed");
  const ledger = new AutoNoteReviews(store, owner, connector, adapter);
  const operationId = randomUUID();
  await assert.rejects(ledger.reserve(task.id, { operationId }));
  const status = await connector.status();
  await reviews.allowReviews(user, status!.grantId, true);
  const local = await ledger.reserve(task.id, { operationId });
  await assert.rejects(ledger.prepare(local.id));
  assert.equal(store.autoNoteReview(owner, local.id).state, "uncertain");
  const prepared = await ledger.reconcile(local.id);
  assert.equal(prepared.state, "prepared");
  const sourceDetail = await reviews.reviewDetail(
    user,
    prepared.response!.reviewId,
  );
  assert.equal(sourceDetail.notes.actions[0].status, "proposed");
  const receipt = await reviews.saveReview(
    user,
    prepared.response!.reviewId,
    prepared.response!.digest,
  );
  assert.equal(receipt.version, 2);
  assert.equal((await ledger.reconcile(local.id)).state, "saved");
  await assert.rejects(adapter.validate(store.sourceBinding(owner, task.id)!));
  assert.equal(crmDispatches, 0, "AI save must not dispatch CRM publication");
  // Establish the existing, separate AutoNote-to-CRM PKCE connection.
  const session = "e".repeat(64);
  const req = new Request("https://autonote.bittrees.org", {
    headers: { cookie: sourceAuth.cookieName + "=" + session },
  });
  const connect = new URL((await sourceCrm.start(req, user)).url);
  const consent = new URL(
    (
      await crm.authorize(destinationUser, {
        workspaceId: destinationWorkspace,
        targetId: target,
        challenge: connect.searchParams.get("challenge"),
        state: connect.searchParams.get("state"),
      })
    ).url,
  );
  await sourceCrm.callback(
    req,
    user,
    consent.searchParams.get("code"),
    consent.searchParams.get("state"),
  );
  const connection = (await sourceCrm.list(user))[0];
  const selection = {
    connectionId: connection.id,
    meetingId: meeting,
    version: 2,
    summary: sourceDetail.notes.summary,
    actionIds: [sourceDetail.notes.actions[0].id],
  };
  await assert.rejects(sourceCrm.preview(user, selection), /accepted/);
  const notes = structuredClone(sourceDetail.notes);
  notes.actions[0].status = "accepted";
  await sourceService.editMeeting(user, meeting, { version: 2, notes });
  await assert.rejects(sourceCrm.preview(user, selection), /changed/);
  const preview = await sourceCrm.preview(user, { ...selection, version: 3 });
  await assert.rejects(
    sourceCrm.publish(user, preview.token),
    /lost publication/,
  );
  const recovered = await sourceCrm.publish(user, preview.token);
  assert.equal(recovered.items.length, 2);
  assert.ok(recovered.items.every((item: any) => item.existing));
  assert.deepEqual(await sourceCrm.publish(user, preview.token), recovered);
  assert.equal(crmDispatches, 2, "Confirmed retry must use local receipt");
  const records = (
    await crmDb
      .pool()
      .query("SELECT kind,data FROM records WHERE id<>$1", [target])
  ).rows;
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r: any) => r.kind).sort(), ["notes", "tasks"]);
  assert.ok(records.every((r: any) => r.data.projectId === target));
  assert.ok(records.every((r: any) => !r.data.assigneeId));
  // A fresh source preview uses the same destination item identities.
  const fresh = await sourceCrm.preview(user, { ...selection, version: 3 });
  assert.ok(
    (await sourceCrm.publish(user, fresh.token)).items.every(
      (item: any) => item.existing,
    ),
  );
  assert.equal(
    Number(
      (await crmDb.pool().query("SELECT count(*) n FROM autonote_receipts"))
        .rows[0].n,
    ),
    2,
  );
  const destinationToken = sourceSecrets.decrypt(
    (
      await sourceDb
        .pool()
        .query("SELECT token_ciphertext FROM crm_connections WHERE id=$1", [
          connection.id,
        ])
    ).rows[0].token_ciphertext,
  );
  await crm.revokeBearer(destinationToken);
  const deniedPreview = await sourceCrm.preview(user, {
    ...selection,
    version: 3,
  });
  await assert.rejects(sourceCrm.publish(user, deniedPreview.token), /revoked/);
  await connector.disconnect();
  assert.equal(await connector.status(), null);
  console.log(
    "Three-repository synthetic acceptance passed: draft, source save, accepted-action publication, lost-response recovery, deduplication and revoke. Inference is stubbed; this is not browser or model-quality acceptance.",
  );
} finally {
  globalThis.fetch = originalFetch;
  store.close();
  await sourceDb?.pool().end();
  await crmDb?.pool().end();
  for (const name of namespaces)
    await admin.query("DROP SCHEMA IF EXISTS " + name + " CASCADE");
  await admin.end();
}
