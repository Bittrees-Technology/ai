import { privateTaskPayloadSchema } from "../modules/remote/private-task-contracts.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { requestSchema } from "../modules/contracts/index.js";
import { LocalWorker, type Runtime } from "../apps/companion/worker.js";
import { localApi } from "../apps/companion/http.js";
import {
  questionPrompt,
  readQuestionDecision,
  questionDecisionFormat,
} from "../modules/models/questions.js";
const owner = { userId: "alice", tenantId: "personal" };
const profile = {
  id: "model",
  runtime: "ollama" as const,
  model: "synthetic",
  contextTokens: 4096,
  maxOutputTokens: 512,
  temperature: 0,
};
const pinned = { profile, digest: "a".repeat(64) };
const input = {
  conversationId: "thread",
  kind: "query",
  prompt: "Prepare my travel checklist",
  modelProfileId: "model",
  allowQuestions: true,
};
function fixture(generate: Runtime["generate"], patch = {}) {
  const store = new Store(":memory:", new Vault(randomBytes(32)));
  store.addProfile(owner, profile);
  const task = store.create(owner, { ...input, ...patch }, "task");
  const worker = new LocalWorker(
    store,
    owner,
    { pin: async () => pinned, generate },
    () => profile,
  );
  return { store, task, worker };
}
const ask = JSON.stringify({
  decision: "ask",
  question: "Where are you travelling?",
});
const proceed = JSON.stringify({ decision: "continue" });
test("actual model question, authenticated owner HTTP answer and resumed worker preserve task identity", async () => {
  const calls: string[] = [];
  const f = fixture(async (model, prompt, _signal, format) => {
    assert.deepEqual(model, pinned);
    assert.equal(f.store.db.inTransaction, false);
    calls.push(prompt);
    if (format) {
      assert.deepEqual(format, questionDecisionFormat);
      return calls.length === 1 ? ask : proceed;
    }
    assert.match(prompt, /Lisbon/);
    return "Bring your Lisbon itinerary.";
  });
  const server = createServer();
  try {
    assert.equal(f.store.inboxes(owner).length, 0);
    await f.worker.runOnce();
    assert.equal(f.store.get(owner, f.task.id).status, "awaiting_input");
    const wait = f.store.inputWaitHistory(owner, f.task.id)[0]!;
    assert.equal(
      f.store.message(owner, wait.questionId).input.content,
      "Where are you travelling?",
    );
    const token = randomBytes(32).toString("hex");
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    server.on("request", localApi({ store: f.store, owner, token, port }));
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    };
    const base = `http://127.0.0.1:${port}/v1/messages/${wait.questionId}`;
    const q = (await (
      await fetch(base + "/task-question", { headers })
    ).json()) as any;
    const answer = {
      questionId: q.questionId,
      expectedRevision: q.revision,
      content: "Lisbon",
      confirmed: true,
    };
    const response = await fetch(base + "/task-answer", {
      method: "POST",
      headers,
      body: JSON.stringify(answer),
    });
    assert.equal(response.status, 200);
    await f.worker.runOnce();
    const result = f.store.get(owner, f.task.id);
    assert.equal(result.status, "completed");
    assert.equal(result.input.prompt, input.prompt);
    assert.equal(result.input.allowQuestions, true);
    assert.match((result.result as any).text, /Lisbon/);
    assert.equal(calls.length, 3);
    assert.equal(
      (f.store.runHistory(owner, f.task.id)[0]!.model as any).questionPolicy,
      "local-clarification-v2",
    );
  } finally {
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((r) => server.close(() => r()));
    f.store.close();
  }
});
test("sufficient opted-in tasks continue while omitted/false choices keep their old single generation", async () => {
  for (const allowQuestions of [undefined, false, true]) {
    let calls = 0;
    const f = fixture(
      async (_m, _p, _s, format) => {
        calls++;
        return format ? proceed : "Useful answer";
      },
      { allowQuestions },
    );
    try {
      await f.worker.runOnce();
      assert.equal(f.store.get(owner, f.task.id).status, "completed");
      assert.equal(calls, allowQuestions ? 2 : 1);
      assert.deepEqual(f.store.inboxes(owner), []);
      assert.equal(f.store.inputWaitHistory(owner, f.task.id).length, 0);
    } finally {
      f.store.close();
    }
  }
  assert.equal(
    requestSchema.parse({ ...input, allowQuestions: undefined }).allowQuestions,
    undefined,
  );
  assert.equal(
    requestSchema.safeParse({ ...input, allowQuestions: "yes" }).success,
    false,
  );
  assert.equal(
    privateTaskPayloadSchema.safeParse({
      version: 1,
      type: "task.submit",
      kind: "query",
      prompt: "Remote request",
      allowQuestions: true,
    }).success,
    false,
  );
});
test("third model question stops honestly without a third wait or invented answer", async () => {
  const f = fixture(async () => ask);
  try {
    for (let n = 0; n < 2; n++) {
      await f.worker.runOnce();
      const q = f.store.inputWaitHistory(owner, f.task.id)[n]!;
      f.store.answerInput(
        owner,
        f.task.id,
        {
          questionId: q.questionId,
          expectedRevision: f.store.get(owner, f.task.id).revision,
          content: `Detail ${n}`,
        },
        `answer-${n}`,
      );
    }
    await f.worker.runOnce();
    assert.equal(f.store.inputWaitHistory(owner, f.task.id).length, 2);
    assert.equal(f.store.get(owner, f.task.id).status, "failed");
    assert.equal(f.store.get(owner, f.task.id).result, null);
    assert.ok(
      f.store
        .runHistory(owner, f.task.id)
        .some((r) => r.outcome === "clarification_limit"),
    );
  } finally {
    f.store.close();
  }
});
test("cancel, pause and expired lease during model decision cannot publish a late question", async () => {
  for (const action of ["cancel", "pause", "lease"] as const) {
    const f = fixture(async () => {
      if (action === "lease")
        f.store.db
          .prepare("UPDATE tasks SET lease_until=0 WHERE id=?")
          .run(f.task.id);
      else
        f.store.command(owner, f.task.id, {
          command: action,
          expectedRevision: f.store.get(owner, f.task.id).revision,
        });
      return ask;
    });
    try {
      await f.worker.runOnce();
      assert.equal(f.store.inputWaitHistory(owner, f.task.id).length, 0);
      assert.equal(f.store.inboxes(owner).length, 0);
      assert.equal(f.store.get(owner, f.task.id).result, null);
    } finally {
      f.store.close();
    }
  }
});
test("incompatible personal Inbox cannot be overwritten and failed question creation rolls back", async () => {
  const f = fixture(async () => ask);
  try {
    const inbox = f.store.createInbox(owner, {
      id: "personal",
      tenantId: "personal",
      ownerId: "agent",
      ownerType: "agent",
      memberUserIds: [owner.userId],
    });
    await f.worker.runOnce();
    assert.deepEqual(f.store.inboxes(owner), [inbox]);
    assert.equal(f.store.inputWaitHistory(owner, f.task.id).length, 0);
    assert.equal(f.store.get(owner, f.task.id).status, "failed");
  } finally {
    f.store.close();
  }
  const g = fixture(async () => ask);
  try {
    const c = g.store.claim(owner, "worker")!;
    assert.throws(() =>
      g.store.waitForOwnerInput(owner, g.task.id, "worker", c.generation, ""),
    );
    assert.equal(g.store.inboxes(owner).length, 0);
  } finally {
    g.store.close();
  }
});
test("question wait respects an earlier task deadline and opted-out tasks cannot use owner policy", async () => {
  const deadline = new Date(Date.now() + 60000).toISOString();
  const f = fixture(async () => ask, { deadline });
  try {
    await f.worker.runOnce();
    assert.equal(
      f.store.message(
        owner,
        f.store.inputWaitHistory(owner, f.task.id)[0]!.questionId,
      ).input.replyDueAt,
      deadline,
    );
  } finally {
    f.store.close();
  }
  const g = fixture(async () => ask, { allowQuestions: false });
  try {
    const c = g.store.claim(owner, "worker")!;
    assert.throws(() =>
      g.store.waitForOwnerInput(
        owner,
        g.task.id,
        "worker",
        c.generation,
        "Question?",
      ),
    );
    assert.deepEqual(g.store.inboxes(owner), []);
  } finally {
    g.store.close();
  }
});
test("malformed decisions and invented authority fields fail without a question or ordinary generation", async () => {
  for (const output of [
    "not json",
    '{"decision":"ask","question":"  "}',
    '{"decision":"continue","tool":"send"}',
    '{"decision":"ask","question":"Permission?","source":"foreign"}',
  ]) {
    let calls = 0;
    const f = fixture(async () => {
      calls++;
      return output;
    });
    try {
      await f.worker.runOnce();
      assert.equal(calls, 1);
      assert.equal(f.store.get(owner, f.task.id).status, "failed");
      assert.equal(
        f.store.runHistory(owner, f.task.id)[0]!.outcome,
        "invalid_model_output",
      );
      assert.equal(f.store.inputWaitHistory(owner, f.task.id).length, 0);
    } finally {
      f.store.close();
    }
  }
  assert.throws(() =>
    readQuestionDecision(
      JSON.stringify({ decision: "ask", question: "x".repeat(1001) }),
    ),
  );
});
test("clarification prompt preserves owner input and marks bounded multibyte source excerpts", () => {
  const request = "Owner choice: Lisbon 🌳";
  const prompt = questionPrompt(request, "資料🌳".repeat(10000), pinned);
  assert.ok(
    Buffer.byteLength(prompt) <=
      profile.contextTokens - profile.maxOutputTokens - 256,
  );
  assert.match(prompt, /"referenceTruncated":true/);
  assert.ok(prompt.includes(request));
  assert.throws(
    () => questionPrompt("x".repeat(32000), "", pinned),
    /CAPACITY/,
  );
});

test("memory changed during clarification cannot enter Inbox or a result", async () => {
  const { MemoryStore } = await import("../modules/memory/store.js");
  const vault = new Vault(randomBytes(32));
  const store = new Store(":memory:", vault);
  const memory = new MemoryStore(":memory:", vault, async () => true);
  try {
    const candidate = await memory.add(owner, {
      type: "preference",
      text: "Use a short itinerary",
      origin: "model",
      sources: [
        {
          app: "crm",
          tenantId: "personal",
          resourceId: "record",
          revision: "1",
        },
      ],
    });
    const approved = await memory.review(owner, candidate.id, 1, {
      approve: true,
    });
    const task = store.create(
      owner,
      { ...input, memoryIds: [approved.id] },
      "memory-question",
    );
    const worker = new LocalWorker(
      store,
      owner,
      {
        pin: async () => pinned,
        generate: async (_model, prompt) => {
          assert.match(prompt, /short itinerary/);
          await memory.review(owner, approved.id, approved.revision, {
            approve: false,
          });
          return ask;
        },
      },
      () => profile,
      "worker",
      memory,
    );
    await worker.runOnce();
    assert.equal(store.get(owner, task.id).status, "failed");
    assert.equal(store.inputWaitHistory(owner, task.id).length, 0);
    assert.equal(store.inboxes(owner).length, 0);
  } finally {
    memory.close();
    store.close();
  }
});

test("local source HTTP routes preserve explicit question choice and reject non-boolean authority-like input", async () => {
  const store = new Store(":memory:", new Vault(randomBytes(32)));
  store.addProfile(owner, profile);
  const create = async (
    s: Store,
    input: unknown,
    _selection: unknown,
    key: string,
  ) => s.create(owner, input, key);
  const server = createServer();
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port,
      token = randomBytes(32).toString("hex");
    server.on(
      "request",
      localApi({
        store,
        owner,
        token,
        port,
        sources: { create } as any,
        autonoteSources: { create } as any,
        mailSources: { create } as any,
      }),
    );
    for (const app of ["crm", "autonote", "mail"]) {
      const body = {
        conversationId: randomUUID(),
        prompt: "Synthetic source request",
        modelProfileId: profile.id,
        allowQuestions: true,
        ...(app === "crm"
          ? { recordIds: [randomUUID()] }
          : app === "autonote"
            ? { meetingId: randomUUID() }
            : { kind: "summarize", content: "metadata" }),
      };
      const call = (value: unknown) =>
        fetch(`http://127.0.0.1:${port}/v1/connections/${app}/drafts`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Idempotency-Key": randomUUID(),
          },
          body: JSON.stringify(value),
        });
      const r = await call(body);
      assert.equal(r.status, 202);
      assert.equal(((await r.json()) as any).input.allowQuestions, true);
      assert.equal(
        (await call({ ...body, allowQuestions: "approve" })).status,
        400,
      );
      assert.equal(
        (await call({ ...body, authority: { publish: true } })).status,
        400,
      );
    }
  } finally {
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});

test("credential-bearing model questions never create an Inbox wait or reach ordinary generation", async () => {
  for (const question of [
    "What is the user's password and login code?",
    "Please share your API key.",
    "What is your password reset code?",
    "Please provide your password reset token.",
    "What is your p\u200bassword?",
    "Please provide your one-time code.",
    "Which private key should I use?",
    "What is your seed phrase?",
    "Qual é a sua senha?",
    "Qual é o seu código de autenticação?",
    "What is your password manager password?",
  ]) {
    let calls = 0;
    const f = fixture(async () => {
      calls++;
      return JSON.stringify({ decision: "ask", question });
    });
    try {
      await f.worker.runOnce();
      assert.equal(calls, 1);
      assert.equal(f.store.get(owner, f.task.id).status, "failed");
      assert.equal(
        f.store.runHistory(owner, f.task.id)[0]!.outcome,
        "invalid_model_output",
      );
      assert.deepEqual(f.store.inboxes(owner), []);
      assert.deepEqual(f.store.inputWaitHistory(owner, f.task.id), []);
    } finally {
      f.store.close();
    }
  }
});
test("nonsecret security topics and ordinary missing facts remain valid clarification", () => {
  for (const question of [
    "Which password manager do you prefer?",
    "Which password length does the policy require?",
    "Which private key algorithm does your project use?",
    "What is the model context token limit?",
    "Which legal entity did you choose?",
    "Would you like to attend the meeting?",
  ]) {
    assert.deepEqual(
      readQuestionDecision(JSON.stringify({ decision: "ask", question })),
      { decision: "ask", question },
    );
  }
  assert.deepEqual(readQuestionDecision('{"decision":"continue"}'), {
    decision: "continue",
  });
});
