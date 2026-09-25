import { conversationTaskAccess } from "../apps/companion/conversation-access.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AutoNoteConnector } from "../modules/connectors/autonote.js";
import { AutoNoteTasks } from "../modules/connectors/autonote-tasks.js";
import { CrmTasks } from "../modules/connectors/crm-tasks.js";
import { CrmConnector } from "../modules/connectors/crm.js";
import {
  SourceTasks,
  sourceResult,
} from "../modules/connectors/source-tasks.js";
import { sourceBindingSchema } from "../modules/contracts/index.js";
import { CrmPublications } from "../modules/connectors/crm-publications.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { LocalWorker } from "../apps/companion/worker.js";
const owner = { userId: "personal", tenantId: "personal" };
const profile = {
  id: "p",
  runtime: "ollama" as const,
  model: "synthetic",
  contextTokens: 4096,
  maxOutputTokens: 1000,
  temperature: 0,
};
const input = {
  conversationId: "meeting",
  kind: "summarize" as const,
  prompt: "Summarize with actions",
  modelProfileId: "p",
  dependencies: [],
  priority: "normal" as const,
  tags: [],
};
const draft = {
  summary: [{ text: "Review the plan", evidence: ["s1"] }],
  actions: [
    {
      text: "Prepare a draft",
      evidence: ["s1"],
      owner: "Alex",
      dueDate: "2026-10-01",
    },
  ],
};
async function fixture(
  review?: (url: string, body: unknown) => Response | Promise<Response>,
) {
  let secret: Uint8Array | undefined,
    denied = false;
  const meeting = {
    id: randomUUID(),
    title: "PRIVATE_MEETING",
    language: "en",
    version: 1,
    segments: [
      {
        id: "s1",
        start: 4.5,
        end: 12,
        speaker: "Speaker",
        text: "PRIVATE_TRANSCRIPT: review the plan and draft",
      },
    ],
  };
  const grant = {
    token: "f".repeat(64),
    grantId: randomUUID(),
    subjectId: randomUUID(),
    workspaceId: randomUUID(),
    meetingId: meeting.id,
    actions: ["read_transcript"],
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    policyRevision: "autonote-ai-transcript-v1",
  };
  const connector = new AutoNoteConnector(
    JSON.stringify(owner),
    {
      getSecret: async () => secret,
      setSecret: async (v) => {
        secret = v;
      },
      deleteCredential: async () => {
        secret = undefined;
        return true;
      },
    },
    async (url, init) =>
      String(url).includes("/review-") && review
        ? review(String(url), JSON.parse(String(init?.body)))
        : String(url).endsWith("/exchange")
          ? Response.json(grant)
          : denied
            ? new Response("denied", { status: 403 })
            : Response.json({
                contractVersion: "1.0.0",
                grantId: grant.grantId,
                subjectId: grant.subjectId,
                workspaceId: grant.workspaceId,
                policyRevision: grant.policyRevision,
                meeting,
                projectionHash: createHash("sha256")
                  .update(JSON.stringify(meeting))
                  .digest("hex"),
                publication: { mode: "autonote_review_only", directCrm: false },
              }),
  );
  const start = await connector.begin();
  await connector.finish(start.id, "a".repeat(64));
  const adapter = new AutoNoteTasks(connector, owner, "device");
  return {
    connector,
    adapter,
    meeting,
    grant,
    deny: () => {
      denied = true;
    },
    sources: new SourceTasks(undefined, adapter),
  };
}
function worker(
  store: Store,
  f: Awaited<ReturnType<typeof fixture>>,
  generate: (_p: unknown, prompt: string) => Promise<string>,
) {
  return new LocalWorker(
    store,
    owner,
    { pin: async () => ({ profile, digest: "c".repeat(64) }), generate },
    () => profile,
    "worker",
    undefined,
    f.sources,
  );
}
test("AutoNote tasks derive one protected source binding and reject caller authority and mixed app references", async () => {
  const f = await fixture(),
    store = new Store(":memory:", new Vault(randomBytes(32)));
  try {
    assert.deepEqual(await f.adapter.choices(), [
      { id: f.meeting.id, title: f.meeting.title, version: 1 },
    ]);
    const task = await f.adapter.create(store, input, f.meeting.id, "one");
    assert.equal(
      (await f.adapter.create(store, input, f.meeting.id, "one")).id,
      task.id,
    );
    const binding = store.sourceBinding(owner, task.id)!;
    assert.equal(binding.authority.sourceApp, "autonote");
    assert.equal(binding.authority.subjectId, f.grant.subjectId);
    assert.equal(JSON.stringify(task).includes("PRIVATE_TRANSCRIPT"), false);
    assert.equal(JSON.stringify(task).includes(f.grant.token), false);
    assert.throws(
      () =>
        store.create(owner, { ...input, sourceRefs: binding.refs }, "forged"),
      /INVALID_INPUT/,
    );
    assert.throws(
      () => store.sourceBinding({ ...owner, userId: "other" }, task.id),
      /NOT_FOUND/,
    );
    for (const bad of [
      {
        ...binding,
        refs: [
          ...binding.refs,
          { ...binding.refs[0]!, resourceId: randomUUID() },
        ],
      },
      { ...binding, refs: [{ ...binding.refs[0]!, app: "crm" }] },
      { ...binding, refs: [{ ...binding.refs[0]!, tenantId: randomUUID() }] },
    ])
      assert.equal(sourceBindingSchema.safeParse(bad).success, false);
    await assert.rejects(new SourceTasks().validate(binding), /SOURCE_DENIED/);
    await assert.rejects(
      f.sources.validate({
        ...binding,
        authority: { ...binding.authority, sourceApp: "mail" },
      }),
      /SOURCE_DENIED/,
    );
    await assert.rejects(
      f.adapter.validate({
        ...binding,
        authority: { ...binding.authority, deviceId: "other" },
      }),
      /SOURCE_DENIED/,
    );
    await assert.rejects(
      f.adapter.validate({ ...binding, expiresAt: new Date(0).toISOString() }),
      /SOURCE_DENIED/,
    );
  } finally {
    store.close();
  }
});
test("AutoNote local generation verifies citations, derives source timestamps and labels suggestions unconfirmed", async () => {
  const f = await fixture(),
    store = new Store(":memory:", new Vault(randomBytes(32)));
  try {
    const task = await f.adapter.create(store, input, f.meeting.id, "draft");
    await worker(store, f, async (_p, prompt) => {
      assert.equal(store.db.inTransaction, false);
      assert.match(prompt, /untrusted data/);
      assert.match(prompt, /PRIVATE_TRANSCRIPT/);
      assert.equal(prompt.includes(f.grant.token), false);
      return JSON.stringify(draft);
    }).runOnce();
    const saved = store.get(owner, task.id);
    assert.equal(saved.status, "completed");
    const result = saved.result as any;
    assert.equal(result.kind, "unreviewed_draft");
    assert.match(result.text, /s1: 4.5–12s/);
    assert.match(result.text, /Suggested owner \(unconfirmed\): Alex/);
    assert.deepEqual(result.autonote.actions[0].citations, [
      { segmentId: "s1", start: 4.5, end: 12 },
    ]);
    assert.equal(result.autonote.actions[0].status, "unconfirmed");
    assert.equal(
      (store.runHistory(owner, task.id)[0]!.model as any).source.authority
        .grantId,
      f.grant.grantId,
    );
  } finally {
    store.close();
  }
});
test("malformed or fabricated AutoNote evidence cannot become a saved draft", async () => {
  for (const output of [
    "uncited prose",
    JSON.stringify({ ...draft, approved: true }),
    JSON.stringify({
      ...draft,
      summary: [{ text: "unsupported", evidence: ["missing"] }],
    }),
    JSON.stringify({
      ...draft,
      summary: [{ text: "unsupported", evidence: [] }],
    }),
    JSON.stringify({
      ...draft,
      summary: [{ text: "unsupported", evidence: ["s1"], start: 999 }],
    }),
    JSON.stringify({
      ...draft,
      actions: [{ ...draft.actions[0], status: "accepted" }],
    }),
  ]) {
    const f = await fixture(),
      store = new Store(":memory:", new Vault(randomBytes(32)));
    try {
      const task = await f.adapter.create(
        store,
        input,
        f.meeting.id,
        "invalid",
      );
      await worker(store, f, async () => output).runOnce();
      assert.equal(store.get(owner, task.id).status, "failed");
      assert.equal(store.get(owner, task.id).result, null);
    } finally {
      store.close();
    }
  }
});
test("AutoNote access, transcript changes and disconnect are checked before execution and again before commit", async () => {
  for (const change of [
    "before",
    "revision",
    "projection",
    "identity",
    "denied",
    "disconnect",
  ]) {
    const f = await fixture(),
      store = new Store(":memory:", new Vault(randomBytes(32)));
    let generated = false;
    try {
      const task = await f.adapter.create(store, input, f.meeting.id, change);
      if (change === "before") f.deny();
      await worker(store, f, async () => {
        generated = true;
        if (change === "revision") f.meeting.version++;
        if (change === "projection")
          f.meeting.segments[0]!.text = "changed without version";
        if (change === "identity") f.grant.subjectId = randomUUID();
        if (change === "denied") f.deny();
        if (change === "disconnect") await f.connector.forgetLocal();
        return JSON.stringify(draft);
      }).runOnce();
      assert.equal(store.get(owner, task.id).status, "failed", change);
      assert.equal(store.get(owner, task.id).result, null, change);
      if (change === "before") assert.equal(generated, false);
    } finally {
      store.close();
    }
  }
});
test("AutoNote bindings cannot enter the CRM adapter or CRM publication ledger", async () => {
  const f = await fixture(),
    store = new Store(":memory:", new Vault(randomBytes(32)));
  let calls = 0;
  const crm = new CrmConnector(
    JSON.stringify(owner),
    {
      getSecret: async () => {
        calls++;
        return undefined;
      },
      setSecret: async () => {},
      deleteCredential: async () => true,
    },
    async () => {
      calls++;
      throw Error("must not call CRM");
    },
  );
  const crmTasks = new CrmTasks(crm, owner, "device"),
    service = new CrmPublications(store, owner, crm, crmTasks);
  try {
    const task = await f.adapter.create(store, input, f.meeting.id, "no-crm");
    await worker(store, f, async () => JSON.stringify(draft)).runOnce();
    const binding = store.sourceBinding(owner, task.id)!;
    await assert.rejects(crmTasks.validate(binding), /SOURCE_DENIED/);
    await assert.rejects(service.permission(task.id), /SOURCE_DENIED/);
    const proposal = {
      operationId: randomUUID(),
      targetId: f.meeting.id,
      kind: "notes",
      name: "Meeting",
      description: "Draft",
      dueDate: "",
      sources: [{ id: f.meeting.id, version: 1 }],
      projectionHash: binding.projectionHash,
    };
    const { sources: _refs, projectionHash: _hash, ...edit } = proposal;
    await assert.rejects(
      service.reserve(task.id, { ...edit, permissionEpoch: randomUUID() }),
      /SOURCE_DENIED/,
    );
    assert.throws(
      () => store.reservePublication(owner, task.id, proposal),
      /INVALID_INPUT/,
    );
    assert.equal(calls, 0);
    assert.deepEqual(store.publications(owner, task.id), []);
    const snapshot = await f.adapter.validate(binding);
    assert.throws(
      () => sourceResult(snapshot, "x".repeat(256 * 1024 + 1)),
      /INVALID_SOURCE/,
    );
  } finally {
    store.close();
  }
});

test("AutoNote HTTP flow isolates consent, hides derived bulk data, guards individual exports and rejects CRM publication", async () => {
  const { createServer } = await import("node:http"),
    { localApi } = await import("../apps/companion/http.js");
  const f = await fixture(),
    store = new Store(":memory:", new Vault(randomBytes(32))),
    server = createServer();
  store.addProfile(owner, profile);
  await f.connector.forgetLocal();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port,
    token = "synthetic-local-credential".repeat(3);
  const stopped: unknown[] = [];
  const crm = new CrmConnector("other-app", {
    getSecret: async () => undefined,
    setSecret: async () => {},
    deleteCredential: async () => true,
  });
  server.on(
    "request",
    localApi({
      store,
      owner,
      port,
      token,
      autonote: f.connector,
      autonoteSources: f.adapter,
      crm,
      sources: new CrmTasks(crm, owner, "device"),
      cancelSourceRun: (app) => {
        stopped.push(app);
      },
    }),
  );
  const call = (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const base = "/v1/connections/autonote";
  try {
    assert.equal(
      (await call(base, "GET", undefined, { Authorization: "" })).status,
      401,
    );
    assert.equal(
      (
        await call(
          base + "/begin",
          "POST",
          {},
          { Origin: "https://evil.invalid" },
        )
      ).status,
      403,
    );
    const start = (await (
      await call(base + "/begin", "POST", {})
    ).json()) as any;
    assert.equal(
      new URL(start.consentUrl).origin,
      "https://autonote.bittrees.org",
    );
    assert.equal(
      (
        await call(base + "/finish", "POST", {
          id: start.id,
          code: "a".repeat(64),
          subjectId: randomUUID(),
        })
      ).status,
      400,
    );
    const finished = await call(base + "/finish", "POST", {
      id: start.id,
      code: "a".repeat(64),
    });
    assert.equal(finished.status, 200);
    assert.equal((await finished.text()).includes(f.grant.token), false);
    const choices = (await (
      await call(base + "/meetings", "POST", {})
    ).json()) as any;
    assert.deepEqual(choices.items, [
      { id: f.meeting.id, title: f.meeting.title, version: 1 },
    ]);
    assert.equal(JSON.stringify(choices).includes("PRIVATE_TRANSCRIPT"), false);
    const body = {
        conversationId: randomUUID(),
        meetingId: f.meeting.id,
        prompt: input.prompt,
        modelProfileId: profile.id,
      },
      headers = { "Idempotency-Key": "http" };
    assert.equal(
      (
        await call(
          base + "/drafts",
          "POST",
          { ...body, grantId: f.grant.grantId },
          headers,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await call(
          base + "/drafts",
          "POST",
          { ...body, meetingId: randomUUID() },
          headers,
        )
      ).status,
      400,
    );
    const created = await call(base + "/drafts", "POST", body, headers);
    assert.equal(created.status, 202);
    const task = (await created.json()) as any;
    assert.equal(task.sourceApp, "autonote");
    assert.equal(task.sourceBound, true);
    assert.equal(
      (
        (await (
          await call(base + "/drafts", "POST", body, headers)
        ).json()) as any
      ).id,
      task.id,
    );
    assert.equal(
      (
        await call(
          "/v1/requests",
          "POST",
          { ...input, sourceRefs: store.sourceBinding(owner, task.id)!.refs },
          headers,
        )
      ).status,
      403,
    );
    await worker(store, f, async () => JSON.stringify(draft)).runOnce();
    for (const path of ["/v1/export", "/v1/requests"]) {
      const text = await (await call(path)).text();
      assert.equal(text.includes("Review the plan"), false);
      assert.equal(text.includes(f.grant.token), false);
    }
    const prefix = "/v1/requests/" + task.id;
    const exported = (await (await call(prefix + "/export")).json()) as any;
    assert.equal(exported.task.result.autonote.meetingId, f.meeting.id);
    assert.equal(exported.runs.length, 1);
    assert.deepEqual(exported.publications, []);
    assert.equal(
      (await call(prefix + "/write-permission", "POST", {})).status,
      400,
    );
    f.deny();
    assert.equal((await call(prefix + "/export")).status, 400);
    const hidden = (await (await call(prefix)).json()) as any;
    assert.equal(hidden.result, null);
    assert.deepEqual(hidden.input.sourceRefs, []);
    assert.equal(hidden.sourceApp, "autonote");
    assert.deepEqual(
      ((await (await call(prefix + "/runs")).json()) as any).items,
      [],
    );
    assert.equal(
      (
        await call(base + "/local", "DELETE", undefined, {
          "X-Confirm-Delete": "local-crm-credential",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call(base + "/local", "DELETE", undefined, {
          "X-Confirm-Delete": "local-autonote-credential",
        })
      ).status,
      204,
    );
    assert.deepEqual(stopped, ["autonote"]);
    assert.equal(await f.connector.status(), null);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});

test("disconnect cancellation is scoped to the active source app", async () => {
  const f = await fixture(),
    store = new Store(":memory:", new Vault(randomBytes(32)));
  let started!: () => void, finish!: () => void;
  const beginning = new Promise<void>((r) => {
      started = r;
    }),
    hold = new Promise<void>((r) => {
      finish = r;
    });
  let aborted = false;
  try {
    const task = await f.adapter.create(
      store,
      input,
      f.meeting.id,
      "scoped-cancel",
    );
    const running = new LocalWorker(
      store,
      owner,
      {
        pin: async () => ({ profile, digest: "c".repeat(64) }),
        generate: async (_p, _prompt, signal) => {
          signal!.addEventListener(
            "abort",
            () => {
              aborted = true;
              finish();
            },
            { once: true },
          );
          started();
          await hold;
          return JSON.stringify(draft);
        },
      },
      () => profile,
      "worker",
      undefined,
      f.sources,
    );
    const work = running.runOnce();
    await beginning;
    running.cancelSource("crm");
    assert.equal(aborted, false);
    running.cancelSource("autonote");
    await work;
    assert.equal(aborted, true);
    assert.equal(store.get(owner, task.id).result, null);
    assert.equal(store.get(owner, task.id).status, "failed");
  } finally {
    finish?.();
    store.close();
  }
});

test("AutoNote operations survive encrypted restart and reconcile a saved receipt after lost responses without resubmission", async () => {
  const { AutoNoteReviews } =
      await import("../modules/connectors/autonote-reviews.js"),
    { mkdtempSync, readFileSync, rmSync } = await import("node:fs"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "autonote-reviews-")),
    path = join(dir, "tasks.db"),
    vault = new Vault(randomBytes(32));
  let store = new Store(path, vault),
    sends = 0,
    reconciles = 0,
    proposal: any,
    receipt: any = null;
  const reviewId = randomUUID(),
    expiresAt = new Date(Date.now() + 600000).toISOString();
  const reply = () => ({
    reviewId,
    digest: createHash("sha256").update(JSON.stringify(proposal)).digest("hex"),
    expiresAt,
    receipt,
  });
  const f = await fixture((url, body) => {
    assert.equal(store.db.inTransaction, false);
    if (url.endsWith("review-status"))
      return Response.json({
        grantId: f.grant.grantId,
        meetingId: f.meeting.id,
        enabled: true,
        expiresAt: f.grant.expiresAt,
      });
    if (url.endsWith("review-prepare")) {
      sends++;
      proposal = body;
      throw Error("lost staging response");
    }
    reconciles++;
    assert.deepEqual(body, { operationId: proposal.operationId });
    return Response.json({ ...reply(), deleted: false });
  });
  try {
    const task = await f.adapter.create(store, input, f.meeting.id, "durable");
    await worker(store, f, async () => JSON.stringify(draft)).runOnce();
    let service = new AutoNoteReviews(store, owner, f.connector, f.adapter);
    const operationId = randomUUID(),
      reserved = await service.reserve(task.id, { operationId });
    assert.equal(
      (await service.reserve(task.id, { operationId })).id,
      operationId,
    );
    await assert.rejects(
      service.reserve(task.id, { operationId: randomUUID() }),
      /CONFLICT/,
    );
    assert.equal(reserved.state, "local");
    assert.equal("citations" in reserved.proposal.summary[0]!, false);
    assert.equal("status" in reserved.proposal.actions[0]!, false);
    await assert.rejects(
      service.reserve(task.id, { operationId, approved: true }),
    );
    await assert.rejects(service.reconcile(operationId), /INVALID_INPUT/);
    await assert.rejects(service.prepare(operationId), /SOURCE_UNAVAILABLE/);
    assert.equal(store.autoNoteReview(owner, operationId).state, "uncertain");
    assert.throws(
      () => store.autoNoteReview({ ...owner, userId: "other" }, operationId),
      /NOT_FOUND/,
    );
    store.close();
    assert.equal(readFileSync(path).includes("Prepare a draft"), false);
    assert.equal(readFileSync(path).includes(f.grant.grantId), false);
    store = new Store(path, vault);
    service = new AutoNoteReviews(store, owner, f.connector, f.adapter);
    assert.equal(store.autoNoteReview(owner, operationId).state, "uncertain");
    assert.equal((await service.reconcile(operationId)).state, "prepared");
    assert.equal(sends, 1);
    f.meeting.version++;
    receipt = { meetingId: f.meeting.id, version: 2, operationId };
    assert.equal((await service.reconcile(operationId)).state, "saved");
    assert.deepEqual(
      (await service.reconcile(operationId)).response?.receipt,
      receipt,
    );
    assert.equal(reconciles, 2);
    assert.equal(sends, 1);
    assert.throws(
      () =>
        store.settleAutoNoteReview(
          owner,
          operationId,
          store.autoNoteReview(owner, operationId).revision,
          { uncertain: true },
        ),
      /CONFLICT/,
    );
    store.deleteAll(owner);
    assert.equal(
      (store.db.prepare("SELECT count(*) n FROM autonote_reviews").get() as any)
        .n,
      0,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("AutoNote dispatch records uncertainty before a receipt storage failure and preserves immutable operation identity", async () => {
  const { AutoNoteReviews } =
    await import("../modules/connectors/autonote-reviews.js");
  const store = new Store(":memory:", new Vault(randomBytes(32)));
  let proposal: any,
    called = 0;
  const reviewId = randomUUID(),
    expiresAt = new Date(Date.now() + 600000).toISOString();
  const f = await fixture((url, body) => {
    if (url.endsWith("review-status"))
      return Response.json({
        grantId: f.grant.grantId,
        meetingId: f.meeting.id,
        enabled: true,
        expiresAt: f.grant.expiresAt,
      });
    if (url.endsWith("review-prepare")) {
      called++;
      proposal = body;
      assert.equal(
        store.autoNoteReview(owner, proposal.operationId).state,
        "uncertain",
      );
    }
    return Response.json({
      reviewId,
      digest: createHash("sha256")
        .update(JSON.stringify(proposal))
        .digest("hex"),
      expiresAt,
      receipt: null,
      ...(url.endsWith("review-receipt") ? { deleted: false } : {}),
    });
  });
  try {
    const task = await f.adapter.create(
      store,
      input,
      f.meeting.id,
      "storage-failure",
    );
    await worker(store, f, async () => JSON.stringify(draft)).runOnce();
    const service = new AutoNoteReviews(store, owner, f.connector, f.adapter),
      operationId = randomUUID();
    const local = await service.reserve(task.id, { operationId });
    assert.throws(
      () =>
        store.reserveAutoNoteReview(owner, task.id, {
          ...local.proposal,
          summary: [{ text: "changed", evidence: ["s1"] }],
        }),
      /CONFLICT/,
    );
    assert.throws(
      () =>
        store.reserveAutoNoteReview(owner, task.id, {
          ...local.proposal,
          operationId: randomUUID(),
          meetingId: randomUUID(),
        }),
      /INVALID_INPUT/,
    );
    store.db.exec(
      "CREATE TRIGGER fail_review_receipt BEFORE UPDATE ON autonote_reviews WHEN NEW.revision=3 BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END",
    );
    await assert.rejects(
      service.prepare(operationId),
      /synthetic disk failure/,
    );
    assert.equal(store.autoNoteReview(owner, operationId).state, "uncertain");
    assert.equal(service.busy, false);
    store.db.exec("DROP TRIGGER fail_review_receipt");
    assert.equal((await service.reconcile(operationId)).state, "prepared");
    assert.equal(called, 1);
    const current = store.autoNoteReview(owner, operationId);
    assert.throws(
      () =>
        store.settleAutoNoteReview(owner, operationId, 1, { uncertain: true }),
      /CONFLICT/,
    );
    assert.throws(
      () =>
        store.settleAutoNoteReview(owner, operationId, current.revision, {
          response: { ...current.response, reviewId: randomUUID() },
        }),
      /CONFLICT/,
    );
  } finally {
    store.close();
  }
});
test("schema six migration preserves tasks and adds the AutoNote operation ledger", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ai-schema7-")),
    path = join(dir, "tasks.db"),
    vault = new Vault(randomBytes(32));
  let store = new Store(path, vault);
  try {
    const task = store.create(owner, input, "preserved");
    store.db.exec("DROP TABLE autonote_reviews; PRAGMA user_version=6");
    store.close();
    store = new Store(path, vault);
    assert.deepEqual(store.get(owner, task.id), task);
    assert.deepEqual(store.autoNoteReviews(owner, task.id), []);
    assert.equal(store.db.pragma("user_version", { simple: true }), 37);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AutoNote submission HTTP controls gate content, reject approval and retain history during in-flight deletion", async () => {
  const { createServer } = await import("node:http"),
    { localApi } = await import("../apps/companion/http.js");
  const store = new Store(":memory:", new Vault(randomBytes(32))),
    server = createServer();
  let proposal: any,
    receipt: any = null,
    dispatches = 0,
    started!: () => void,
    release!: () => void;
  const beginning = new Promise<void>((r) => {
      started = r;
    }),
    hold = new Promise<void>((r) => {
      release = r;
    }),
    reviewId = randomUUID(),
    expiresAt = new Date(Date.now() + 600000).toISOString();
  const f = await fixture(async (url, body) => {
    if (url.endsWith("review-status"))
      return Response.json({
        grantId: f.grant.grantId,
        meetingId: f.meeting.id,
        enabled: true,
        expiresAt: f.grant.expiresAt,
      });
    if (url.endsWith("review-prepare")) {
      dispatches++;
      proposal = body;
      started();
      await hold;
    }
    return Response.json({
      reviewId,
      digest: createHash("sha256")
        .update(JSON.stringify(proposal))
        .digest("hex"),
      expiresAt,
      receipt,
      ...(url.endsWith("review-receipt") ? { deleted: false } : {}),
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port,
    token = "local-credential".repeat(4);
  server.on(
    "request",
    localApi({
      store,
      owner,
      port,
      token,
      autonote: f.connector,
      autonoteSources: f.adapter,
    }),
  );
  const call = (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const task = await f.adapter.create(
      store,
      input,
      f.meeting.id,
      "http-submission",
    );
    await worker(store, f, async () => JSON.stringify(draft)).runOnce();
    const path = "/v1/requests/" + task.id,
      operationId = randomUUID();
    assert.equal(
      (
        await call(path + "/autonote-reviews", "POST", {
          operationId,
          approved: true,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call(
          path + "/autonote-reviews",
          "POST",
          { operationId },
          { Authorization: "" },
        )
      ).status,
      401,
    );
    const reserved = await call(path + "/autonote-reviews", "POST", {
      operationId,
    });
    assert.equal(reserved.status, 201);
    assert.equal((await reserved.text()).includes("Review the plan"), false);
    assert.equal(
      (
        await call(path + "/autonote-reviews", "POST", {
          operationId: randomUUID(),
        })
      ).status,
      409,
    );
    const op = "/v1/autonote-reviews/" + operationId;
    assert.equal(
      ((await (await call(op + "/content")).json()) as any).proposal.summary[0]
        .text,
      draft.summary[0]!.text,
    );
    assert.equal(
      ((await (await call(path + "/export")).json()) as any).autonoteReviews[0]
        .id,
      operationId,
    );
    assert.equal(
      (await call(op + "/prepare", "POST", { approved: true })).status,
      400,
    );
    const preparing = call(op + "/prepare", "POST", {});
    await beginning;
    assert.equal(
      (
        await call("/v1/data", "DELETE", undefined, {
          "X-Confirm-Delete": "all-local-task-data",
        })
      ).status,
      409,
    );
    assert.equal((await call(op + "/prepare", "POST", {})).status, 409);
    assert.equal(store.autoNoteReview(owner, operationId).state, "uncertain");
    release();
    assert.equal((await preparing).status, 200);
    f.meeting.version++;
    receipt = { meetingId: f.meeting.id, version: 2, operationId };
    assert.equal((await call(op + "/content")).status, 400);
    assert.equal((await call(path + "/export")).status, 400);
    const summary = await (await call(path + "/autonote-reviews")).text();
    assert.equal(summary.includes(draft.summary[0]!.text), false);
    assert.equal(summary.includes(f.grant.token), false);
    const recovered = (await (
      await call(op + "/reconcile", "POST", {})
    ).json()) as any;
    assert.equal(recovered.state, "saved");
    assert.deepEqual(recovered.receipt, receipt);
    assert.equal((await call(op + "/reconcile", "POST", {})).status, 200);
    assert.equal(dispatches, 1);
    assert.equal(
      (
        await call("/v1/data", "DELETE", undefined, {
          "X-Confirm-Delete": "all-local-task-data",
        })
      ).status,
      204,
    );
    assert.equal((await call(op + "/content")).status, 404);
  } finally {
    release?.();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});

test("autonote conversation access uses a fresh source read and fences local removal", async () => {
  const f = await fixture(),
    store = new Store(":memory:", new Vault(randomBytes(32)));
  try {
    const task = await f.adapter.create(store, input, f.meeting.id, "access");
    const access = conversationTaskAccess(store, owner, f.sources);
    const check = await access(task.id);
    store.db.transaction(() => check()).immediate();
    await f.connector.forgetLocal();
    assert.throws(check, /SOURCE_DENIED/);
    await assert.rejects(access(task.id));
  } finally {
    store.close();
  }
});
