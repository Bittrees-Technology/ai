import { sourceMemoryAccess } from "../apps/companion/source-memory.js";
import { MemoryStore } from "../modules/memory/store.js";
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
  scope = owner,
  clock = Date.now,
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
    expiresAt: new Date(clock() + 86400000).toISOString(),
    policyRevision: "autonote-ai-transcript-v1",
  };
  const connector = new AutoNoteConnector(
    JSON.stringify(scope),
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
    clock,
  );
  const start = await connector.begin();
  await connector.finish(start.id, "a".repeat(64));
  const adapter = new AutoNoteTasks(connector, scope, "device");
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
  scope = owner,
) {
  return new LocalWorker(
    store,
    scope,
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
    // Reuse this source-generation fixture for memory provenance and revocation.
    const memoryAccess = sourceMemoryAccess(store, f.sources, () => memory);
    const memory = new MemoryStore(
      ":memory:",
      new Vault(randomBytes(32)),
      memoryAccess,
    );
    try {
      const candidate = await memory.add(owner, {
        type: "decision",
        text: result.text,
        origin: "model",
        sources: [
          {
            app: "local",
            tenantId: owner.tenantId,
            resourceId: task.id,
            revision: String(saved.revision),
          },
        ],
      });
      const retained = await memory.get(owner, candidate.id);
      assert.equal(retained.state, "candidate");
      assert.equal(retained.verified, false);
      await memory.review(owner, candidate.id, retained.revision, {
        approve: true,
      });
      assert.equal((await memory.search(owner, "Review the plan")).length, 1);
      await assert.rejects(
        memory.get({ ...owner, userId: "other" }, candidate.id),
      );
      const followup = store.create(
        owner,
        {
          ...input,
          conversationId: "memory-followup",
          memoryIds: [candidate.id],
        },
        randomUUID(),
      );
      const reuse = new LocalWorker(
        store,
        owner,
        {
          pin: async () => ({ profile, digest: "e".repeat(64) }),
          generate: async (_profile, prompt) => {
            assert.match(prompt, /Review the plan/);
            return "SOURCE_MEMORY_RESULT";
          },
        },
        () => profile,
        "source-memory-worker",
        memory,
        f.sources,
      );
      await reuse.runOnce();
      assert.equal(store.get(owner, followup.id).status, "completed");
      const access = conversationTaskAccess(store, owner, f.sources, memory);
      (await access(followup.id))();
      // Retaining another memory from a derived result keeps the original source dependency.
      const derived = store.get(owner, followup.id);
      const child = await memory.add(owner, {
        type: "outcome",
        text: "SOURCE_MEMORY_RESULT",
        origin: "model",
        sources: [
          {
            app: "local",
            tenantId: owner.tenantId,
            resourceId: derived.id,
            revision: String(derived.revision),
          },
        ],
      });
      assert.equal((await memory.get(owner, child.id)).state, "candidate");
      const { createServer } = await import("node:http");
      const { localApi } = await import("../apps/companion/http.js");
      const server = createServer();
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as import("node:net").AddressInfo).port;
      const token = "synthetic-memory-credential".repeat(3);
      server.on(
        "request",
        localApi({
          store,
          owner,
          port,
          token,
          memory,
          autonote: f.connector,
          autonoteSources: f.adapter,
        }),
      );
      const call = (path: string, body?: unknown) =>
        fetch(`http://127.0.0.1:${port}${path}`, {
          method: body ? "POST" : "GET",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      try {
        const current = await (
          await call("/v1/requests/" + followup.id)
        ).json();
        assert.equal(current.result.text, "SOURCE_MEMORY_RESULT");
        const captured = await call("/v1/requests/" + task.id + "/memories", {
          text: "Reviewed meeting memory",
          type: "decision",
          expectedRevision: saved.revision,
        });
        assert.equal(captured.status, 201);
        f.deny();
        const hidden = await (await call("/v1/requests/" + followup.id)).json();
        assert.equal(hidden.result, null);
        assert.equal(hidden.dependencyAccess, "unavailable");
        assert.deepEqual(
          (await (await call("/v1/requests/" + followup.id + "/runs")).json())
            .items,
          [],
        );
        const deniedCapture = await call(
          "/v1/requests/" + task.id + "/memories",
          {
            text: "Unavailable memory",
            type: "fact",
          },
        );
        assert.equal(deniedCapture.status, 400);
        assert.equal((await deniedCapture.json()).error, "SOURCE_DENIED");
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      await assert.rejects(access(followup.id));
      await assert.rejects(memory.get(owner, child.id));
      await assert.rejects(memory.get(owner, candidate.id));
      assert.deepEqual(await memory.search(owner, "Review the plan"), []);
      assert.deepEqual(await memory.export(owner), []);
      memory.forget(owner, candidate.id);
    } finally {
      memory.close();
    }

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
    assert.equal(store.db.pragma("user_version", { simple: true }), 38);
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

test("exact companion approval cancels, fences changed detail and reconciles a lost save after restart", async () => {
  const { AutoNoteReviews } =
      await import("../modules/connectors/autonote-reviews.js"),
    { AutoNoteApprovalConnector } =
      await import("../modules/connectors/autonote-approval.js"),
    { mkdtempSync, rmSync, readFileSync } = await import("node:fs"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "autonote-exact-")),
    path = join(dir, "tasks.db"),
    vault = new Vault(randomBytes(32));
  let store = new Store(path, vault),
    proposal: any,
    receipt: any = null,
    saves = 0,
    changed = false;
  const reviewId = randomUUID(),
    expiresAt = new Date(Date.now() + 600000).toISOString();
  const reply = () => ({
    reviewId,
    digest: createHash("sha256").update(JSON.stringify(proposal)).digest("hex"),
    expiresAt,
    receipt,
  });
  const f = await fixture((url, body) => {
    if (url.endsWith("review-status"))
      return Response.json({
        grantId: f.grant.grantId,
        meetingId: f.meeting.id,
        enabled: true,
        expiresAt: f.grant.expiresAt,
      });
    if (url.endsWith("review-prepare")) {
      proposal = body;
      return Response.json(reply());
    }
    assert.ok(url.endsWith("review-receipt"));
    return Response.json({ ...reply(), deleted: false });
  });
  let secret: Uint8Array | undefined;
  const credential = {
    approvalId: randomUUID(),
    grantId: f.grant.grantId,
    meetingId: f.meeting.id,
    actions: ["approve_meeting_notes"],
    token: "b".repeat(64),
    expiresAt,
  };
  const approval = new AutoNoteApprovalConnector(
    "owner",
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
    f.connector,
    async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("approval-exchange"))
        return Response.json(credential);
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer " + credential.token,
      );
      if (String(url).endsWith("approval-review"))
        return Response.json({
          id: reviewId,
          digest: reply().digest,
          expiresAt,
          meetingId: f.meeting.id,
          title: changed ? "Changed title" : f.meeting.title,
          visibility: "workspace",
          proposal,
          notes: {
            summary: "SYNTHETIC_EXACT_NOTES",
            topics: [],
            decisions: [],
            actions: [],
            questions: [],
            recommendations: [],
          },
        });
      assert.ok(String(url).endsWith("approval-save"));
      assert.deepEqual(body, {
        reviewId,
        digest: reply().digest,
        confirmed: true,
      });
      const journal = store.autoNoteReview(owner, proposal.operationId);
      assert.equal(journal.state, "uncertain");
      assert.equal(journal.approvalAttempt?.approvalId, credential.approvalId);
      assert.equal(store.db.inTransaction, false);
      saves++;
      receipt = {
        meetingId: f.meeting.id,
        version: proposal.version + 1,
        operationId: proposal.operationId,
      };
      throw Error("synthetic lost save response");
    },
  );
  try {
    const start = await approval.begin();
    await approval.finish(start.id, "c".repeat(64));
    const task = await f.adapter.create(
      store,
      input,
      f.meeting.id,
      "approval-lost-response",
    );
    await worker(store, f, async () => JSON.stringify(draft)).runOnce();
    let service = new AutoNoteReviews(
      store,
      owner,
      f.connector,
      f.adapter,
      approval,
    );
    const operationId = randomUUID();
    await service.reserve(task.id, { operationId });
    await service.prepare(operationId);
    const cancelled = await service.reviewApproval(operationId);
    service.cancelApproval(operationId);
    await assert.rejects(
      service.approve(operationId, {
        reviewToken: cancelled.reviewToken,
        confirmed: true,
        acknowledged: true,
      }),
    );
    assert.equal(saves, 0);
    const stale = await service.reviewApproval(operationId);
    changed = true;
    await assert.rejects(
      service.approve(operationId, {
        reviewToken: stale.reviewToken,
        confirmed: true,
        acknowledged: true,
      }),
    );
    assert.equal(saves, 0);
    changed = false;
    const exact = await service.reviewApproval(operationId);
    await assert.rejects(
      service.approve(operationId, {
        reviewToken: exact.reviewToken,
        confirmed: true,
        acknowledged: true,
      }),
    );
    assert.equal(saves, 1);
    assert.equal(store.autoNoteReview(owner, operationId).state, "uncertain");
    await assert.rejects(
      service.approve(operationId, {
        reviewToken: exact.reviewToken,
        confirmed: true,
        acknowledged: true,
      }),
    );
    assert.equal(saves, 1);
    store.close();
    assert.equal(
      readFileSync(path).includes(Buffer.from("SYNTHETIC_EXACT_NOTES")),
      false,
    );
    store = new Store(path, vault);
    service = new AutoNoteReviews(
      store,
      owner,
      f.connector,
      f.adapter,
      approval,
    );
    await assert.rejects(service.reviewApproval(operationId));
    assert.equal(saves, 1);
    const reconciled = await service.reconcile(operationId);
    assert.equal(reconciled.state, "saved");
    assert.deepEqual(reconciled.response?.receipt, receipt);
    assert.equal(saves, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("separate browser approval consent binds exact notes, peer proofs and source permission", async () => {
  const { conversationFixture, owner: peerOwner } =
      await import("./helpers/conversation-fixture.js"),
    { PrivateAutoNoteApprovalConsent } =
      await import("../modules/remote/private-autonote-approval-consent.js"),
    { AutoNoteApprovalConnector } =
      await import("../modules/connectors/autonote-approval.js"),
    { AutoNoteReviews } =
      await import("../modules/connectors/autonote-reviews.js");
  const peer = await conversationFixture();
  let proposal: any,
    changed = false,
    saves = 0,
    receipt: any = null,
    secret: Uint8Array | undefined;
  const reviewId = randomUUID(),
    expiresAt = new Date(peer.clock() + 600000).toISOString(),
    reply = () => ({
      reviewId,
      digest: createHash("sha256")
        .update(JSON.stringify(proposal))
        .digest("hex"),
      expiresAt,
      receipt,
    });
  const f = await fixture(
    (url, body) => {
      if (url.endsWith("review-status"))
        return Response.json({
          grantId: f.grant.grantId,
          meetingId: f.meeting.id,
          enabled: true,
          expiresAt: f.grant.expiresAt,
        });
      if (url.endsWith("review-prepare")) {
        proposal = body;
        return Response.json(reply());
      }
      if (url.endsWith("review-receipt"))
        return Response.json({ ...reply(), deleted: false });
      throw Error("Unexpected source request");
    },
    peerOwner,
    peer.clock,
  );
  const credential = {
    approvalId: randomUUID(),
    grantId: f.grant.grantId,
    meetingId: f.meeting.id,
    actions: ["approve_meeting_notes"],
    token: "b".repeat(64),
    expiresAt,
  };
  const approval = new AutoNoteApprovalConnector(
    JSON.stringify(peerOwner),
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
    f.connector,
    async (url) => {
      if (String(url).endsWith("approval-exchange"))
        return Response.json(credential);
      if (String(url).endsWith("approval-save")) {
        saves++;
        assert.equal(
          peer.store.autoNoteReview(peerOwner, proposal.operationId).state,
          "uncertain",
        );
        receipt = {
          meetingId: f.meeting.id,
          version: proposal.version + 1,
          operationId: proposal.operationId,
        };
        throw Error("Synthetic lost save response");
      }
      assert.ok(String(url).endsWith("approval-review"));
      return Response.json({
        id: reviewId,
        digest: reply().digest,
        expiresAt,
        meetingId: f.meeting.id,
        title: changed ? "Changed audience context" : f.meeting.title,
        visibility: "workspace",
        proposal,
        notes: {
          summary: "Synthetic complete notes",
          topics: [],
          decisions: [],
          actions: [],
          questions: [],
          recommendations: [],
        },
      });
    },
    peer.clock,
  );
  try {
    const setup = await approval.begin();
    await approval.finish(setup.id, "c".repeat(64));
    const task = await f.adapter.create(
      peer.store,
      input,
      f.meeting.id,
      "peer-approval",
    );
    await worker(
      peer.store,
      f,
      async () => JSON.stringify(draft),
      peerOwner,
    ).runOnce();
    const ledger = new AutoNoteReviews(
        peer.store,
        peerOwner,
        f.connector,
        f.adapter,
        approval,
      ),
      operationId = randomUUID();
    await ledger.reserve(task.id, { operationId });
    await ledger.prepare(operationId);
    const consent = new PrivateAutoNoteApprovalConsent(
      peer.store,
      peer.vault,
      peerOwner,
      peer.current,
      peer.keys,
      peer.peers,
      approval,
      f.adapter,
      peer.clock,
    );
    const prepare = () =>
      consent.prepare({
        operationId,
        expectedRevision: consent.list(operationId).revision,
        peerId: peer.peerId,
        peerKeyEpoch: 1,
        expiresAt: peer.clock() + 300000,
      });
    const review = await prepare();
    assert.equal(consent.list(operationId).grants.length, 0);
    const granted = await consent.approve({
      reviewId: review.id,
      expectedRevision: review.revision,
      confirmed: true,
      acknowledged: true,
    });
    assert.equal(granted.grant.scope, "autonote:approve-exact-notes");
    const resolved = await consent.resolve(operationId, granted.grant.id);
    resolved.check();
    const offer = await consent.frameOffer(
      operationId,
      granted.grant.id,
      randomUUID(),
    );
    assert.equal(offer.manifest.permissionId, granted.grant.id);
    assert.equal(offer.manifest.detailHash, granted.grant.detailHash);
    assert.equal(offer.manifest.operationId, operationId);

    const { PrivateAutoNoteApprovalOutbox } =
      await import("../modules/remote/private-autonote-approval-outbox.js");
    const { privateRelayEnvelopeHash } =
      await import("../modules/remote/private-relay-contracts.js");
    const outbox = new PrivateAutoNoteApprovalOutbox(
      peer.store,
      peer.vault,
      peerOwner,
      consent,
      peer.clock,
    );
    const request = {
      operationId,
      permissionId: granted.grant.id,
      clientRequestId: randomUUID(),
      expectedRevision: consent.list(operationId).revision,
      confirmed: true,
    };
    const queued = await outbox.prepare(request);
    assert.deepEqual(await outbox.prepare(request), queued);
    await outbox.encrypt(operationId, queued.id);
    let sent: unknown;
    await assert.rejects(
      outbox.dispatch(operationId, queued.id, 0, async (envelope) => {
        sent = structuredClone(envelope);
        throw Error("Synthetic lost response");
      }),
      /Synthetic lost response/,
    );
    assert.equal(outbox.status(operationId)[0]!.packets[0]!.attempts, 1);
    assert.equal(outbox.status(operationId)[0]!.packets[0]!.receipt, null);
    const reopened = new Store(peer.path, peer.vault, peer.clock);
    try {
      const reopenedKeys = peer.build(reopened);
      const reopenedConsent = new PrivateAutoNoteApprovalConsent(
        reopened,
        peer.vault,
        peerOwner,
        peer.current,
        reopenedKeys.keys,
        reopenedKeys.peers,
        approval,
        f.adapter,
        peer.clock,
      );
      const resumed = new PrivateAutoNoteApprovalOutbox(
        reopened,
        peer.vault,
        peerOwner,
        reopenedConsent,
        peer.clock,
      );
      await resumed.encrypt(operationId, queued.id);
      await resumed.dispatch(operationId, queued.id, 0, async (envelope) => {
        assert.deepEqual(envelope, sent);
        return {
          version: 1,
          messageId: envelope.header.messageId,
          envelopeHash: await privateRelayEnvelopeHash(envelope),
          revision: 1,
          storedAt: peer.clock(),
          state: "stored",
        };
      });
      assert.equal(resumed.status(operationId)[0]!.packets[0]!.attempts, 2);
      assert.equal(
        resumed.status(operationId)[0]!.packets[0]!.receipt?.state,
        "stored",
      );
    } finally {
      reopened.close();
    }

    const { encryptedBackup, restoreBackup } =
      await import("../modules/storage/backup.js");
    const { join } = await import("node:path");
    const backup = join(peer.dir, "approval.aib"),
      restoredPath = join(peer.dir, "approval-restored.db");
    await encryptedBackup(peer.store, peer.vault, backup);
    await restoreBackup(backup, peer.vault, restoredPath);
    const restored = new Store(restoredPath, peer.vault, peer.clock);
    try {
      const restoredKeys = peer.build(restored);
      const restoredConsent = new PrivateAutoNoteApprovalConsent(
        restored,
        peer.vault,
        peerOwner,
        peer.current,
        restoredKeys.keys,
        restoredKeys.peers,
        approval,
        f.adapter,
        peer.clock,
      );
      assert.equal(restoredConsent.list(operationId).grants.length, 1);
      const restoredOutbox = new PrivateAutoNoteApprovalOutbox(
        restored,
        peer.vault,
        peerOwner,
        restoredConsent,
        peer.clock,
      );
      assert.equal(restoredOutbox.status(operationId).length, 1);
      await assert.rejects(restoredOutbox.encrypt(operationId, queued.id));
      await assert.rejects(
        restoredConsent.resolve(operationId, granted.grant.id),
      );
    } finally {
      restored.close();
    }

    outbox.stop(operationId, queued.id);
    await assert.rejects(
      outbox.dispatch(operationId, queued.id, 0, async () => {
        assert.fail("Stopped outbox must not upload");
      }),
    );
    outbox.remove(operationId, queued.id);
    assert.equal(outbox.status(operationId).length, 0);
    changed = true;
    await assert.rejects(consent.resolve(operationId, granted.grant.id));
    changed = false;
    consent.revoke({
      operationId,
      permissionId: granted.grant.id,
      expectedRevision: consent.list(operationId).revision,
      confirmed: true,
    });
    assert.throws(() => resolved.check());
    await assert.rejects(consent.resolve(operationId, granted.grant.id));
    const fresh = await prepare();
    consent.invalidate();
    await assert.rejects(
      consent.approve({
        reviewId: fresh.id,
        expectedRevision: fresh.revision,
        confirmed: true,
        acknowledged: true,
      }),
    );
    assert.equal(consent.list(operationId).grants[0]!.revoked, true);
    const { CompanionAutoNoteApprovals } =
      await import("../apps/companion/private-autonote-approvals.js");
    const host = new CompanionAutoNoteApprovals(
      peer.store,
      peer.vault,
      peerOwner,
      () => peer.keys,
      approval,
      f.adapter,
      {
        withVerifiedDevice: async (fn: any) => fn({ current: peer.current }),
      } as any,
      true,
      peer.clock,
      undefined,
      f.connector,
    );
    const grantInput = () => ({
      action: "grant",
      operationId,
      expectedRevision: host.status(operationId).revision,
      peerId: peer.peerId,
      peerKeyEpoch: 1,
      expiresAt: peer.clock() + 240000,
    });
    const cancelled = await host.prepare(grantInput());
    host.invalidate();
    await assert.rejects(
      host.confirm({
        reviewId: cancelled.id,
        confirmed: true,
        acknowledged: true,
      }),
    );
    const hostReview = await host.prepare(grantInput());
    const permitted = await host.confirm({
      reviewId: hostReview.id,
      confirmed: true,
      acknowledged: true,
    });
    assert.equal(permitted.permissions.length, 1);
    assert.equal(permitted.permissions[0]!.revoked, false);
    const create = await host.prepare({
      action: "create",
      operationId,
      expectedRevision: permitted.revision,
      permissionId: permitted.permissions[0]!.id,
    });
    const ready = await host.confirm({
      reviewId: create.id,
      confirmed: true,
      acknowledged: true,
    });
    assert.equal(ready.offers.length, 1);
    assert.equal(ready.offers[0]!.state, "ready");
    assert.ok(
      ready.offers[0]!.packets.every((p) => p.encrypted && p.attempts === 0),
    );
    await assert.rejects(
      host.confirm({
        reviewId: create.id,
        confirmed: true,
        acknowledged: true,
      }),
    );
    let uploads = 0;
    let lastUpload: unknown;
    let incoming: any;
    let acknowledgements = 0;
    const relay = {
      withTransport: async (_: unknown, fn: any) =>
        fn(
          {
            poll: async () => ({
              items: incoming ? [incoming] : [],
              nextCursor: null,
            }),
            acknowledge: async () => {
              acknowledgements++;
              assert.equal(decisions.status(operationId)[0]!.state, "accepted");
            },
            recipient: async () => ({
              endpointId: peer.peerId,
              expiresAt: peer.clock() + 300000,
            }),
            submit: async ({ envelope }: any, check: () => void) => {
              check();
              uploads++;
              lastUpload = envelope;
              return {
                receipt: {
                  version: 1,
                  messageId: envelope.header.messageId,
                  envelopeHash: await privateRelayEnvelopeHash(envelope),
                  revision: 1,
                  storedAt: peer.clock(),
                  state: "stored",
                },
              };
            },
          },
          peer.current,
          peer.clock() + 300000,
        ),
    } as any;
    const send = await host.prepare(
      {
        action: "send",
        operationId,
        expectedRevision: ready.revision,
        offerId: ready.offers[0]!.id,
        index: 0,
        connection: { id: randomUUID(), expectedRevision: 1 },
      },
      relay,
    );
    const delivered = await host.confirm(
      { reviewId: send.id, confirmed: true, acknowledged: true },
      relay,
    );
    assert.equal(uploads, 1);
    assert.equal(delivered.offers[0]!.packets[0]!.receipt?.state, "stored");
    const remaining = await host.prepare(
      {
        action: "send",
        operationId,
        expectedRevision: delivered.revision,
        offerId: ready.offers[0]!.id,
        connection: { id: randomUUID(), expectedRevision: 1 },
      },
      relay,
    );
    const complete = await host.confirm(
      { reviewId: remaining.id, confirmed: true, acknowledged: true },
      relay,
    );
    assert.equal(uploads, ready.offers[0]!.packets.length);
    assert.ok(
      complete.offers[0]!.packets.every((p) => p.receipt?.state === "stored"),
    );
    const { PrivateAutoNoteDecisions } =
      await import("../modules/remote/private-autonote-decisions.js");
    const { sealPrivateEnvelope, openPrivateEnvelope, privateEnvelopeSuite } =
      await import("../modules/remote/private-envelope.js");
    const decisions = new PrivateAutoNoteDecisions(
      peer.store,
      peer.vault,
      peerOwner,
      consent,
      approval,
      peer.clock,
    );
    const box = peer.store.autoNoteReview(peerOwner, operationId)
      .approvalOutboxes![0]!;
    const g = box.grant;
    const command = {
      version: 1,
      type: "autonote.approval.decision",
      id: randomUUID(),
      offerId: box.id,
      permissionId: g.id,
      detailHash: g.detailHash,
      proposalDigest: g.proposalDigest,
      decision: "approve",
      confirmed: true,
      issuedAt: peer.clock(),
    };
    const envelope = await sealPrivateEnvelope(
      {
        version: 1,
        suite: privateEnvelopeSuite,
        ownerId: g.local.binding.ownerId,
        senderId: g.peer.peerId,
        recipientId: g.local.binding.deviceId,
        senderKeyEpoch: g.peer.keyEpoch,
        recipientKeyEpoch: g.local.keyEpoch,
        messageId: randomUUID(),
        operationId: command.id,
        sequence: 90000,
        issuedAt: command.issuedAt,
        expiresAt: box.manifest.expiresAt,
      },
      new TextEncoder().encode(JSON.stringify(command)),
      {
        senderKey: peer.sender,
        recipientPublicKey: (await peer.keys.resolve()).pair.publicKey,
      },
      peer.clock,
    );
    const decisionInput = {
      operationId,
      permissionId: g.id,
      envelope,
      confirmed: true,
    };
    incoming = {
      envelope,
      receipt: {
        version: 1,
        messageId: envelope.header.messageId,
        envelopeHash: await privateRelayEnvelopeHash(envelope),
        revision: 1,
        storedAt: peer.clock(),
        state: "stored",
      },
    };
    const receiving = await host.prepare(
      {
        action: "receive",
        operationId,
        expectedRevision: host.status(operationId).revision,
        permissionId: g.id,
        connection: { id: randomUUID(), expectedRevision: 1 },
        after: null,
      },
      relay,
    );
    assert.equal(saves, 0);
    await host.confirm(
      { reviewId: receiving.id, confirmed: true, acknowledged: true },
      relay,
    );
    assert.equal(acknowledgements, 1);
    assert.equal(decisions.status(operationId)[0]!.state, "accepted");
    assert.deepEqual(await decisions.receive(decisionInput), {
      duplicate: true,
      state: "accepted",
    });
    assert.equal(saves, 0);
    const execute = { operationId, decisionId: command.id, confirmed: true };
    const execution = await host.prepare({
      action: "execute",
      operationId,
      decisionId: command.id,
      expectedRevision: host.status(operationId).revision,
    });
    await assert.rejects(
      host.confirm({
        reviewId: execution.id,
        confirmed: true,
        acknowledged: true,
      }),
    );
    assert.equal(saves, 1);
    assert.equal(decisions.status(operationId)[0]!.state, "uncertain");
    await assert.rejects(decisions.execute(execute));
    const resultInput = {
      operationId,
      decisionId: command.id,
      confirmed: true,
    };
    await decisions.prepareResult(resultInput);
    const uncertainMessage =
      decisions.status(operationId)[0]!.resultDeliveries[0]!.messageId;
    const reconciliation = await host.prepare({
      action: "reconcile",
      operationId,
      decisionId: command.id,
      expectedRevision: host.status(operationId).revision,
    });
    const recovered = await host.confirm({
      reviewId: reconciliation.id,
      confirmed: true,
      acknowledged: true,
    });
    assert.equal(recovered.decisions[0]!.state, "saved");
    assert.deepEqual(
      decisions.status(operationId)[0]!.result?.receipt,
      receipt,
    );
    assert.deepEqual(await decisions.receive(decisionInput), {
      duplicate: true,
      state: "saved",
    });
    assert.equal(saves, 1);
    const resultReview = await host.prepare({
      action: "prepare-result",
      operationId,
      decisionId: command.id,
      expectedRevision: host.status(operationId).revision,
    });
    await host.confirm({
      reviewId: resultReview.id,
      confirmed: true,
      acknowledged: true,
    });
    const resultMessage = decisions
      .status(operationId)[0]!
      .resultDeliveries.find((d) => d.status === "saved")!.messageId;
    await assert.rejects(
      decisions.sendResult(
        { ...resultInput, messageId: uncertainMessage },
        async () => {
          assert.fail("Do not send a superseded uncertain result");
        },
      ),
    );
    let sentResult: any;
    await assert.rejects(
      decisions.sendResult(
        { ...resultInput, messageId: resultMessage },
        async (value, check) => {
          check();
          sentResult = structuredClone(value);
          throw Error("Synthetic lost result upload response");
        },
      ),
    );
    const receivedResult = await openPrivateEnvelope(
      sentResult,
      sentResult.header,
      {
        recipientKey: peer.sender,
        senderPublicKey: (await peer.keys.resolve()).pair.publicKey,
      },
      peer.clock,
    );
    assert.deepEqual(
      JSON.parse(new TextDecoder().decode(receivedResult.plaintext)).receipt,
      receipt,
    );
    receivedResult.plaintext.fill(0);
    const sendResultReview = await host.prepare(
      {
        action: "send-result",
        operationId,
        decisionId: command.id,
        messageId: resultMessage,
        expectedRevision: host.status(operationId).revision,
        connection: { id: randomUUID(), expectedRevision: 1 },
      },
      relay,
    );
    await host.confirm(
      { reviewId: sendResultReview.id, confirmed: true, acknowledged: true },
      relay,
    );
    assert.deepEqual(lastUpload, sentResult);
    assert.equal(
      decisions
        .status(operationId)[0]!
        .resultDeliveries.find((d) => d.messageId === resultMessage)!.attempts,
      2,
    );
    assert.equal(saves, 1);
    const stop = await host.prepare({
      action: "stop",
      operationId,
      expectedRevision: host.status(operationId).revision,
      offerId: ready.offers[0]!.id,
    });
    const stopped = await host.confirm({
      reviewId: stop.id,
      confirmed: true,
      acknowledged: true,
    });
    assert.equal(stopped.offers[0]!.state, "stopped");
  } finally {
    peer.close();
  }
});
