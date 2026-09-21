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
async function fixture() {
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
    async (url) =>
      String(url).endsWith("/exchange")
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
