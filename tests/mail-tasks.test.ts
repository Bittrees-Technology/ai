import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { MailConnector } from "../modules/connectors/mail.js";
import { MailTasks } from "../modules/connectors/mail-tasks.js";
import {
  SourceTasks,
  sourceResult,
} from "../modules/connectors/source-tasks.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { LocalWorker } from "../apps/companion/worker.js";
import { sourceBindingSchema } from "../modules/contracts/index.js";
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
  conversationId: "mail",
  kind: "draft" as const,
  prompt: "Summarize and suggest a reply",
  modelProfileId: "p",
  dependencies: [],
  priority: "normal" as const,
  tags: [],
};
const draft = {
  summary: [{ text: "Please review the plan", evidence: ["body-1"] }],
  reply: { text: "I will review the plan.", evidence: ["body-1"] },
};
async function fixture() {
  let secret: Uint8Array | undefined,
    denied = false;
  const grant = {
    token: "f".repeat(64),
    grantId: "a".repeat(64),
    mailbox: "fixture@bittrees.org",
    wallet: "0x" + "1".repeat(40),
    selection: {
      id: "b".repeat(64),
      folder: "INBOX",
      metadataVersion: "c".repeat(64),
      plainVersion: "d".repeat(64),
    },
    scopes: ["metadata", "plain"],
    expiresAt: new Date(Date.now() + 1800000).toISOString(),
    policyRevision: "mail-ai-selected-v1",
  };
  const content = {
    text: "PRIVATE_BODY: Please review the plan.",
    bodyAvailable: true,
    bodyTruncated: false,
  };
  const calls: string[] = [];
  const connector = new MailConnector(
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
    async (url, init) => {
      calls.push(String(url));
      if (String(url).endsWith("/exchange")) return Response.json(grant);
      if (denied) return new Response("", { status: 403 });
      const mode = JSON.parse(String(init?.body)).content;
      const result = {
        grantId: grant.grantId,
        mailbox: grant.mailbox,
        wallet: grant.wallet,
        folder: grant.selection.folder,
        scopes: grant.scopes,
        expiresAt: grant.expiresAt,
        policyRevision: grant.policyRevision,
        message: {
          id: grant.selection.id,
          mode,
          from: "fixture@example.org",
          subject: "Review request",
          date: "2026-09-22",
          truncatedMetadata: [],
          sourceVersion:
            mode === "plain"
              ? grant.selection.plainVersion
              : grant.selection.metadataVersion,
          attachmentsIncluded: false,
          ...(mode === "plain" ? content : {}),
        },
      };
      return Response.json({
        ...result,
        projectionHash: createHash("sha256")
          .update(JSON.stringify(result))
          .digest("hex"),
      });
    },
  );
  const start = await connector.begin();
  await connector.finish(start.id, "a".repeat(64));
  const adapter = new MailTasks(connector, owner, "device");
  return {
    connector,
    adapter,
    sources: new SourceTasks(undefined, undefined, adapter),
    grant,
    content,
    calls,
    deny: () => {
      denied = true;
    },
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
test("Mail tasks bind one source selection without storing body or credential in input", async () => {
  const f = await fixture(),
    store = new Store(":memory:", new Vault(randomBytes(32)));
  try {
    const task = await f.adapter.create(store, input, "plain", "one"),
      b = store.sourceBinding(owner, task.id)!;
    assert.equal(
      (await f.adapter.create(store, input, "plain", "one")).id,
      task.id,
    );
    assert.equal(b.authority.sourceApp, "mail");
    assert.equal(b.authority.subjectId, f.grant.wallet);
    assert.equal(
      b.authority.tenantId,
      createHash("sha256")
        .update("mailbox:" + f.grant.mailbox)
        .digest("hex"),
    );
    assert.equal(JSON.stringify(task).includes("PRIVATE_BODY"), false);
    assert.equal(JSON.stringify(task).includes(f.grant.token), false);
    assert.throws(
      () => store.create(owner, { ...input, sourceRefs: b.refs }, "forged"),
      /INVALID_INPUT/,
    );
    assert.throws(
      () =>
        store.create(
          owner,
          { ...input, sourceRefs: b.refs, memoryIds: ["external"] },
          "memory",
          b,
        ),
      /INVALID_INPUT/,
    );
    for (const bad of [
      { ...b, refs: [...b.refs, ...b.refs] },
      { ...b, refs: [{ ...b.refs[0]!, app: "crm" }] },
      { ...b, refs: [{ ...b.refs[0]!, tenantId: "other" }] },
    ])
      assert.equal(sourceBindingSchema.safeParse(bad).success, false);
    for (const authority of [
      { ...b.authority, deviceId: "other" },
      { ...b.authority, userId: "other" },
      { ...b.authority, subjectId: "other" },
      { ...b.authority, grantId: "other" },
    ])
      await assert.rejects(
        f.adapter.validate({ ...b, authority }),
        /SOURCE_DENIED/,
      );
    for (const bad of [
      { ...b, projectionHash: "0".repeat(64) },
      { ...b, expiresAt: new Date(0).toISOString() },
      {
        ...b,
        refs: [{ ...b.refs[0]!, revision: "metadata:" + "d".repeat(64) }],
      },
    ])
      await assert.rejects(f.adapter.validate(bad), /SOURCE_DENIED/);
    await assert.rejects(new SourceTasks().validate(b), /SOURCE_DENIED/);
  } finally {
    store.close();
  }
});
test("Mail metadata can summarize but cannot produce a reply or request unavailable body", async () => {
  const f = await fixture(),
    store = new Store(":memory:", new Vault(randomBytes(32)));
  try {
    await assert.rejects(
      f.adapter.create(store, input, "metadata", "reply"),
      /SOURCE_DENIED/,
    );
    await assert.rejects(
      f.adapter.create(store, { ...input, kind: "query" }, "plain", "query"),
      /SOURCE_DENIED/,
    );
    f.content.bodyAvailable = false;
    f.content.text = "";
    await assert.rejects(
      f.adapter.create(store, input, "plain", "empty"),
      /SOURCE_DENIED/,
    );
    const task = await f.adapter.create(
      store,
      { ...input, kind: "summarize" },
      "metadata",
      "summary",
    );
    await worker(store, f, async (_p, prompt) => {
      assert.equal(prompt.includes("PRIVATE_BODY"), false);
      assert.match(prompt, /Metadata-only/);
      return JSON.stringify({
        summary: [{ text: "Review request", evidence: ["subject"] }],
        reply: null,
      });
    }).runOnce();
    assert.equal(store.get(owner, task.id).status, "completed");
    const snapshot = await f.adapter.validate(
      store.sourceBinding(owner, task.id)!,
    );
    assert.throws(
      () => sourceResult(snapshot, JSON.stringify(draft), "draft"),
      /INVALID_SOURCE/,
    );
  } finally {
    store.close();
  }
});
test("Mail worker saves only unreviewed local drafts with trusted source citations and truncation notice", async () => {
  const f = await fixture(),
    store = new Store(":memory:", new Vault(randomBytes(32)));
  f.content.bodyTruncated = true;
  try {
    const task = await f.adapter.create(store, input, "plain", "draft");
    await worker(store, f, async (_p, prompt) => {
      assert.equal(store.db.inTransaction, false);
      assert.match(prompt, /untrusted data/);
      assert.match(prompt, /PRIVATE_BODY/);
      assert.equal(prompt.includes(f.grant.token), false);
      return JSON.stringify(draft);
    }).runOnce();
    const saved = store.get(owner, task.id),
      result = saved.result as any;
    assert.equal(saved.status, "completed");
    assert.equal(result.kind, "unreviewed_draft");
    assert.equal(result.mail.sent, false);
    assert.equal(result.mail.savedToMail, false);
    assert.equal(result.mail.status, "unreviewed");
    assert.match(result.text, /truncated/);
    assert.deepEqual(result.mail.reply.citations, [
      {
        messageId: f.grant.selection.id,
        version: f.grant.selection.plainVersion,
        sectionId: "body-1",
      },
    ]);
    assert.ok(
      f.calls.every((u) => u.endsWith("/exchange") || u.endsWith("/read")),
    );
  } finally {
    store.close();
  }
});
test("Mail malformed output and fabricated evidence cannot become a saved result", async () => {
  for (const output of [
    "prose",
    JSON.stringify({ ...draft, sent: true }),
    JSON.stringify({ ...draft, to: "recipient@example.org" }),
    JSON.stringify({ ...draft, tools: ["send"] }),
    JSON.stringify({ ...draft, reply: null }),
    JSON.stringify({
      ...draft,
      summary: [{ text: "x", evidence: ["missing"] }],
    }),
    JSON.stringify({ ...draft, reply: { text: "x", evidence: [] } }),
    JSON.stringify({
      ...draft,
      reply: { text: "x", evidence: ["body-1", "body-1"] },
    }),
  ]) {
    const f = await fixture(),
      store = new Store(":memory:", new Vault(randomBytes(32)));
    try {
      const task = await f.adapter.create(store, input, "plain", "invalid");
      await worker(store, f, async () => output).runOnce();
      assert.equal(store.get(owner, task.id).status, "failed");
      assert.equal(store.get(owner, task.id).result, null);
    } finally {
      store.close();
    }
  }
});
test("Mail source denial, content change and disconnect fence results before and after inference", async () => {
  for (const change of [
    "before",
    "version",
    "projection",
    "identity",
    "denied",
    "disconnect",
  ]) {
    const f = await fixture(),
      store = new Store(":memory:", new Vault(randomBytes(32)));
    let generated = false;
    try {
      const task = await f.adapter.create(store, input, "plain", change);
      if (change === "before") f.deny();
      await worker(store, f, async () => {
        generated = true;
        if (change === "version")
          f.grant.selection.plainVersion = "e".repeat(64);
        if (change === "projection") f.content.text = "changed";
        if (change === "identity") f.grant.wallet = "0x" + "2".repeat(40);
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

test("Mail bindings cannot enter CRM publication or AutoNote review adapters", async () => {
  const { CrmConnector } = await import("../modules/connectors/crm.js");
  const { CrmTasks } = await import("../modules/connectors/crm-tasks.js");
  const { CrmPublications } =
    await import("../modules/connectors/crm-publications.js");
  const { AutoNoteConnector } =
    await import("../modules/connectors/autonote.js");
  const { AutoNoteTasks } =
    await import("../modules/connectors/autonote-tasks.js");
  const { AutoNoteReviews } =
    await import("../modules/connectors/autonote-reviews.js");
  const { randomUUID } = await import("node:crypto");
  let calls = 0;
  const secret = {
    getSecret: async () => {
      calls++;
      return undefined;
    },
    setSecret: async () => {},
    deleteCredential: async () => true,
  };
  const crm = new CrmConnector("owner", secret),
    autonote = new AutoNoteConnector("owner", secret);
  const crmTasks = new CrmTasks(crm, owner, "device"),
    autoTasks = new AutoNoteTasks(autonote, owner, "device");
  const f = await fixture(),
    store = new Store(":memory:", new Vault(randomBytes(32)));
  try {
    const task = await f.adapter.create(store, input, "plain", "isolation");
    await worker(store, f, async () => JSON.stringify(draft)).runOnce();
    const binding = store.sourceBinding(owner, task.id)!;
    await assert.rejects(crmTasks.validate(binding), /SOURCE_DENIED/);
    await assert.rejects(autoTasks.validate(binding), /SOURCE_DENIED/);
    await assert.rejects(
      new CrmPublications(store, owner, crm, crmTasks).permission(task.id),
      /SOURCE_DENIED/,
    );
    await assert.rejects(
      new AutoNoteReviews(store, owner, autonote, autoTasks).reserve(task.id, {
        operationId: randomUUID(),
      }),
      /SOURCE_DENIED/,
    );
    assert.equal(calls, 0);
  } finally {
    store.close();
  }
});
