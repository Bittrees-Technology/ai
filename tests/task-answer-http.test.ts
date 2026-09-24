import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { localApi } from "../apps/companion/http.js";
const owner = { userId: "alice", tenantId: "personal" };
async function fixture(apiOwner = owner) {
  let now = Date.now();
  const store = new Store(":memory:", new Vault(randomBytes(32)), () => now);
  store.createInbox(owner, {
    id: "personal",
    tenantId: "personal",
    ownerId: "alice",
    ownerType: "user",
    memberUserIds: ["alice"],
  });
  const task = store.create(
    owner,
    {
      conversationId: "thread",
      kind: "query",
      prompt: "Original request",
      modelProfileId: "synthetic",
    },
    "task",
  );
  const claim = store.claim(owner, "worker")!;
  const waiting = store.waitForInput(
    owner,
    task.id,
    "worker",
    claim.generation,
    {
      inboxId: "personal",
      question: "QUESTION_SENTINEL",
      replyDueAt: new Date(now + 60000).toISOString(),
    },
    "question",
  );
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port,
    token = randomBytes(32).toString("hex");
  server.on("request", localApi({ store, owner: apiOwner, token, port }));
  const path = `/v1/messages/${waiting.question.id}`;
  const call = (
    suffix: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`http://127.0.0.1:${port}${path}${suffix}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const key = randomUUID(),
    body = {
      questionId: waiting.question.id,
      expectedRevision: waiting.task.revision,
      content: "ANSWER_SENTINEL",
      confirmed: true,
    };
  return {
    store,
    task,
    waiting,
    call,
    body,
    advance: () => (now += 60000),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    },
  };
}
test("authenticated exact-question HTTP answer queues once and returns a content-free receipt", async () => {
  const f = await fixture();
  try {
    const read = await f.call("/task-question");
    assert.equal(read.status, 200);
    assert.equal(read.headers.get("cache-control"), "no-store");
    const q = (await read.json()) as any;
    assert.equal(q.question, "QUESTION_SENTINEL");
    assert.equal(q.canAnswer, true);
    const saved = await f.call("/task-answer", f.body);
    assert.equal(saved.status, 200);
    const receipt = (await saved.json()) as any;
    assert.equal(receipt.status, "queued");
    assert.equal(receipt.duplicate, false);
    assert.doesNotMatch(
      JSON.stringify(receipt),
      /SENTINEL|prompt|sourceRefs|content/,
    );
    const duplicate = await f.call("/task-answer", f.body);
    assert.equal(duplicate.status, 200);
    assert.equal(((await duplicate.json()) as any).duplicate, true);
    assert.equal(
      f.store.inputWaitHistory(owner, f.task.id)[0]!.replyId,
      receipt.replyId,
    );
    const answered = (await (await f.call("/task-question")).json()) as any;
    assert.equal(answered.canAnswer, false);
    assert.equal(answered.replyId, receipt.replyId);
    assert.equal(
      (
        await f.call("/task-answer", f.body, {
          "Idempotency-Key": randomUUID(),
        })
      ).status,
      409,
    );
    assert.equal(
      (await f.call("/task-answer", { ...f.body, content: "Changed" })).status,
      409,
    );
    f.advance();
    assert.equal((await f.call("/task-answer", f.body)).status, 200);
  } finally {
    await f.close();
  }
});
test("HTTP confirmation, origin, credential, path and stale revision checks do not append an answer", async () => {
  const f = await fixture();
  try {
    const cases: [unknown, Record<string, string>, number][] = [
      [{ ...f.body, confirmed: false }, {}, 400],
      [{ ...f.body, confirmed: undefined }, {}, 400],
      [f.body, { Authorization: "" }, 401],
      [f.body, { Origin: "https://untrusted.test" }, 403],
      [f.body, { "Idempotency-Key": "" }, 400],
      [{ ...f.body, questionId: randomUUID() }, {}, 409],
      [{ ...f.body, expectedRevision: f.body.expectedRevision + 1 }, {}, 409],
      [{ ...f.body, content: "x".repeat(32001) }, {}, 400],
    ];
    for (const [body, headers, status] of cases) {
      const r = await f.call("/task-answer", body, headers);
      assert.equal(r.status, status);
      assert.doesNotMatch(await r.text(), /SENTINEL/);
      assert.equal(
        f.store.inputWaitHistory(owner, f.task.id)[0]!.replyId,
        null,
      );
    }
  } finally {
    await f.close();
  }
});
test("HTTP answer to a paused task stays paused; cancelled and expired tasks cannot receive new answers", async () => {
  for (const state of ["pause", "cancel", "expire"] as const) {
    const f = await fixture();
    try {
      if (state === "expire") f.advance();
      else
        f.store.command(owner, f.task.id, {
          command: state,
          expectedRevision: f.waiting.task.revision,
        });
      const body = {
        ...f.body,
        expectedRevision: f.store.get(owner, f.task.id).revision,
      };
      const r = await f.call("/task-answer", body);
      if (state === "pause") {
        assert.equal(r.status, 200);
        assert.equal(((await r.json()) as any).status, "paused");
        assert.equal(f.store.claim(owner, "worker"), null);
      } else {
        assert.notEqual(r.status, 200);
        assert.equal(
          f.store.inputWaitHistory(owner, f.task.id)[0]!.replyId,
          null,
        );
      }
    } finally {
      await f.close();
    }
  }
});
test("ordinary Inbox replies never satisfy the wait and a removed task question cannot be answered", async () => {
  const f = await fixture();
  try {
    f.store.appendMessage(
      owner,
      {
        conversationId: "thread",
        recipientInboxId: "personal",
        requestId: f.task.id,
        replyToId: f.waiting.question.id,
        content: "Ordinary reply",
        type: "reply",
      },
      "ordinary",
    );
    assert.equal(
      ((await (await f.call("/task-question")).json()) as any).canAnswer,
      true,
    );
    assert.equal(f.store.get(owner, f.task.id).status, "awaiting_input");
    f.store.deleteAll(owner);
    assert.equal((await f.call("/task-question")).status, 404);
    assert.equal((await f.call("/task-answer", f.body)).status, 404);
  } finally {
    await f.close();
  }
});

test("another local owner cannot read or answer a private task question", async () => {
  const f = await fixture({ userId: "bob", tenantId: "personal" });
  try {
    for (const r of [
      await f.call("/task-question"),
      await f.call("/task-answer", f.body),
    ]) {
      assert.notEqual(r.status, 200);
      assert.doesNotMatch(await r.text(), /SENTINEL/);
    }
    assert.equal(f.store.inputWaitHistory(owner, f.task.id)[0]!.replyId, null);
  } finally {
    await f.close();
  }
});
