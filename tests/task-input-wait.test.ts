import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { LocalWorker } from "../apps/companion/worker.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
const owner = { userId: "alice", tenantId: "personal" };
const profile = {
  id: "model",
  runtime: "ollama" as const,
  model: "synthetic",
  contextTokens: 4096,
  maxOutputTokens: 512,
  temperature: 0,
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bittrees-input-wait-")),
    path = join(dir, "tasks.db"),
    vault = new Vault(randomBytes(32));
  let now = Date.now();
  let s = new Store(path, vault, () => now);
  s.addProfile(owner, profile);
  s.createInbox(owner, {
    id: "personal",
    tenantId: owner.tenantId,
    ownerId: owner.userId,
    ownerType: "user",
    memberUserIds: [owner.userId],
  });
  const input = {
    conversationId: "thread",
    kind: "query" as const,
    prompt: "Original request",
    modelProfileId: profile.id,
  };
  const task = s.create(owner, input, "original");
  return {
    get s() {
      return s;
    },
    task,
    input,
    dir,
    path,
    vault,
    now: () => now,
    advance: (ms: number) => (now += ms),
    reopen: () => {
      s.close();
      s = new Store(path, vault, () => now);
    },
    close: () => {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function wait(f: ReturnType<typeof fixture>, key = "question") {
  const claim = f.s.claim(owner, "worker")!;
  assert.equal(claim.task.id, f.task.id);
  const question = {
    inboxId: "personal",
    question: "Which scope?",
    replyDueAt: new Date(f.now() + 60000).toISOString(),
  };
  const value = f.s.waitForInput(
    owner,
    f.task.id,
    "worker",
    claim.generation,
    question,
    key,
  );
  return { ...value, claim, questionInput: question };
}
function answer(
  f: ReturnType<typeof fixture>,
  q: ReturnType<typeof wait>,
  content = "Only the selected scope",
  key = "answer",
) {
  return f.s.answerInput(
    owner,
    f.task.id,
    {
      questionId: q.question.id,
      expectedRevision: f.s.get(owner, f.task.id).revision,
      content,
    },
    key,
  );
}
test("real wait transition invalidates its lease; exact reply bypasses blocked work and the restarted worker consumes it", async () => {
  const f = fixture();
  try {
    const later = f.s.create(
      owner,
      { ...f.input, prompt: "Later same-thread work" },
      "later",
    );
    const q = wait(f);
    assert.equal(q.task.status, "awaiting_input");
    assert.equal(f.s.claim(owner, "other"), null);
    assert.throws(
      () =>
        f.s.complete(owner, f.task.id, "worker", q.claim.generation, {
          text: "stale",
        }),
      /STALE_CLAIM/,
    );
    assert.equal(
      f.s.waitForInput(
        owner,
        f.task.id,
        "worker",
        q.claim.generation,
        q.questionInput,
        "question",
      ).duplicate,
      true,
    );
    const ordinary = f.s.appendMessage(
      owner,
      {
        conversationId: "thread",
        recipientInboxId: "personal",
        requestId: f.task.id,
        replyToId: q.question.id,
        type: "reply",
        content: "Unassociated reply",
      },
      "ordinary",
    );
    assert.ok(ordinary.id);
    assert.equal(f.s.get(owner, f.task.id).status, "awaiting_input");
    f.reopen();
    const received = answer(f, q);
    assert.equal(received.task.status, "queued");
    assert.deepEqual(received.task.input, q.task.input);
    f.reopen();
    const prompts: string[] = [];
    const worker = new LocalWorker(
      f.s,
      owner,
      {
        pin: async () => ({ profile, digest: "a".repeat(64) }),
        generate: async (_model, prompt) => {
          assert.equal(f.s.db.inTransaction, false);
          prompts.push(prompt);
          return "Synthetic result";
        },
      },
      () => f.s.profile(owner, "model"),
    );
    assert.equal(await worker.runOnce(), true);
    assert.equal(f.s.get(owner, f.task.id).status, "completed");
    assert.equal(f.s.get(owner, later.id).status, "queued");
    assert.match(prompts[0]!, /Original request/);
    assert.match(prompts[0]!, /Which scope/);
    assert.match(prompts[0]!, /Only the selected scope/);
    assert.doesNotMatch(prompts[0]!, /Unassociated reply/);
    assert.equal(await worker.runOnce(), true);
    assert.equal(prompts[1], "Later same-thread work");
    assert.equal(
      f.s.runHistory(owner, f.task.id)[0]!.outcome,
      "awaiting_input",
    );
    assert.deepEqual(
      (f.s.runHistory(owner, f.task.id)[1]!.model as any).inputReplies,
      [{ questionId: q.question.id, replyId: received.reply.id }],
    );
  } finally {
    f.close();
  }
});
test("reply identity and reviewed revision reject conflicting, cross-owner, cross-task and changed-authority mutations atomically", () => {
  const f = fixture();
  try {
    const q = wait(f),
      raw = {
        questionId: q.question.id,
        expectedRevision: q.task.revision,
        content: "Exact answer",
      };
    assert.throws(
      () =>
        f.s.answerInput({ ...owner, userId: "bob" }, f.task.id, raw, "answer"),
      /NOT_FOUND/,
    );
    const other = f.s.create(
      owner,
      { ...f.input, conversationId: "other" },
      "other",
    );
    assert.throws(
      () => f.s.answerInput(owner, other.id, raw, "answer"),
      /NOT_FOUND/,
    );
    assert.throws(
      () =>
        f.s.answerInput(
          owner,
          f.task.id,
          { ...raw, expectedRevision: 1 },
          "answer",
        ),
      /CONFLICT/,
    );
    let checks = 0;
    assert.throws(
      () =>
        f.s.answerInput(owner, f.task.id, raw, "answer", () => {
          if (++checks === 2) throw Error("REVOKED");
        }),
      /REVOKED/,
    );
    assert.equal(f.s.exportMessages(owner).length, 1);
    assert.equal(f.s.get(owner, f.task.id).status, "awaiting_input");
    assert.equal(f.s.inputWaitHistory(owner, f.task.id)[0]!.replyId, null);
    const accepted = f.s.answerInput(owner, f.task.id, raw, "answer");
    const state = f.s.get(owner, f.task.id);
    assert.equal(
      f.s.answerInput(owner, f.task.id, raw, "answer").duplicate,
      true,
    );
    assert.deepEqual(f.s.get(owner, f.task.id), state);
    assert.throws(
      () =>
        f.s.answerInput(
          owner,
          f.task.id,
          { ...raw, content: "Changed" },
          "answer",
        ),
      /CONFLICT/,
    );
    assert.throws(
      () => f.s.answerInput(owner, f.task.id, raw, "another"),
      /CONFLICT/,
    );
    assert.equal(
      f.s.inputWaitHistory(owner, f.task.id)[0]!.replyId,
      accepted.reply.id,
    );
  } finally {
    f.close();
  }
});
test("pause/resume preserves outstanding question and an answer received while paused cannot restart work", () => {
  const f = fixture();
  try {
    const q = wait(f);
    let task = f.s.command(owner, f.task.id, {
      command: "pause",
      expectedRevision: q.task.revision,
    });
    task = f.s.command(owner, f.task.id, {
      command: "resume",
      expectedRevision: task.revision,
    });
    assert.equal(task.status, "awaiting_input");
    assert.equal(f.s.claim(owner, "other"), null);
    task = f.s.command(owner, f.task.id, {
      command: "pause",
      expectedRevision: task.revision,
    });
    assert.equal(answer(f, q).task.status, "paused");
    assert.equal(f.s.claim(owner, "other"), null);
    task = f.s.command(owner, f.task.id, {
      command: "resume",
      expectedRevision: f.s.get(owner, f.task.id).revision,
    });
    assert.equal(task.status, "queued");
    assert.equal(f.s.claim(owner, "other")!.task.id, f.task.id);
  } finally {
    f.close();
  }
});
test("cancel, reply deadline and backwards time deny answers; expiry maintenance releases later same-thread work", () => {
  for (const mode of ["cancel", "expire", "backwards"]) {
    const f = fixture();
    try {
      const later = f.s.create(owner, { ...f.input, prompt: "Later" }, "later"),
        q = wait(f);
      if (mode === "cancel")
        f.s.command(owner, f.task.id, {
          command: "cancel",
          expectedRevision: q.task.revision,
        });
      if (mode === "expire") f.advance(60000);
      if (mode === "backwards") f.advance(-1);
      assert.throws(
        () => answer(f, q),
        mode === "cancel" ? /CONFLICT/ : /EXPIRED/,
      );
      if (mode !== "backwards") {
        const claim = f.s.claim(owner, "next");
        assert.equal(claim!.task.id, later.id);
        assert.equal(
          f.s.get(owner, f.task.id).status,
          mode === "cancel" ? "cancelled" : "expired",
        );
      }
    } finally {
      f.close();
    }
  }
});
test("question count and combined context are bounded without evicting saved replies", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 8; i++) {
      const q = wait(f, "question" + i);
      answer(f, q, "answer" + i, "answer" + i);
    }
    const claim = f.s.claim(owner, "worker")!;
    assert.throws(
      () =>
        f.s.waitForInput(
          owner,
          f.task.id,
          "worker",
          claim.generation,
          {
            inboxId: "personal",
            question: "Ninth",
            replyDueAt: new Date(f.now() + 60000).toISOString(),
          },
          "ninth",
        ),
      /CAPACITY/,
    );
    assert.equal(f.s.inputWaitHistory(owner, f.task.id).length, 8);
    assert.equal(f.s.exportMessages(owner).length, 16);
  } finally {
    f.close();
  }
  const g = fixture();
  try {
    for (let i = 0; i < 2; i++) {
      const c = g.s.claim(owner, "worker")!,
        question = {
          inboxId: "personal",
          question: "q".repeat(32000),
          replyDueAt: new Date(g.now() + 60000).toISOString(),
        };
      const w = g.s.waitForInput(
        owner,
        g.task.id,
        "worker",
        c.generation,
        question,
        "q" + i,
      );
      g.s.answerInput(
        owner,
        g.task.id,
        {
          questionId: w.question.id,
          expectedRevision: w.task.revision,
          content: "r".repeat(32000),
        },
        "r" + i,
      );
    }
    const c = g.s.claim(owner, "worker")!;
    assert.throws(
      () =>
        g.s.waitForInput(
          owner,
          g.task.id,
          "worker",
          c.generation,
          {
            inboxId: "personal",
            question: "Beyond bound",
            replyDueAt: new Date(g.now() + 60000).toISOString(),
          },
          "extra",
        ),
      /CAPACITY/,
    );
  } finally {
    g.close();
  }
});
test("reply input does not bypass fresh model resolution and its encrypted backup/export/delete lifecycle is complete", async () => {
  const f = fixture();
  let copy: Store | undefined;
  try {
    const q = wait(f);
    answer(f, q, "Unique secret answer text");
    const backup = join(f.dir, "saved.aib"),
      restored = join(f.dir, "restored.db");
    await encryptedBackup(f.s, f.vault, backup);
    await restoreBackup(backup, f.vault, restored);
    copy = new Store(restored, f.vault, () => f.now());
    assert.deepEqual(copy.exportInputWaits(owner), f.s.exportInputWaits(owner));
    assert.deepEqual(copy.exportMessages(owner), f.s.exportMessages(owner));
    assert.equal(
      readFileSync(backup).includes(Buffer.from("Unique secret answer text")),
      false,
    );
    const worker = new LocalWorker(
      copy,
      owner,
      {
        pin: async () => {
          throw Error("Model no longer available");
        },
        generate: async () => assert.fail("must not generate"),
      },
      () => profile,
    );
    assert.equal(await worker.runOnce(), true);
    assert.equal(copy.get(owner, f.task.id).status, "failed");
    copy.deleteAll(owner);
    assert.deepEqual(copy.exportInputWaits(owner), []);
    assert.deepEqual(copy.exportMessages(owner), []);
    assert.equal(
      (copy.db.prepare("SELECT count(*) n FROM task_input_waits").get() as any)
        .n,
      0,
    );
  } finally {
    copy?.close();
    f.close();
  }
});
