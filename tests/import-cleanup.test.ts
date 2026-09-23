import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  rm,
  symlink,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Vault } from "../modules/storage/vault.js";
import { Store } from "../modules/storage/store.js";
import { ImportJobs, type ImportJob } from "../modules/models/jobs.js";
import { localApi } from "../apps/companion/http.js";

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("Condition not reached");
}
async function absent(path: string) {
  try {
    await stat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ai-cleanup-"));
  const file = join(root, "original.gguf"),
    data = Buffer.alloc(32);
  data.write("GGUF");
  data.writeUInt32LE(3, 4);
  await writeFile(file, data);
  const vault = new Vault(randomBytes(32));
  let model = "";
  const calls: string[] = [];
  const runtime: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (init?.method === "HEAD") return new Response(null, { status: 200 });
    if (path === "/api/create") {
      model = JSON.parse(String(init?.body)).model;
      return Response.json({ status: "success" });
    }
    if (path === "/api/tags")
      return Response.json({
        models: [{ name: model, digest: "a".repeat(64), size: 32 }],
      });
    if (path === "/api/show")
      return Response.json({ details: { family: "synthetic" } });
    throw Error("Unexpected runtime call");
  };
  return { root, file, data, vault, runtime, calls };
}
async function staged(jobs: ImportJobs) {
  const job = jobs.local({
    license: "SYNTHETIC_LICENSE",
    promptFormat: "runtime_default",
  });
  await until(() => jobs.get(job.id).state === "staged");
  return jobs.get(job.id);
}
function replace(root: string, vault: Vault, job: ImportJob) {
  const db = new Database(join(root, "jobs.db"));
  try {
    db.prepare("INSERT OR REPLACE INTO jobs VALUES(?,?)").run(
      job.id,
      vault.seal(job, "import-job:" + job.id),
    );
  } finally {
    db.close();
  }
}

test("a failed cleanup intent write never removes staging or obscures a confirmed installation", async () => {
  const f = await fixture();
  let removals = 0;
  const runtime: typeof fetch = async (url, init) => {
    const response = await f.runtime(url, init);
    if (new URL(String(url)).pathname === "/api/show") {
      const db = new Database(join(f.root, "jobs.db"));
      db.exec(`CREATE TABLE cleanup_writes(n INTEGER); INSERT INTO cleanup_writes VALUES(0);
        CREATE TRIGGER block_cleanup BEFORE UPDATE ON jobs WHEN (SELECT n FROM cleanup_writes)>0 BEGIN SELECT RAISE(FAIL,'fixture intent failure'); END;
        CREATE TRIGGER count_outcome AFTER UPDATE ON jobs BEGIN UPDATE cleanup_writes SET n=n+1; END;`);
      db.close();
    }
    return response;
  };
  let jobs = new ImportJobs(
    f.root,
    f.vault,
    async () => [f.file],
    runtime,
    fetch,
    async (path) => {
      removals++;
      await rm(path, { recursive: true, force: true });
    },
  );
  try {
    const job = await staged(jobs);
    jobs.install(job.id, job.review!.reviewDigest);
    await until(() => jobs.get(job.id).state === "installed");
    await jobs.shutdown().catch(() => {});
    assert.equal(removals, 0);
    assert.equal(await absent(join(f.root, job.id)), false);
    assert.equal(jobs.get(job.id).installation?.modelDigest, "a".repeat(64));
    assert.equal(jobs.get(job.id).stagingCleanup, undefined);
    jobs.close();
    const db = new Database(join(f.root, "jobs.db"));
    db.exec("DROP TRIGGER block_cleanup; DROP TRIGGER count_outcome;");
    db.close();
    const calls = f.calls.length;
    jobs = new ImportJobs(f.root, f.vault, async () => [f.file], f.runtime);
    await jobs.maintain();
    assert.equal(jobs.get(job.id).stagingCleanup?.state, "released");
    assert.equal(f.calls.length, calls);
    assert.deepEqual(await readFile(f.file), f.data);
  } finally {
    await jobs.stop();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("confirmed import cleanup preserves original files, symlink targets, encrypted provenance and installed outcome across restart", async () => {
  const f = await fixture();
  let jobs = new ImportJobs(f.root, f.vault, async () => [f.file], f.runtime);
  try {
    let job = await staged(jobs);
    const review = structuredClone(job.review);
    await symlink(f.file, join(f.root, job.id, "original-link"));
    jobs.install(job.id, job.review!.reviewDigest);
    await until(() => jobs.get(job.id).stagingCleanup?.state === "released");
    job = jobs.get(job.id);
    assert.equal(job.state, "installed");
    assert.equal(await absent(join(f.root, job.id)), true);
    assert.deepEqual(await readFile(f.file), f.data);
    assert.deepEqual(job.review, review);
    assert.equal(job.installation?.modelDigest, "a".repeat(64));
    const calls = f.calls.length;
    await jobs.stop();
    assert.equal(
      (await readFile(join(f.root, "jobs.db"))).includes("SYNTHETIC_LICENSE"),
      false,
    );
    jobs = new ImportJobs(
      f.root,
      f.vault,
      async () => {
        throw Error("must not pick");
      },
      f.runtime,
    );
    await jobs.maintain();
    assert.deepEqual(jobs.get(job.id), job);
    assert.equal(f.calls.length, calls);
    assert.equal(f.calls.filter((p) => p === "/api/create").length, 1);
  } finally {
    await jobs.stop();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("cleanup failure is separate from installation and retries serialize with imports and shutdown", async () => {
  const f = await fixture();
  let fail = true,
    entered!: () => void,
    release!: () => void;
  const waiting = new Promise<void>((r) => {
    entered = r;
  });
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  const jobs = new ImportJobs(
    f.root,
    f.vault,
    async () => [f.file],
    f.runtime,
    fetch,
    async (path) => {
      if (fail) throw Error("PRIVATE_FILESYSTEM_DETAIL");
      entered();
      await blocked;
      await rm(path, { recursive: true, force: true });
    },
  );
  try {
    const job = await staged(jobs);
    jobs.install(job.id, job.review!.reviewDigest);
    await until(() => jobs.get(job.id).stagingCleanup?.state === "retry");
    assert.equal(jobs.get(job.id).state, "installed");
    assert.equal(
      JSON.stringify(jobs.list()).includes("PRIVATE_FILESYSTEM_DETAIL"),
      false,
    );
    assert.equal(await absent(join(f.root, job.id)), false);
    const calls = f.calls.length;
    fail = false;
    const cleanup = jobs.cleanup(job.id);
    await waiting;
    assert.throws(
      () => jobs.local({ license: "test", promptFormat: "runtime_default" }),
      /IMPORT_BUSY/,
    );
    await assert.rejects(jobs.remove(job.id), /IMPORT_BUSY/);
    await assert.rejects(jobs.cleanup(job.id), /IMPORT_BUSY/);
    await jobs.maintain();
    let stopped = false;
    const stop = jobs.shutdown().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    assert.equal(stopped, false);
    release();
    await cleanup;
    await stop;
    assert.equal(jobs.get(job.id).stagingCleanup?.state, "released");
    assert.equal(jobs.get(job.id).state, "installed");
    assert.equal(f.calls.length, calls);
    assert.deepEqual(await readFile(f.file), f.data);
  } finally {
    release();
    await jobs.stop();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("interrupted cleanup resumes after a failed completion write without repeating runtime work", async () => {
  const f = await fixture();
  let removed!: () => void;
  const removal = new Promise<void>((r) => {
    removed = r;
  });
  let jobs = new ImportJobs(
    f.root,
    f.vault,
    async () => [f.file],
    f.runtime,
    fetch,
    async (path) => {
      await rm(path, { recursive: true, force: true });
      const db = new Database(join(f.root, "jobs.db"));
      db.exec(
        "CREATE TRIGGER fail_cleanup_write BEFORE UPDATE ON jobs BEGIN SELECT RAISE(FAIL,'fixture'); END;",
      );
      db.close();
      removed();
    },
  );
  try {
    const job = await staged(jobs);
    jobs.install(job.id, job.review!.reviewDigest);
    await removal;
    await jobs.shutdown().catch(() => {});
    assert.equal(jobs.get(job.id).state, "installed");
    assert.equal(jobs.get(job.id).stagingCleanup?.state, "pending");
    assert.equal(await absent(join(f.root, job.id)), true);
    jobs.close();
    const db = new Database(join(f.root, "jobs.db"));
    db.exec("DROP TRIGGER fail_cleanup_write");
    db.close();
    const calls = f.calls.length;
    jobs = new ImportJobs(f.root, f.vault, async () => [f.file], f.runtime);
    await jobs.maintain();
    assert.equal(jobs.get(job.id).state, "installed");
    assert.equal(jobs.get(job.id).stagingCleanup?.state, "released");
    assert.equal(f.calls.length, calls);
    assert.deepEqual(await readFile(f.file), f.data);
  } finally {
    await jobs.stop();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("idle recovery cleans only terminal or expired jobs, preserving uncertain installations, live reviews and unrelated directories", async () => {
  const f = await fixture();
  let jobs = new ImportJobs(f.root, f.vault, async () => [f.file], f.runtime);
  try {
    const template = await staged(jobs);
    await jobs.stop();
    const specs = [
      ["installing", false],
      ["uncertain", false],
      ["staged", false],
      ["downloading", true],
      ["failed", true],
      ["cancelled", true],
      ["staged", true],
      ["download_review", false],
      ["download_review", true],
    ] as const;
    const cases: { id: string; clean: boolean }[] = [];
    for (const [state, clean] of specs) {
      const id = randomUUID();
      const job: ImportJob = {
        ...template,
        id,
        state,
        review: {
          ...template.review!,
          expiresAt:
            state === "staged" && clean ? Date.now() - 1 : Date.now() + 60000,
        },
        ...(state === "download_review"
          ? {
              download: {
                repo: "fixture/model",
                revision: "b".repeat(40),
                promptFormat: "runtime_default" as const,
                license: "synthetic",
                files: [{ name: "model.gguf", size: 32 }],
                expiresAt: clean ? Date.now() - 1 : Date.now() + 60000,
                digest: "c".repeat(64),
              },
            }
          : {}),
      };
      replace(f.root, f.vault, job);
      await mkdir(join(f.root, id));
      await writeFile(join(f.root, id, "copy"), "temporary");
      cases.push({ id, clean });
    }
    const unrelated = join(f.root, "untracked-import");
    await mkdir(unrelated);
    await writeFile(join(unrelated, "keep"), "keep");
    const calls = f.calls.length;
    jobs = new ImportJobs(
      f.root,
      f.vault,
      async () => {
        throw Error("must not pick");
      },
      f.runtime,
    );
    await jobs.maintain();
    for (const { id, clean } of cases) {
      assert.equal(await absent(join(f.root, id)), clean);
      assert.equal(
        jobs.get(id).stagingCleanup?.state,
        clean ? "released" : undefined,
      );
      if (!clean) await assert.rejects(jobs.cleanup(id), /REVIEW_MISMATCH/);
    }
    assert.equal(await readFile(join(unrelated, "keep"), "utf8"), "keep");
    assert.equal(f.calls.length, calls);
    assert.equal(jobs.list().length, cases.length + 1);
    assert.deepEqual(await readFile(f.file), f.data);
  } finally {
    await jobs.stop();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("authenticated cleanup rejects caller paths and live reviews, then releases cancelled files without deleting history", async () => {
  const f = await fixture(),
    jobs = new ImportJobs(f.root, f.vault, async () => [f.file], f.runtime),
    store = new Store(":memory:", f.vault),
    server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port,
    token = randomBytes(32).toString("hex");
  server.on(
    "request",
    localApi({
      store,
      owner: { userId: "fixture", tenantId: "personal" },
      port,
      token,
      imports: jobs,
    }),
  );
  const call = (id: string, body: unknown = {}, auth = true) =>
    fetch(`http://127.0.0.1:${port}/v1/imports/${id}/cleanup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: "Bearer " + token } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    const job = await staged(jobs);
    assert.equal((await call(job.id, {}, false)).status, 401);
    assert.equal((await call(job.id, { path: f.file })).status, 400);
    assert.equal((await call(job.id)).status, 400);
    assert.equal(await absent(join(f.root, job.id)), false);
    await jobs.cancel(job.id);
    const response = await call(job.id);
    assert.equal(response.status, 200);
    assert.equal(
      ((await response.json()) as ImportJob).stagingCleanup?.state,
      "released",
    );
    assert.equal(jobs.list().length, 1);
    assert.equal(await absent(join(f.root, job.id)), true);
    assert.deepEqual(await readFile(f.file), f.data);
    assert.equal(f.calls.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await jobs.stop();
    store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
