import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import Database from "better-sqlite3";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
import { localApi } from "../apps/companion/http.js";
import { ConnectorError } from "../modules/connectors/crm.js";
import type { CrmTasks } from "../modules/connectors/crm-tasks.js";
import type { SourceBinding } from "../modules/contracts/index.js";
const owner = { userId: "alice", tenantId: "personal" };
const profile = {
  id: "synthetic",
  runtime: "ollama",
  model: "synthetic:local",
  contextTokens: 4096,
  maxOutputTokens: 512,
  temperature: 0.2,
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ai-quality-")),
    path = join(root, "tasks.db"),
    vault = new Vault(randomBytes(32));
  let store = new Store(path, vault);
  return {
    root,
    path,
    vault,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new Store(path, vault);
    },
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function complete(store: Store, binding?: SourceBinding) {
  store.addProfile(owner, profile);
  const task = store.create(
    owner,
    {
      conversationId: randomUUID(),
      kind: "draft",
      prompt: "Synthetic draft",
      modelProfileId: profile.id,
      sourceRefs: binding?.refs ?? [],
    },
    randomUUID(),
    binding,
  );
  const claim = store.claim(owner, "synthetic-worker")!;
  assert.equal(claim.task.id, task.id);
  store.recordModel(owner, task.id, "synthetic-worker", claim.generation, {
    profile,
    digest: "a".repeat(64),
  });
  store.complete(owner, task.id, "synthetic-worker", claim.generation, {
    text: "Synthetic result",
  });
  return store.get(owner, task.id);
}
function body(
  store: Store,
  id: string,
  outcome = "accepted",
  note = "REVIEW_PRIVATE_SENTINEL",
) {
  const context = store.taskFeedback.read(owner, id);
  return {
    expectedTaskRevision: context.taskRevision,
    runId: context.runId,
    expectedReviewRevision: context.reviewRevision,
    operationId: randomUUID(),
    review: { outcome, note },
    confirmed: true,
  };
}
test("human feedback binds a completed model run, replaces one review and rejects forged authority, stale edits and duplicate operation changes", () => {
  const f = fixture();
  try {
    const task = complete(f.store),
      before = f.store.get(owner, task.id),
      runs = f.store.runHistory(owner, task.id),
      input = body(f.store, task.id);
    const saved = f.store.taskFeedback.save(owner, task.id, input);
    assert.equal(saved.reviewRevision, 1);
    assert.equal(saved.review?.outcome, "accepted");
    assert.deepEqual(saved.model, { profile, digest: "a".repeat(64) });
    assert.deepEqual(f.store.taskFeedback.save(owner, task.id, input), saved);
    assert.throws(
      () =>
        f.store.taskFeedback.save(owner, task.id, {
          ...input,
          review: { outcome: "edited", note: "change" },
        }),
      /CONFLICT/,
    );
    assert.throws(
      () =>
        f.store.taskFeedback.save(owner, task.id, {
          ...input,
          operationId: randomUUID(),
        }),
      /CONFLICT/,
    );
    for (const patch of [
      { confirmed: false },
      { authority: owner },
      { review: { outcome: "approved", note: "" } },
      { review: { outcome: "accepted", note: "x".repeat(2001) } },
      { runId: "wrong" },
      { expectedTaskRevision: task.revision + 1 },
    ])
      assert.throws(() =>
        f.store.taskFeedback.save(owner, task.id, {
          ...body(f.store, task.id),
          ...patch,
        }),
      );
    for (const other of [
      { userId: "bob", tenantId: "personal" },
      { userId: "alice", tenantId: "other" },
    ]) {
      assert.throws(
        () => f.store.taskFeedback.read(other, task.id),
        /NOT_FOUND/,
      );
      assert.throws(
        () => f.store.taskFeedback.save(other, task.id, body(f.store, task.id)),
        /NOT_FOUND/,
      );
      assert.deepEqual(f.store.taskFeedback.exportLocal(other), []);
    }
    const changed = f.store.taskFeedback.save(
      owner,
      task.id,
      body(f.store, task.id, "edited", "Changed the unsupported date"),
    );
    assert.equal(changed.reviewRevision, 2);
    assert.equal(changed.review?.outcome, "edited");
    assert.equal(f.store.taskFeedback.exportLocal(owner).length, 1);
    assert.deepEqual(f.store.get(owner, task.id), before);
    assert.deepEqual(f.store.runHistory(owner, task.id), runs);
    const token = f.store.changeToken();
    const remove = { ...body(f.store, task.id), review: null };
    const deleted = f.store.taskFeedback.save(owner, task.id, remove);
    assert.equal(deleted.reviewRevision, 3);
    assert.equal(deleted.review, null);
    assert.deepEqual(
      f.store.taskFeedback.save(owner, task.id, remove),
      deleted,
    );
    assert.notEqual(f.store.changeToken(), token);
    assert.deepEqual(f.store.taskFeedback.exportLocal(owner), []);
    assert.throws(
      () => f.store.taskFeedback.save(owner, task.id, input),
      /CONFLICT/,
    );
  } finally {
    f.close();
  }
});
test("feedback stays encrypted and survives supported backup/restore while deletion cascades and queued/unrecorded tasks cannot be rated", async () => {
  const f = fixture();
  try {
    const task = complete(f.store),
      saved = f.store.taskFeedback.save(owner, task.id, body(f.store, task.id));
    const row = f.store.db
      .prepare("SELECT payload FROM task_feedback")
      .get() as { payload: Buffer };
    assert.equal(row.payload.includes("REVIEW_PRIVATE_SENTINEL"), false);
    const queued = f.store.create(
      owner,
      {
        conversationId: randomUUID(),
        kind: "query",
        prompt: "pending",
        modelProfileId: profile.id,
      },
      randomUUID(),
    );
    assert.throws(
      () => f.store.taskFeedback.read(owner, queued.id),
      /CONFLICT/,
    );
    const claim = f.store.claim(owner, "unrecorded")!;
    f.store.complete(owner, queued.id, "unrecorded", claim.generation, {
      text: "No recorded model",
    });
    assert.throws(
      () => f.store.taskFeedback.read(owner, queued.id),
      /CONFLICT/,
    );
    const backup = join(f.root, "backup.enc"),
      restored = join(f.root, "restored.db");
    await encryptedBackup(f.store, f.vault, backup);
    await restoreBackup(backup, f.vault, restored);
    const copy = new Store(restored, f.vault);
    try {
      assert.deepEqual(copy.taskFeedback.read(owner, task.id), saved);
      assert.equal(copy.db.pragma("user_version", { simple: true }), 38);
    } finally {
      copy.close();
    }
    f.reopen();
    assert.deepEqual(f.store.taskFeedback.read(owner, task.id), saved);
    f.store.deleteAll(owner);
    assert.equal(
      (
        f.store.db.prepare("SELECT count(*) n FROM task_feedback").get() as {
          n: number;
        }
      ).n,
      0,
    );
    assert.equal(
      readFileSync(backup).includes("REVIEW_PRIVATE_SENTINEL"),
      false,
    );
  } finally {
    f.close();
  }
});
test("schema19 upgrades preserve tasks and failed review writes roll back without consuming revisions", () => {
  const f = fixture();
  try {
    const task = complete(f.store);
    f.store.db.exec("DROP TABLE task_feedback; PRAGMA user_version=19;");
    f.reopen();
    assert.deepEqual(f.store.get(owner, task.id), task);
    assert.equal(f.store.db.pragma("user_version", { simple: true }), 38);
    f.store.db.exec(
      "CREATE TRIGGER feedback_fail BEFORE INSERT ON task_feedback BEGIN SELECT RAISE(FAIL,'fixture'); END;",
    );
    const input = body(f.store, task.id);
    assert.throws(
      () => f.store.taskFeedback.save(owner, task.id, input),
      /fixture/,
    );
    assert.equal(f.store.taskFeedback.read(owner, task.id).reviewRevision, 0);
    f.store.db.exec("DROP TRIGGER feedback_fail");
    const saved = f.store.taskFeedback.save(owner, task.id, input);
    assert.equal(saved.reviewRevision, 1);
    const other = new Store(f.path, f.vault);
    try {
      const stale = body(f.store, task.id);
      other.taskFeedback.save(owner, task.id, body(other, task.id, "rejected"));
      assert.throws(
        () => f.store.taskFeedback.save(owner, task.id, stale),
        /CONFLICT/,
      );
    } finally {
      other.close();
    }
  } finally {
    f.close();
  }
});
test("HTTP feedback enforces source access on read/write/export and rejects deletion during a delayed source check", async () => {
  const f = fixture(),
    server = createServer(),
    token = randomBytes(32).toString("hex");
  let allowed = true,
    barrier: Promise<void> | undefined,
    entered: (() => void) | undefined,
    checks = 0;
  const sources = {
    captureReadBoundary: () => () => {
      if (!allowed) throw new ConnectorError("SOURCE_DENIED");
    },
    validate: async () => {
      checks++;
      entered?.();
      await barrier;
      if (!allowed) throw new ConnectorError("SOURCE_DENIED");
      return {};
    },
  } as unknown as CrmTasks;
  const binding: SourceBinding = {
    authority: {
      ...owner,
      tenantId: "workspace",
      subjectId: "subject",
      deviceId: "mac",
      sourceApp: "crm",
      grantId: "grant",
      policyRevision: "v1",
    },
    refs: [
      {
        app: "crm",
        tenantId: "workspace",
        resourceId: "record",
        revision: "1",
      },
    ],
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    projectionHash: "a".repeat(64),
  };
  const task = complete(f.store, binding);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  server.on(
    "request",
    localApi({ store: f.store, owner, port, token, sources }),
  );
  const path = `/v1/requests/${task.id}/quality-review`;
  const call = (url: string, method = "GET", body?: unknown, auth = true) =>
    fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: "Bearer " + token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const input = body(f.store, task.id);
    assert.equal((await call(path, "PUT", input, false)).status, 401);
    assert.equal(checks, 0);
    assert.equal(
      (await call(path, "PUT", { ...input, owner: { userId: "forged" } }))
        .status,
      400,
    );
    assert.equal((await call(path, "PUT", input)).status, 200);
    const exported = (await (
      await call(`/v1/requests/${task.id}/export`)
    ).json()) as any;
    assert.equal(exported.qualityReview.review.note, "REVIEW_PRIVATE_SENTINEL");
    const bulk = await (await call("/v1/export")).text();
    assert.equal(bulk.includes("REVIEW_PRIVATE_SENTINEL"), false);
    allowed = false;
    for (const response of [
      await call(path),
      await call(path, "PUT", body(f.store, task.id, "edited")),
      await call(`/v1/requests/${task.id}/export`),
    ]) {
      assert.equal(response.status, 400);
      assert.equal(
        (await response.text()).includes("REVIEW_PRIVATE_SENTINEL"),
        false,
      );
    }
    assert.equal(f.store.taskFeedback.read(owner, task.id).reviewRevision, 1);
    allowed = true;
    let release!: () => void;
    barrier = new Promise<void>((r) => {
      release = r;
    });
    const waiting = new Promise<void>((r) => {
      entered = r;
    });
    const pending = call(path, "PUT", body(f.store, task.id, "rejected"));
    await waiting;
    f.store.deleteAll(owner);
    release();
    assert.equal((await pending).status, 404);
    assert.equal(
      (
        f.store.db.prepare("SELECT count(*) n FROM task_feedback").get() as {
          n: number;
        }
      ).n,
      0,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    f.close();
  }
});
