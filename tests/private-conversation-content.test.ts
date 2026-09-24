import { conversationTaskAccess } from "../apps/companion/conversation-access.js";
import { SourceTasks } from "../modules/connectors/source-tasks.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { conversationFixture, owner } from "./helpers/conversation-fixture.js";
import { PrivateConversationContent } from "../modules/remote/private-conversation-content.js";
import {
  privateEnvelopeSuite,
  sealPrivateEnvelope,
  openPrivateEnvelope,
} from "../modules/remote/private-envelope.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
import { join } from "node:path";

async function fixture(questions = false, hostAccess = false) {
  const f = await conversationFixture();
  const { grant } = f.approve(
    await f.prepare({
      permissions: {
        ...f.choices.permissions,
        questionsToBrowser: questions,
        answersToMac: questions,
      },
    }),
  );
  let allowed = true;
  const hostGuard = conversationTaskAccess(
    f.store,
    owner,
    new SourceTasks(),
    undefined,
    f.clock,
  );
  const access = async (id: string) => {
    const guard = hostAccess ? await hostGuard(id) : () => {};
    return () => {
      if (!allowed) throw Error("SOURCE_DENIED");
      guard();
    };
  };
  const content = new PrivateConversationContent(
    f.store,
    f.vault,
    owner,
    f.consent,
    f.keys,
    access,
    f.clock,
  );
  const scope = {
    conversationRef: grant.conversationRef,
    permissionId: grant.id,
  };
  let sequence = 100;
  const envelope = async (body: unknown, override = {}) =>
    sealPrivateEnvelope(
      {
        version: 1,
        suite: privateEnvelopeSuite,
        ownerId: f.binding.ownerId,
        senderId: f.peerId,
        recipientId: f.binding.deviceId,
        senderKeyEpoch: 1,
        recipientKeyEpoch: grant.local.keyEpoch,
        messageId: randomUUID(),
        operationId: (body as { id: string }).id,
        sequence: sequence++,
        issuedAt: f.clock(),
        expiresAt: f.clock() + 60000,
        ...override,
      },
      new TextEncoder().encode(JSON.stringify(body)),
      {
        senderKey: f.sender,
        recipientPublicKey: (await f.keys.resolve()).pair.publicKey,
      },
      f.clock,
    );
  const message = (parentId: string | null = null) => ({
    version: 1,
    type: "conversation.message" as const,
    scope,
    id: randomUUID(),
    parentId,
    content: "SYNTHETIC_REMOTE_CONTENT",
  });
  const accept = (e: Awaited<ReturnType<typeof envelope>>) =>
    content.accept({ permissionId: grant.id, envelope: e, confirmed: true });
  const prepare = (
    localMessageId = f.message.id,
    kind: "message" | "question" = "message",
    parentId: string | null = null,
  ) =>
    content.prepare({
      id: randomUUID(),
      permissionId: grant.id,
      expectedConsentRevision: f.consent.list().revision,
      localMessageId,
      kind,
      parentId,
      expiresAt: f.clock() + 60000,
      confirmed: true,
    });
  const seal = (e: Awaited<ReturnType<typeof prepare>>) =>
    content.seal({
      permissionId: grant.id,
      id: e.value.content.id,
      expectedRevision: e.revision,
      confirmed: true,
    });
  return {
    ...f,
    localMessage: f.message,
    grant,
    scope,
    content,
    envelope,
    message,
    accept,
    prepareContent: prepare,
    sealContent: seal,
    access,
    deny: () => {
      allowed = false;
    },
  };
}
function counts(f: Awaited<ReturnType<typeof fixture>>) {
  return Object.fromEntries(
    [
      "messages",
      "private_conversation_content",
      "private_incoming_replay",
      "private_send_channels",
      "events",
    ].map((t) => [
      t,
      (
        f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as {
          n: number;
        }
      ).n,
    ]),
  );
}
function waiting(f: Awaited<ReturnType<typeof fixture>>) {
  f.store.addProfile(owner, {
    id: "synthetic",
    runtime: "ollama",
    model: "synthetic",
    contextTokens: 4096,
    maxOutputTokens: 256,
    temperature: 0,
  });
  const task = f.store.create(
    owner,
    {
      conversationId: f.choices.conversationId,
      kind: "query",
      prompt: "Synthetic task",
      modelProfileId: "synthetic",
    },
    randomUUID(),
  );
  const claim = f.store.claim(owner, "worker")!;
  const q = f.store.waitForInput(
    owner,
    task.id,
    "worker",
    claim.generation,
    {
      inboxId: f.inbox.id,
      question: "Which synthetic scope?",
      replyDueAt: new Date(f.clock() + 120000).toISOString(),
    },
    randomUUID(),
  );
  return q;
}
test("actual Inbox roots/replies survive reopen; concurrent retries retain one outcome and original receipt ciphertext", async () => {
  const f = await fixture();
  try {
    const body = f.message(),
      env = await f.envelope(body);
    const [a, b] = await Promise.all([f.accept(env), f.accept(env)]);
    assert.deepEqual([a.duplicate, b.duplicate].sort(), [false, true]);
    assert.equal(a.entry.value.localMessageId, b.entry.value.localMessageId);
    const receipt = await f.sealContent(a.entry);
    const current = f.store.exportPrivateConversationContent(owner)[0]!;
    assert.deepEqual(await f.sealContent(current), receipt);
    const opened = await openPrivateEnvelope(
      receipt,
      receipt.header,
      {
        recipientKey: f.sender,
        senderPublicKey: (await f.keys.resolve()).pair.publicKey,
      },
      f.clock,
    );
    assert.equal(
      JSON.parse(new TextDecoder().decode(opened.plaintext)).acceptedId,
      body.id,
    );
    opened.plaintext.fill(0);
    const reply = await f.accept(await f.envelope(f.message(body.id)));
    assert.equal(
      f.store.message(owner, reply.entry.value.localMessageId).input.replyToId,
      a.entry.value.localMessageId,
    );
    const reopened = new Store(f.path, f.vault, f.clock);
    try {
      const built = f.build(reopened),
        c = new PrivateConversationContent(
          reopened,
          f.vault,
          owner,
          built.consent,
          built.keys,
          f.access,
          f.clock,
        );
      assert.equal(
        (
          await c.accept({
            permissionId: f.grant.id,
            envelope: env,
            confirmed: true,
          })
        ).duplicate,
        true,
      );
      assert.equal(reopened.exportPrivateConversationContent(owner).length, 2);
    } finally {
      reopened.close();
    }
    assert.equal(
      f.store.messages(owner, f.inbox.id, f.choices.conversationId).length,
      3,
    );
  } finally {
    f.close();
  }
});
test("out-of-order parents stay pending with no Inbox/replay effect and same original child succeeds after its parent", async () => {
  const f = await fixture();
  try {
    const parent = f.message(),
      child = f.message(parent.id),
      env = await f.envelope(child),
      before = counts(f);
    await assert.rejects(f.accept(env), /PARENT_PENDING/);
    assert.deepEqual(counts(f), before);
    await f.accept(await f.envelope(parent));
    await f.accept(env);
    assert.equal(f.store.exportPrivateConversationContent(owner).length, 2);
  } finally {
    f.close();
  }
});
test("outgoing content binds an existing local message, preserves exact ciphertext and admits a reply through its wire mapping", async () => {
  const f = await fixture();
  try {
    const e = await f.prepareContent(),
      sealed = await f.sealContent(e);
    assert.equal(sealed.header.operationId, e.value.content.id);
    assert.deepEqual(
      await f.sealContent(f.store.exportPrivateConversationContent(owner)[0]!),
      sealed,
    );
    const reply = await f.accept(
      await f.envelope(f.message(e.value.content.id)),
    );
    assert.equal(
      f.store.message(owner, reply.entry.value.localMessageId).input.replyToId,
      f.localMessage.id,
    );
    const collide = { ...f.message(), id: e.value.content.id };
    await assert.rejects(f.accept(await f.envelope(collide)), /CONFLICT/);
  } finally {
    f.close();
  }
});
test("authenticated changed ciphertext, cross-family sequence reuse and deleted originals cannot create replacement outcomes", async () => {
  const f = await fixture();
  try {
    const body = f.message(),
      env = await f.envelope(body),
      accepted = await f.accept(env),
      before = counts(f);
    await assert.rejects(
      f.accept(await f.envelope({ ...body, content: "CHANGED" })),
      /CONFLICT/,
    );
    assert.deepEqual(counts(f), before);
    const { privateReplayIdentity } =
      await import("../modules/remote/private-replay.js");
    const { consumePrivateIncomingReplay } =
      await import("../modules/remote/private-incoming-replay.js");
    const other = await f.envelope(f.message()),
      identity = await privateReplayIdentity(other, "peer.key.response");
    f.store.db
      .transaction(() =>
        consumePrivateIncomingReplay(f.store, f.vault, owner, identity, {
          collection: "private_peer_checks",
          id: randomUUID(),
        }),
      )
      .immediate();
    const collisions = counts(f);
    await assert.rejects(f.accept(other), /CONFLICT/);
    assert.deepEqual(counts(f), collisions);
    f.store.db
      .prepare("DELETE FROM messages WHERE id=?")
      .run(accepted.entry.value.localMessageId);
    const missing = counts(f);
    await assert.rejects(f.accept(env));
    assert.deepEqual(counts(f), missing);
  } finally {
    f.close();
  }
});
test("host access permits exact shared question answers and preserves ordinary reply linkage", async () => {
  const f = await fixture(true, true);
  try {
    const q = waiting(f),
      shared = await f.prepareContent(q.question.id, "question");
    await f.sealContent(shared);
    const ordinary = await f.accept(
      await f.envelope(f.message(shared.value.content.id)),
    );
    const local = f.store.message(owner, ordinary.entry.value.localMessageId);
    assert.equal(local.input.requestId, q.task.id);
    assert.equal(f.store.get(owner, q.task.id).status, "awaiting_input");
    const answer = {
      version: 1,
      type: "conversation.answer",
      scope: f.scope,
      id: randomUUID(),
      taskId: q.task.id,
      questionId: shared.value.content.id,
      expectedRevision: q.task.revision,
      content: "Only the synthetic scope",
      confirmed: true,
    };
    await assert.rejects(
      f.accept(await f.envelope({ ...answer, questionId: q.question.id })),
      /PARENT_PENDING/,
    );
    const env = await f.envelope(answer),
      a = await f.accept(env);
    assert.equal(f.store.get(owner, q.task.id).status, "queued");
    assert.equal(
      f.store.inputWaitHistory(owner, q.task.id)[0]!.replyId,
      a.entry.value.localMessageId,
    );
    const before = counts(f);
    assert.equal((await f.accept(env)).duplicate, true);
    assert.deepEqual(counts(f), before);
    f.deny();
    await assert.rejects(f.accept(env), /SOURCE_DENIED/);
  } finally {
    f.close();
  }
});
test("permission invalidation during vault write rolls back Inbox, reply, event, sequence, journal and replay effects", async () => {
  const f = await fixture(true);
  try {
    const q = waiting(f),
      shared = await f.prepareContent(q.question.id, "question");
    await f.sealContent(shared);
    const env = await f.envelope({
      version: 1,
      type: "conversation.answer",
      scope: f.scope,
      id: randomUUID(),
      taskId: q.task.id,
      questionId: shared.value.content.id,
      expectedRevision: q.task.revision,
      content: "Synthetic answer",
      confirmed: true,
    });
    const before = counts(f),
      original = f.vault.seal.bind(f.vault);
    f.vault.seal = ((...args: Parameters<Vault["seal"]>) => {
      const result = original(...args);
      if (args[1].includes("private-conversation-content:v1"))
        f.setBinding(null);
      return result;
    }) as Vault["seal"];
    await assert.rejects(f.accept(env));
    assert.deepEqual(counts(f), before);
    assert.equal(f.store.get(owner, q.task.id).status, "awaiting_input");
    assert.equal(f.store.inputWaitHistory(owner, q.task.id)[0]!.replyId, null);
  } finally {
    f.close();
  }
});
test("journal write failure and capacity failure roll back ordinary Inbox effects", async () => {
  const f = await fixture();
  try {
    const env = await f.envelope(f.message()),
      before = counts(f);
    f.store.db.exec(
      "CREATE TRIGGER fail_content BEFORE INSERT ON private_conversation_content BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
    );
    await assert.rejects(f.accept(env), /synthetic failure/);
    assert.deepEqual(counts(f), before);
    f.store.db.exec("DROP TRIGGER fail_content");
    for (let i = 0; i < 128; i++)
      f.store.db
        .prepare("INSERT INTO private_conversation_content VALUES(?,?,?,?,?,?)")
        .run(
          owner.userId,
          owner.tenantId,
          `occupied-${i}`,
          1,
          0,
          Buffer.from("synthetic"),
        );
    const full = counts(f);
    await assert.rejects(f.accept(env), /CAPACITY/);
    assert.deepEqual(counts(f), full);
  } finally {
    f.close();
  }
});
test("backup locks journal authority, export stays owner-scoped and owner deletion removes journal with Inbox effects", async () => {
  const f = await fixture();
  try {
    await f.accept(await f.envelope(f.message()));
    assert.deepEqual(
      f.store.exportPrivateConversationContent({ ...owner, userId: "other" }),
      [],
    );
    const backup = join(f.dir, "content.enc"),
      restored = join(f.dir, "restored.db");
    await encryptedBackup(f.store, f.vault, backup);
    await restoreBackup(backup, f.vault, restored);
    const s = new Store(restored, f.vault, f.clock);
    try {
      assert.equal(s.exportPrivateConversationContent(owner)[0]!.locked, true);
      assert.equal(
        s.exportPrivateConversationContent(owner)[0]!.value.content.content,
        "SYNTHETIC_REMOTE_CONTENT",
      );
    } finally {
      s.close();
    }
    f.store.deleteAll(owner);
    assert.deepEqual(f.store.exportPrivateConversationContent(owner), []);
  } finally {
    f.close();
  }
});

test("host access permits newly shared paused questions without unpausing work", async () => {
  const f = await fixture(true, true);
  try {
    const q = waiting(f),
      first = await f.prepareContent(q.question.id, "question");
    await f.sealContent(first);
    const paused = f.store.command(owner, q.task.id, {
      command: "pause",
      expectedRevision: q.task.revision,
    });
    const answer = (wireId: string, revision: number) => ({
      version: 1,
      type: "conversation.answer",
      scope: f.scope,
      id: randomUUID(),
      taskId: q.task.id,
      questionId: wireId,
      expectedRevision: revision,
      content: "Synthetic paused answer",
      confirmed: true,
    });
    const before = counts(f);
    await assert.rejects(
      f.accept(
        await f.envelope(answer(first.value.content.id, q.task.revision)),
      ),
      /CONFLICT/,
    );
    assert.deepEqual(counts(f), before);
    const second = await f.prepareContent(q.question.id, "question");
    await f.sealContent(second);
    await f.accept(
      await f.envelope(answer(second.value.content.id, paused.revision)),
    );
    assert.equal(f.store.get(owner, q.task.id).status, "paused");
    assert.equal(f.store.claim(owner, "worker"), null);
  } finally {
    f.close();
  }
});
test("independent receiver instances racing the same original ciphertext commit one Inbox effect", async () => {
  const f = await fixture();
  try {
    const built = f.build(),
      other = new PrivateConversationContent(
        f.store,
        f.vault,
        owner,
        built.consent,
        built.keys,
        f.access,
        f.clock,
      ),
      env = await f.envelope(f.message());
    const results = await Promise.all([
      f.accept(env),
      other.accept({
        permissionId: f.grant.id,
        envelope: env,
        confirmed: true,
      }),
    ]);
    assert.deepEqual(results.map((r) => r.duplicate).sort(), [false, true]);
    assert.equal(f.store.exportPrivateConversationContent(owner).length, 1);
  } finally {
    f.close();
  }
});
test("revoked grants, wrong directed keys, forged scope and operation mismatch produce no content or receipt", async () => {
  const f = await fixture();
  try {
    const before = counts(f);
    for (const body of [
      { ...f.message(), scope: { ...f.scope, conversationRef: randomUUID() } },
      { ...f.message(), scope: { ...f.scope, permissionId: randomUUID() } },
    ])
      await assert.rejects(f.accept(await f.envelope(body)));
    await assert.rejects(
      f.accept(await f.envelope(f.message(), { operationId: randomUUID() })),
    );
    await assert.rejects(
      f.accept(await f.envelope(f.message(), { senderKeyEpoch: 2 })),
    );
    const env = await f.envelope(f.message());
    f.consent.revoke({
      permissionId: f.grant.id,
      expectedRevision: f.consent.list().revision,
      confirmed: true,
    });
    await assert.rejects(f.accept(env));
    assert.deepEqual(counts(f), before);
  } finally {
    f.close();
  }
});
test("native key coverage lost during asynchronous resolution denies content before Inbox changes", async () => {
  const f = await fixture();
  try {
    const env = await f.envelope(f.message()),
      before = counts(f),
      slot = f.entries(f.grant.local.keyId).key;
    slot.beforeRead = async () => {
      const record = JSON.parse(Buffer.from(slot.value!).toString());
      delete record.incomingReplayBoundary;
      slot.value = Buffer.from(JSON.stringify(record));
    };
    await assert.rejects(f.accept(env));
    assert.deepEqual(counts(f), before);
  } finally {
    f.close();
  }
});

test("a local ordinary reply cannot shed a task-linked parent's source checks when shared", async () => {
  const f = await fixture(true);
  try {
    const q = waiting(f),
      question = await f.prepareContent(q.question.id, "question");
    await f.sealContent(question);
    const unlinked = f.store.appendMessage(
      owner,
      {
        conversationId: f.choices.conversationId,
        recipientInboxId: f.inbox.id,
        replyToId: q.question.id,
        type: "reply",
        content: "SYNTHETIC_UNLINKED_LOCAL_REPLY",
      },
      randomUUID(),
    );
    const before = counts(f);
    await assert.rejects(
      f.prepareContent(unlinked.id, "message", question.value.content.id),
      /DENIED/,
    );
    assert.deepEqual(counts(f), before);
  } finally {
    f.close();
  }
});

test("actual HTTP export hides source-bound journal text and ciphertext, while retaining available local content", async () => {
  const f = await fixture();
  const { createServer } = await import("node:http");
  const { localApi } = await import("../apps/companion/http.js");
  const server = createServer();
  try {
    const refs = [
        {
          app: "crm",
          tenantId: "workspace",
          resourceId: "synthetic-record",
          revision: "1",
        },
      ],
      binding = {
        authority: {
          userId: owner.userId,
          subjectId: "synthetic-subject",
          tenantId: "workspace",
          deviceId: "synthetic-mac",
          sourceApp: "crm",
          grantId: "synthetic-grant",
          policyRevision: "1",
        },
        refs,
        expiresAt: new Date(f.clock() + 600000).toISOString(),
        projectionHash: "a".repeat(64),
      };
    const task = f.store.create(
      owner,
      {
        conversationId: f.choices.conversationId,
        kind: "query",
        prompt: "Summarize the synthetic CRM record",
        modelProfileId: "synthetic",
        sourceRefs: refs,
      },
      randomUUID(),
      binding as any,
    );
    const sourceMessage = f.store.appendMessage(
      owner,
      {
        conversationId: f.choices.conversationId,
        recipientInboxId: f.inbox.id,
        requestId: task.id,
        type: "notification",
        content: "SOURCE_JOURNAL_SENTINEL",
      },
      randomUUID(),
    );
    const shared = await f.prepareContent(sourceMessage.id);
    await f.sealContent(shared);
    const available = await f.accept(await f.envelope(f.message()));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as import("node:net").AddressInfo).port,
      token = "synthetic-export-token".repeat(4);
    server.on("request", localApi({ store: f.store, owner, token, port }));
    const url = `http://127.0.0.1:${port}/v1/export`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const exported = (await response.json()) as any;
    assert.doesNotMatch(JSON.stringify(exported), /SOURCE_JOURNAL_SENTINEL/);
    const hidden = exported.privateConversationContent.find(
      (e: any) => e.id === shared.id,
    );
    assert.equal(hidden.contentAccess, "unavailable");
    assert.equal(hidden.value, undefined);
    assert.equal(
      exported.privateConversationContent.find(
        (e: any) => e.id === available.entry.id,
      ).value.content.content,
      "SYNTHETIC_REMOTE_CONTENT",
    );
    f.store.db
      .prepare("DELETE FROM messages WHERE id=?")
      .run(available.entry.value.localMessageId);
    const after = (await (
      await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as any;
    assert.equal(
      after.privateConversationContent.find(
        (e: any) => e.id === available.entry.id,
      ).contentAccess,
      "unavailable",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    f.close();
  }
});
