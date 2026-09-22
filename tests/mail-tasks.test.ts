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
async function fixture(attachment = false) {
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
      ...(attachment
        ? { attachment: { id: "1.2", version: "d".repeat(64) } }
        : {}),
    },
    scopes: ["metadata", "plain", ...(attachment ? ["attachment"] : [])],
    expiresAt: new Date(Date.now() + 1800000).toISOString(),
    policyRevision: attachment ? "mail-ai-selected-v2" : "mail-ai-selected-v1",
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
            mode === "plain" || mode === "attachment-text"
              ? grant.selection.plainVersion
              : grant.selection.metadataVersion,
          attachmentsIncluded: mode === "attachment-text",
          ...(mode === "attachment-text"
            ? {
                attachment: {
                  id: grant.selection.attachment!.id,
                  filename: "plan.txt",
                  contentType: "text/plain",
                  encodedBytes: 12,
                  supported: true,
                  text: "FILE_CONTENT",
                  bytes: 12,
                  truncated: false,
                },
              }
            : {}),
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
      /INVALID_OUTPUT/,
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
      assert.equal(
        store.runHistory(owner, task.id)[0]!.outcome,
        "invalid_model_output",
      );
      assert.equal(await worker(store, f, async () => output).runOnce(), false);
      assert.equal(store.runHistory(owner, task.id).length, 1);
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
      assert.equal(
        store.runHistory(owner, task.id)[0]!.outcome,
        "failed",
        change,
      );
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

test("Mail authenticated HTTP controls guard selection, task creation, exports and local removal", async () => {
  const { createServer } = await import("node:http"),
    { localApi } = await import("../apps/companion/http.js"),
    { randomUUID } = await import("node:crypto");
  const f = await fixture(true),
    store = new Store(":memory:", new Vault(randomBytes(32))),
    server = createServer();
  store.addProfile(owner, profile);
  await f.connector.forgetLocal();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port,
    token = "local-credential".repeat(4),
    stopped: unknown[] = [];
  server.on(
    "request",
    localApi({
      store,
      owner,
      port,
      token,
      mail: f.connector,
      mailSources: f.adapter,
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
  const base = "/v1/connections/mail";
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
    assert.equal(new URL(start.consentUrl).origin, "https://mail.bittrees.org");
    assert.equal(
      (
        await call(base + "/finish", "POST", {
          id: start.id,
          code: "a".repeat(64),
          wallet: f.grant.wallet,
        })
      ).status,
      400,
    );
    const finish = await call(base + "/finish", "POST", {
      id: start.id,
      code: "a".repeat(64),
    });
    assert.equal(finish.status, 200);
    assert.equal((await finish.text()).includes(f.grant.token), false);
    assert.equal(
      (await call(base + "/selection", "POST", { content: "plain" })).status,
      400,
    );
    const selection = await call(base + "/selection", "POST", {}),
      text = await selection.text();
    assert.equal(selection.status, 200);
    assert.equal(selection.headers.get("cache-control"), "no-store");
    assert.equal(text.includes("PRIVATE_BODY"), false);
    assert.equal(text.includes(f.grant.token), false);
    const body = {
        conversationId: randomUUID(),
        kind: "draft",
        content: "plain",
        prompt: input.prompt,
        modelProfileId: "p",
      },
      headers = { "Idempotency-Key": "http" };
    for (const extra of [
      { sourceRefs: [] },
      { wallet: f.grant.wallet },
      { messageId: "b".repeat(64) },
      { memoryIds: [] },
      { send: true },
    ])
      assert.equal(
        (await call(base + "/drafts", "POST", { ...body, ...extra }, headers))
          .status,
        400,
      );
    assert.equal(
      (
        await call(
          base + "/drafts",
          "POST",
          { ...body, content: "metadata" },
          headers,
        )
      ).status,
      400,
    );
    const created = await call(base + "/drafts", "POST", body, headers);
    assert.equal(created.status, 202);
    const task = (await created.json()) as any;
    assert.equal(task.sourceApp, "mail");
    assert.deepEqual(task.input.sourceRefs, []);
    assert.equal(
      (
        (await (
          await call(base + "/drafts", "POST", body, headers)
        ).json()) as any
      ).id,
      task.id,
    );
    await worker(store, f, async () => JSON.stringify(draft)).runOnce();
    for (const path of ["/v1/export", "/v1/requests"])
      assert.equal(
        (await (await call(path)).text()).includes("Please review the plan"),
        false,
      );
    const prefix = "/v1/requests/" + task.id;
    const exported = (await (await call(prefix + "/export")).json()) as any;
    assert.equal(exported.task.result.mail.sent, false);
    assert.equal(exported.task.result.mail.messageId, f.grant.selection.id);
    const rejectedResponse = await call(
      base + "/drafts",
      "POST",
      {
        ...body,
        conversationId: randomUUID(),
      },
      { "Idempotency-Key": "rejected-output" },
    );
    assert.equal(rejectedResponse.status, 202);
    const rejected = (await rejectedResponse.json()) as any;
    await worker(
      store,
      f,
      async () => "REJECTED_PRIVATE_MODEL_OUTPUT",
    ).runOnce();
    const rejectedRunsPath = "/v1/requests/" + rejected.id + "/runs";
    const history = (await (await call(rejectedRunsPath)).json()) as any;
    assert.equal(history.items[0].outcome, "invalid_model_output");
    assert.equal(
      JSON.stringify(history).includes("REJECTED_PRIVATE_MODEL_OUTPUT"),
      false,
    );
    const attachmentBody = {
      ...body,
      kind: "summarize",
      content: "attachment-text",
      conversationId: randomUUID(),
    };
    assert.equal(
      (
        await call(
          base + "/drafts",
          "POST",
          { ...attachmentBody, attachmentId: "1.3" },
          { "Idempotency-Key": "bad-file" },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await call(
          base + "/drafts",
          "POST",
          { ...attachmentBody, kind: "draft" },
          { "Idempotency-Key": "file-reply" },
        )
      ).status,
      400,
    );
    const fileResponse = await call(base + "/drafts", "POST", attachmentBody, {
      "Idempotency-Key": "file-summary",
    });
    assert.equal(fileResponse.status, 202);
    const fileTask = (await fileResponse.json()) as any;
    await worker(store, f, async () =>
      JSON.stringify({
        summary: [{ text: "File summary", evidence: ["attachment-1"] }],
        reply: null,
      }),
    ).runOnce();
    const fileExport = "/v1/requests/" + fileTask.id + "/export";
    const fileResult = (await (await call(fileExport)).json()) as any;
    assert.equal(fileResult.task.result.mail.attachment.id, "1.2");
    f.deny();
    assert.equal((await call(fileExport)).status, 400);
    assert.deepEqual(
      ((await (await call(rejectedRunsPath)).json()) as any).items,
      [],
    );
    assert.equal((await call(prefix + "/export")).status, 400);
    const hidden = (await (await call(prefix)).json()) as any;
    assert.equal(hidden.result, null);
    assert.deepEqual(hidden.input.sourceRefs, []);
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
          "X-Confirm-Delete": "local-mail-credential",
        })
      ).status,
      204,
    );
    assert.deepEqual(stopped, ["mail"]);
    assert.equal(await f.connector.status(), null);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});

test("Mail cancellation aborts its active inference without cancelling for another app", async () => {
  const f = await fixture(),
    store = new Store(":memory:", new Vault(randomBytes(32)));
  let started!: () => void,
    release!: () => void,
    aborted = false;
  const beginning = new Promise<void>((r) => {
      started = r;
    }),
    hold = new Promise<void>((r) => {
      release = r;
    });
  try {
    const task = await f.adapter.create(store, input, "plain", "cancel");
    const runner = new LocalWorker(
      store,
      owner,
      {
        pin: async () => ({ profile, digest: "c".repeat(64) }),
        generate: async (_p, _prompt, signal) => {
          signal!.addEventListener(
            "abort",
            () => {
              aborted = true;
              release();
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
    const work = runner.runOnce();
    await beginning;
    runner.cancelSource("autonote");
    assert.equal(aborted, false);
    runner.cancelSource("mail");
    await work;
    assert.equal(aborted, true);
    assert.equal(store.get(owner, task.id).result, null);
    assert.equal(store.get(owner, task.id).status, "failed");
  } finally {
    release?.();
    store.close();
  }
});

test("Selected attachment summary includes only file content and exact file citations", async () => {
  const f = await fixture(true),
    store = new Store(":memory:", new Vault(randomBytes(32)));
  try {
    await assert.rejects(
      f.adapter.create(store, input, "attachment-text", "reply"),
      /SOURCE_DENIED/,
    );
    const task = await f.adapter.create(
      store,
      { ...input, kind: "summarize" },
      "attachment-text",
      "file",
    );
    assert.ok(!JSON.stringify(task).includes("FILE_CONTENT"));
    const b = store.sourceBinding(owner, task.id)!;
    assert.equal(
      b.refs[0]!.revision,
      "attachment-text:" + f.grant.selection.plainVersion + ":1_2",
    );
    await assert.rejects(
      f.adapter.validate({
        ...b,
        refs: [
          {
            ...b.refs[0]!,
            revision: b.refs[0]!.revision.replace(":1_2", ":1_3"),
          },
        ],
      }),
      /SOURCE_DENIED/,
    );
    await worker(store, f, async (_p, prompt) => {
      assert.match(prompt, /FILE_CONTENT/);
      assert.ok(!prompt.includes("PRIVATE_BODY"));
      return JSON.stringify({
        summary: [{ text: "File summary", evidence: ["attachment-1"] }],
        reply: null,
      });
    }).runOnce();
    const result = store.get(owner, task.id).result as any;
    assert.equal(result.mail.mode, "attachment-text");
    assert.equal(result.mail.attachment.id, "1.2");
    assert.deepEqual(result.mail.summary[0].citations, [
      {
        messageId: f.grant.selection.id,
        version: f.grant.selection.plainVersion,
        sectionId: "attachment-1",
        attachmentId: "1.2",
      },
    ]);
    assert.equal(result.mail.reply, null);
    assert.equal(result.mail.sent, false);
    const snapshot = await f.adapter.validate(b);
    assert.throws(
      () =>
        sourceResult(
          snapshot,
          JSON.stringify({
            summary: [{ text: "Invented body", evidence: ["body-1"] }],
            reply: null,
          }),
          "summarize",
        ),
      /INVALID_OUTPUT/,
    );
    f.deny();
    await assert.rejects(f.adapter.validate(b), /SOURCE_DENIED/);
  } finally {
    store.close();
  }
});
test("Attachment content cannot be saved after permission loss during generation", async () => {
  const f = await fixture(true),
    store = new Store(":memory:", new Vault(randomBytes(32)));
  try {
    const task = await f.adapter.create(
      store,
      { ...input, kind: "summarize" },
      "attachment-text",
      "late",
    );
    await worker(store, f, async () => {
      f.deny();
      return JSON.stringify({
        summary: [{ text: "File summary", evidence: ["attachment-1"] }],
        reply: null,
      });
    }).runOnce();
    assert.equal(store.get(owner, task.id).status, "failed");
    assert.equal(store.get(owner, task.id).result, null);
  } finally {
    store.close();
  }
});
