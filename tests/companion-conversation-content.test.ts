import { CompanionPrivateKeys } from "../apps/companion/private-keys.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { conversationOfferEndpoints } from "./helpers/conversation-offer-endpoints.js";
import { localApi } from "../apps/companion/http.js";
import { LocalWorker } from "../apps/companion/worker.js";
import {
  privateEnvelopeSuite,
  sealPrivateEnvelope,
} from "../modules/remote/private-envelope.js";

async function fixture(questions = false) {
  const f = await conversationOfferEndpoints({ content: true, questions });
  const permission = f.e.store.exportPrivateConversationConsent(f.e.owner)
    .grants[0]!;
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const token = randomBytes(32).toString("hex");
  let controls = f.e.controls;
  // Each reopened server handler receives the same real controller type.
  const bind = () => {
    server.removeAllListeners("request");
    server.on(
      "request",
      localApi({
        store: f.e.store,
        owner: f.e.owner,
        privateKeys: controls,
        token,
        port,
      }),
    );
  };
  bind();
  const call = (
    path = "",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`http://127.0.0.1:${port}/v1/private-conversation-content${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const ok = async (path: string, body?: unknown) => {
    const r = await call(path, body),
      value = (await r.json()) as any;
    assert.equal(r.status, 200, JSON.stringify(value));
    return value;
  };
  const prepare = (
    localMessageId = f.e.store.messages(
      f.e.owner,
      f.inbox.id,
      f.conversationId,
    )[0]!.id,
    kind = "message",
    parentId: string | null = null,
  ) => ({
    id: randomUUID(),
    permissionId: permission.id,
    expectedConsentRevision:
      f.e.controls.conversationPermissionStatus().revision,
    localMessageId,
    parentId,
    kind,
    expiresAt: f.clock() + 60000,
    confirmed: true,
  });
  const seal = (entry: any) => ({
    id: entry.id,
    permissionId: entry.permissionId,
    expectedRevision: entry.revision,
    confirmed: true,
  });
  let sequence = 100;
  const envelope = (body: any) =>
    f.a.remote.withVerifiedDevice((a) =>
      f.e.remote.withVerifiedDevice(async (b) => {
        const sender = await f.a.keys(a.current).resolve(),
          recipient = await f.e.keys(b.current).resolve();
        return sealPrivateEnvelope(
          {
            version: 1,
            suite: privateEnvelopeSuite,
            ownerId: f.a.grant.ownerId,
            senderId: f.a.grant.deviceId,
            recipientId: f.e.grant.deviceId,
            senderKeyEpoch: 1,
            recipientKeyEpoch: 1,
            messageId: randomUUID(),
            operationId: body.id,
            sequence: sequence++,
            issuedAt: f.clock(),
            expiresAt: f.clock() + 60000,
          },
          new TextEncoder().encode(JSON.stringify(body)),
          {
            senderKey: sender.pair,
            recipientPublicKey: recipient.pair.publicKey,
          },
          f.clock,
        );
      }),
    );
  const message = (parentId: string | null = null) => ({
    version: 1,
    type: "conversation.message",
    scope: {
      permissionId: permission.id,
      conversationRef: permission.conversationRef,
    },
    id: randomUUID(),
    parentId,
    content: "SYNTHETIC_ENCRYPTED_REPLY",
  });
  return {
    ...f,
    permission,
    call,
    ok,
    prepare,
    seal,
    envelope,
    message,
    replace: (next: typeof controls) => {
      controls = next;
      bind();
    },
    reopen: () => {
      f.e.reopen();
      controls = f.e.controls;
      bind();
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      f.close();
    },
  };
}
test("authenticated conversation handoff prepares once, preserves ciphertext after reopen and returns metadata only", async () => {
  const f = await fixture();
  try {
    const reads = f.e.reads(),
      identities = f.e.identities();
    const empty = await f.ok("");
    assert.equal(empty.enabled, true);
    assert.equal(empty.transportActive, false);
    assert.deepEqual(empty.items, []);
    assert.equal(f.e.reads(), reads);
    assert.equal(f.e.identities(), identities);
    const input = f.prepare(),
      prepared = await f.ok("/prepare", input);
    assert.deepEqual(await f.ok("/prepare", input), prepared);
    assert.doesNotMatch(
      JSON.stringify(prepared),
      /SYNTHETIC_NEVER_IN_OFFER|publicKey|binding|sourceRefs|ciphertext/,
    );
    const encrypted = await f.ok("/envelope", f.seal(prepared.entry));
    assert.equal(
      (await f.open(encrypted.envelope)).content,
      "SYNTHETIC_NEVER_IN_OFFER",
    );
    f.reopen();
    const history = await f.ok("");
    assert.equal(history.items.length, 1);
    assert.doesNotMatch(
      JSON.stringify(history),
      /SYNTHETIC_NEVER_IN_OFFER|publicKey|binding|sourceRefs|ciphertext/,
    );
    assert.deepEqual(
      await f.ok("/envelope", f.seal(history.items[0])),
      encrypted,
    );
    const reply = await f.envelope(f.message(input.id));
    const accepted = await f.ok("/receive", {
      permissionId: f.permission.id,
      envelope: reply,
      confirmed: true,
    });
    assert.equal(accepted.status, "accepted-locally");
    assert.equal(accepted.duplicate, false);
    assert.doesNotMatch(
      JSON.stringify(accepted),
      /SYNTHETIC_ENCRYPTED_REPLY|ciphertext|publicKey/,
    );
    const duplicate = await f.ok("/receive", {
      permissionId: f.permission.id,
      envelope: reply,
      confirmed: true,
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.entry.localMessageId, accepted.entry.localMessageId);
    const local = f.e.store.message(f.e.owner, accepted.entry.localMessageId);
    assert.equal(local.input.replyToId, input.localMessageId);
    const receipt = await f.ok("/envelope", f.seal(accepted.entry));
    assert.equal(
      (await f.open(receipt.envelope)).acceptedId,
      accepted.entry.id,
    );
  } finally {
    await f.close();
  }
});
test("conversation HTTP rejects missing confirmation, credentials, origins and disabled dispatch before side effects", async () => {
  const f = await fixture();
  try {
    const input = f.prepare(),
      reads = f.e.reads();
    for (const [body, headers, code] of [
      [input, { Authorization: "" }, 401],
      [input, { Origin: "https://untrusted.test" }, 403],
      [{ ...input, confirmed: false }, {}, 400],
      [{ ...input, authority: "caller-selected" }, {}, 400],
    ] as const)
      assert.equal((await f.call("/prepare", body, headers)).status, code);
    assert.equal(f.e.reads(), reads);
    assert.deepEqual((await f.ok("")).items, []);
    f.replace(f.e.build(true, true, f.e.owner, false));
    assert.equal((await f.ok("")).enabled, false);
    assert.equal((await f.call("/prepare", input)).status, 400);
    f.replace(f.e.build(true, false));
    assert.equal((await f.call("/prepare", input)).status, 400);
    assert.deepEqual((await f.ok("")).items, []);
  } finally {
    await f.close();
  }
});
test("late identity invalidation, revoked permission and missing parents retain no new conversation outcome", async () => {
  const f = await fixture();
  try {
    const body = f.message(randomUUID()),
      env = await f.envelope(body);
    const pending = await f.call("/receive", {
      permissionId: f.permission.id,
      envelope: env,
      confirmed: true,
    });
    assert.equal(pending.status, 409);
    assert.equal(((await pending.json()) as any).error, "PARENT_PENDING");
    f.e.readHook(() => f.e.controls.invalidate());
    assert.notEqual((await f.call("/prepare", f.prepare())).status, 200);
    f.e.readHook();
    const state = f.e.controls.conversationPermissionStatus();
    const review = await f.e.controls.prepareConversationPermission({
      action: "revoke",
      expectedRevision: state.revision,
      permissionId: f.permission.id,
    });
    await f.e.controls.confirmConversationPermission({
      reviewId: review.id,
      confirmed: true,
      acknowledged: true,
    });
    assert.notEqual((await f.call("/prepare", f.prepare())).status, 200);
    assert.deepEqual((await f.ok("")).items, []);
  } finally {
    await f.close();
  }
});
test("real worker question and encrypted HTTP answer resume the same task exactly once", async () => {
  const f = await fixture(true);
  try {
    const task = f.e.store.create(
      f.e.owner,
      {
        conversationId: f.conversationId,
        kind: "query",
        prompt: "Prepare a travel checklist",
        modelProfileId: "local",
        allowQuestions: true,
      },
      randomUUID(),
    );
    const profile = f.e.store.profile(f.e.owner, "local");
    let calls = 0;
    const worker = new LocalWorker(
      f.e.store,
      f.e.owner,
      {
        pin: async () => ({ profile, digest: "c".repeat(64) }),
        generate: async (_model, prompt, _signal, format) => {
          calls++;
          assert.equal(f.e.store.db.inTransaction, false);
          if (format)
            return JSON.stringify(
              calls === 1
                ? { decision: "ask", question: "Where are you travelling?" }
                : { decision: "continue" },
            );
          assert.match(prompt, /Lisbon/);
          return "Bring a map of Lisbon.";
        },
      },
      () => profile,
    );
    await worker.runOnce();
    assert.equal(f.e.store.get(f.e.owner, task.id).status, "awaiting_input");
    const wait = f.e.store.inputWaitHistory(f.e.owner, task.id)[0]!;
    const prepared = await f.ok(
      "/prepare",
      f.prepare(wait.questionId, "question"),
    );
    const encrypted = await f.ok("/envelope", f.seal(prepared.entry));
    const question = await f.open(encrypted.envelope);
    assert.equal(question.type, "conversation.question");
    assert.equal(question.taskId, task.id);
    const ordinary = await f.envelope(f.message(question.id));
    await f.ok("/receive", {
      permissionId: f.permission.id,
      envelope: ordinary,
      confirmed: true,
    });
    assert.equal(f.e.store.get(f.e.owner, task.id).status, "awaiting_input");
    const answer = await f.envelope({
      version: 1,
      type: "conversation.answer",
      scope: question.scope,
      id: randomUUID(),
      taskId: task.id,
      questionId: question.id,
      expectedRevision: question.taskRevision,
      content: "Lisbon",
      confirmed: true,
    });
    const request = {
      permissionId: f.permission.id,
      envelope: answer,
      confirmed: true,
    };
    const accepted = await f.ok("/receive", request);
    assert.equal(accepted.duplicate, false);
    assert.equal((await f.ok("/receive", request)).duplicate, true);
    assert.equal(f.e.store.get(f.e.owner, task.id).status, "queued");
    await worker.runOnce();
    const completed = f.e.store.get(f.e.owner, task.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.input.prompt, task.input.prompt);
    assert.match((completed.result as any).text, /Lisbon/);
    assert.equal(calls, 3);
    assert.equal((await f.ok("/receive", request)).duplicate, true);
    await worker.runOnce();
    assert.equal(calls, 3);
  } finally {
    await f.close();
  }
});

test("conversation host does not inherit private-task enablement or permit task content without its source guard", async () => {
  const f = await fixture();
  try {
    // Conversation permissions are independent of the private task dispatcher.
    f.replace(f.e.build(false, true, f.e.owner, true));
    const prepared = await f.ok("/prepare", f.prepare());
    assert.equal(prepared.entry.direction, "outgoing");
    const task = f.e.store.create(
      f.e.owner,
      {
        conversationId: f.conversationId,
        kind: "query",
        prompt: "Synthetic",
        modelProfileId: "local",
      },
      randomUUID(),
    );
    const message = f.e.store.appendMessage(
      f.e.owner,
      {
        conversationId: f.conversationId,
        recipientInboxId: f.inbox.id,
        requestId: task.id,
        type: "notification",
        content: "TASK_BOUND_SENTINEL",
      },
      randomUUID(),
    );
    f.replace(
      new CompanionPrivateKeys(
        f.e.store,
        f.e.vault,
        f.e.owner,
        f.e.entries,
        f.e.remote,
        true,
        f.clock,
        false,
        { enabled: true },
      ),
    );
    const denied = await f.call("/prepare", f.prepare(message.id));
    assert.notEqual(denied.status, 200);
    assert.doesNotMatch(await denied.text(), /TASK_BOUND_SENTINEL/);
    assert.equal((await f.ok("")).items.length, 1);
    f.replace(f.e.build(false, true, f.e.owner, true));
    assert.equal(
      (await f.ok("/prepare", f.prepare(message.id))).entry.localMessageId,
      message.id,
    );
  } finally {
    await f.close();
  }
});
test("conversation operations share the native key and permission lock", async () => {
  const f = await fixture();
  let release!: () => void;
  let pending: Promise<Response> | undefined;
  try {
    let entered!: () => void;
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const reading = new Promise<void>((r) => {
      entered = r;
    });
    const key = f.e.controls
      .status()
      .state.slots.find((s) => s.state === "active")!;
    f.e.slots.get(key.id)!.key.beforeRead = async () => {
      entered();
      await wait;
    };
    pending = f.call("/prepare", f.prepare());
    await reading;
    const competing = await f.call("/prepare", f.prepare());
    assert.equal(((await competing.json()) as any).error, "BUSY");
    await assert.rejects(
      f.e.controls.prepare({
        action: "revoke",
        expectedRevision: f.e.controls.status().state.revision,
        keyId: key.id,
      }),
      /BUSY/,
    );
    release();
    assert.equal((await pending).status, 200);
    assert.equal((await f.ok("")).items.length, 1);
  } finally {
    release?.();
    await pending;
    await f.close();
  }
});
