import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../modules/storage/vault.js";
import { ImportJobs } from "../modules/models/jobs.js";
import { createServer } from "node:http";
import { Store } from "../modules/storage/store.js";
import { localApi } from "../apps/companion/http.js";
async function settled(jobs: ImportJobs, id: string) {
  for (let i = 0; i < 100; i++) {
    const job = jobs.get(id);
    if (
      ![
        "selecting",
        "reviewing",
        "downloading",
        "installing",
        "reconciling",
      ].includes(job.state)
    )
      return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Job did not settle");
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ai-import-jobs-"));
  const file = join(root, "source.gguf"),
    data = Buffer.alloc(32);
  data.write("GGUF");
  data.writeUInt32LE(3, 4);
  await writeFile(file, data);
  return {
    root,
    file,
    data,
    vault: new Vault(randomBytes(32)),
    clean: () => rm(root, { recursive: true, force: true }),
  };
}
test("durable import jobs require separate exact reviews, survive restart and delete staged files/history", async () => {
  const f = await fixture();
  let model = "",
    creates = 0,
    downloads = 0;
  const runtime: typeof fetch = async (url, init) => {
    if (init?.method === "HEAD") return new Response(null, { status: 200 });
    const path = new URL(String(url)).pathname;
    if (path === "/api/create") {
      creates++;
      model = JSON.parse(String(init?.body)).model;
      return Response.json({ status: "success" });
    }
    if (path === "/api/tags")
      return Response.json({
        models: [{ name: model, digest: "a".repeat(64), size: 32 }],
      });
    return Response.json({ details: { family: "synthetic" } });
  };
  const revision = "b".repeat(40),
    remote: typeof fetch = async (url) => {
      if (String(url).includes("/api/models/"))
        return Response.json({
          sha: revision,
          cardData: { license: "PUBLIC_LICENSE_SENTINEL" },
          siblings: [{ rfilename: "model.gguf", size: 32 }],
        });
      downloads++;
      return new Response(f.data);
    };
  let jobs = new ImportJobs(
    f.root,
    f.vault,
    async () => [f.file],
    runtime,
    remote,
  );
  try {
    assert.throws(() =>
      jobs.local({
        license: "test",
        promptFormat: "runtime_default",
        paths: ["/etc/passwd"],
      }),
    );
    const started = jobs.huggingface({
      repo: "fixture/model",
      revision,
      files: ["model.gguf"],
      promptFormat: "runtime_default",
    });
    let job = await settled(jobs, started.id);
    assert.equal(job.state, "download_review");
    assert.equal(downloads, 0);
    assert.equal(creates, 0);
    assert.throws(
      () => jobs.download(job.id, "0".repeat(64)),
      /REVIEW_MISMATCH/,
    );
    await jobs.stop();
    assert.equal(
      (await readFile(join(f.root, "jobs.db"))).includes(
        "PUBLIC_LICENSE_SENTINEL",
      ),
      false,
    );
    jobs = new ImportJobs(
      f.root,
      f.vault,
      async () => [f.file],
      runtime,
      remote,
    );
    jobs.download(job.id, job.download!.digest);
    job = await settled(jobs, job.id);
    assert.equal(job.state, "staged");
    assert.equal(downloads, 1);
    assert.equal(creates, 0);
    assert.throws(
      () => jobs.install(job.id, "0".repeat(64)),
      /REVIEW_MISMATCH/,
    );
    jobs.install(job.id, job.review!.reviewDigest);
    assert.throws(
      () => jobs.install(job.id, job.review!.reviewDigest),
      /REVIEW_MISMATCH/,
    );
    job = await settled(jobs, job.id);
    assert.equal(job.state, "installed");
    assert.equal(creates, 1);
    await jobs.remove(job.id);
    assert.deepEqual(jobs.list(), []);
    assert.equal((await readdir(f.root)).includes(job.id), false);
  } finally {
    await jobs.stop();
    await f.clean();
  }
});
test("picker cancellation does not expose paths or raw errors", async () => {
  const f = await fixture();
  let entered!: () => void;
  const waiting = new Promise<void>((r) => {
    entered = r;
  });
  const jobs = new ImportJobs(
    f.root,
    f.vault,
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(Error("PRIVATE_FILE_PATH")),
          { once: true },
        );
        entered();
      }),
  );
  try {
    const job = jobs.local({
      license: "license",
      promptFormat: "runtime_default",
    });
    await waiting;
    assert.throws(
      () => jobs.local({ license: "license", promptFormat: "runtime_default" }),
      /IMPORT_BUSY/,
    );
    await assert.rejects(jobs.remove(job.id), /IMPORT_BUSY/);
    const cancelled = await jobs.cancel(job.id);
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.error, "CANCELLED");
    assert.equal(
      JSON.stringify(jobs.list()).includes("PRIVATE_FILE_PATH"),
      false,
    );
    await jobs.remove(job.id);
  } finally {
    await jobs.stop();
    await f.clean();
  }
});
test("HTTP import controls reject filesystem selectors and unauthenticated approval; local preparation uses the trusted picker", async () => {
  const f = await fixture(),
    jobs = new ImportJobs(f.root, f.vault, async () => [f.file]),
    store = new Store(":memory:", f.vault),
    server = createServer(),
    token = randomBytes(32).toString("hex");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  server.on(
    "request",
    localApi({
      store,
      owner: { userId: "local", tenantId: "personal" },
      port,
      token,
      imports: jobs,
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
  try {
    assert.equal(
      (await call("/v1/imports", "GET", undefined, { Authorization: "" }))
        .status,
      401,
    );
    assert.equal(
      (
        await call("/v1/imports/local", "POST", {
          license: "test",
          promptFormat: "qwen3",
          paths: [f.file],
        })
      ).status,
      400,
    );
    const response = await call("/v1/imports/local", "POST", {
      license: "test",
      promptFormat: "qwen3",
    });
    assert.equal(response.status, 202);
    const { id } = (await response.json()) as any;
    const job = await settled(jobs, id);
    assert.equal(job.state, "staged");
    assert.equal(
      (
        await call(`/v1/imports/${id}/install`, "POST", {
          digest: "0".repeat(64),
        })
      ).status,
      400,
    );
    const text = await (await call("/v1/imports")).text();
    assert.equal(text.includes(f.root), false);
    assert.equal((await call(`/v1/imports/${id}`, "DELETE")).status, 400);
    assert.equal(
      (
        await call(`/v1/imports/${id}`, "DELETE", undefined, {
          "X-Confirm-Delete": "local-import-record-and-files",
        })
      ).status,
      204,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await jobs.stop();
    store.close();
    await f.clean();
  }
});

test("uncertain installation survives restart and repeated reconciliation failures preserve the original model identity", async () => {
  const f = await fixture();
  let model = "",
    online = false,
    creates = 0;
  const runtime: typeof fetch = async (url, init) => {
    if (init?.method === "HEAD") return new Response(null, { status: 200 });
    const path = new URL(String(url)).pathname;
    if (path === "/api/create") {
      creates++;
      model = JSON.parse(String(init?.body)).model;
      throw Error("lost response");
    }
    if (!online) throw Error("private offline detail");
    if (path === "/api/tags")
      return Response.json({
        models: [{ name: model, digest: "a".repeat(64), size: 32 }],
      });
    return Response.json({ details: { family: "synthetic" } });
  };
  let jobs = new ImportJobs(f.root, f.vault, async () => [f.file], runtime);
  try {
    let job = jobs.local({ license: "test", promptFormat: "runtime_default" });
    job = await settled(jobs, job.id);
    jobs.install(job.id, job.review!.reviewDigest);
    job = await settled(jobs, job.id);
    assert.equal(job.state, "uncertain");
    await jobs.stop();
    jobs = new ImportJobs(f.root, f.vault, async () => [f.file], runtime);
    jobs.reconcile(job.id);
    job = await settled(jobs, job.id);
    assert.equal(job.state, "uncertain");
    assert.equal(job.error, "IMPORT_FAILED");
    online = true;
    jobs.reconcile(job.id);
    job = await settled(jobs, job.id);
    assert.equal(job.state, "installed");
    assert.equal(creates, 1);
    assert.equal(job.review!.model, model);
  } finally {
    await jobs.stop();
    await f.clean();
  }
});

test("startup classifies interrupted work without dispatch and rejects a wrong storage key", async () => {
  const { default: Database } = await import("better-sqlite3"),
    f = await fixture();
  let jobs = new ImportJobs(f.root, f.vault, async () => [f.file]);
  try {
    const staged = await settled(
      jobs,
      jobs.local({ license: "private-fixture", promptFormat: "qwen3" }).id,
    );
    await jobs.stop();
    const db = new Database(join(f.root, "jobs.db"));
    db.prepare("UPDATE jobs SET payload=? WHERE id=?").run(
      f.vault.seal(
        { ...staged, state: "installing" },
        "import-job:" + staged.id,
      ),
      staged.id,
    );
    db.close();
    assert.throws(
      () =>
        new ImportJobs(f.root, new Vault(randomBytes(32)), async () => [
          f.file,
        ]),
    );
    let calls = 0;
    jobs = new ImportJobs(
      f.root,
      f.vault,
      async () => {
        calls++;
        return [f.file];
      },
      async () => {
        calls++;
        throw Error("must not dispatch on startup");
      },
    );
    assert.equal(jobs.get(staged.id).state, "uncertain");
    assert.equal(jobs.get(staged.id).error, "INTERRUPTED");
    assert.equal(calls, 0);
  } finally {
    await jobs.stop();
    await f.clean();
  }
});
