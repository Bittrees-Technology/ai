import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  readdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ModelImports } from "../modules/models/imports.js";
import { HuggingFaceDownloads } from "../modules/models/huggingface.js";
const gguf = () => {
  const data = Buffer.alloc(32);
  data.write("GGUF");
  data.writeUInt32LE(3, 4);
  return data;
};
const license = { kind: "local", license: "synthetic fixture" };
function fakeRuntime() {
  let model = "";
  return (async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === "HEAD") return new Response(null, { status: 200 });
    if (path === "/api/create") {
      model = JSON.parse(String(init?.body)).model;
      return new Response(JSON.stringify({ status: "success" }));
    }
    if (path === "/api/tags")
      return new Response(
        JSON.stringify({
          models: [{ name: model, digest: "a".repeat(64), size: 32 }],
        }),
      );
    return new Response(
      JSON.stringify({
        details: { family: "synthetic", quantization_level: "Q4" },
      }),
    );
  }) as typeof fetch;
}
const fakeCreate = fakeRuntime();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ai-import-"));
  const file = join(root, "test.gguf");
  await writeFile(file, gguf());
  return {
    root,
    file,
    clean: () => rm(root, { recursive: true, force: true }),
  };
}
test("review binds files, provenance and expiry; exact staged files reach only loopback", async () => {
  const f = await fixture(),
    calls: { url: string; init: RequestInit | undefined }[] = [];
  let now = 1000;
  const importer = new ModelImports(
    join(f.root, "imports"),
    "http://127.0.0.1:11434",
    async (u, i) => {
      calls.push({ url: String(u), init: i });
      return fakeCreate(u, i);
    },
    () => now,
  );
  try {
    const review = await importer.prepare([f.file], license);
    assert.equal(review.format, "gguf");
    assert.equal(review.capabilities.tools, false);
    assert.equal(
      review.files[0]!.sha256,
      createHash("sha256").update(gguf()).digest("hex"),
    );
    await assert.rejects(
      importer.commit(review.id, "0".repeat(64)),
      /REVIEW_MISMATCH/,
    );
    assert.equal(calls.length, 0);
    await importer.commit(review.id, review.reviewDigest);
    assert.ok(calls.every((c) => new URL(c.url).hostname === "127.0.0.1"));
    const body = JSON.parse(
      String(calls.find((c) => c.url.endsWith("/api/create"))!.init!.body),
    );
    assert.equal(body.model, review.model);
    assert.equal("from" in body, false);
    assert.equal("system" in body, false);
    await assert.rejects(
      importer.commit(review.id, review.reviewDigest),
      /EEXIST/,
    );
    const expired = await importer.prepare([f.file], license);
    now += 16 * 60_000;
    await assert.rejects(
      importer.commit(expired.id, expired.reviewDigest),
      /REVIEW_EXPIRED/,
    );
  } finally {
    await f.clean();
  }
});
test("changed files, symlinks, pickle/code and remote repository hooks are rejected", async () => {
  const f = await fixture(),
    importer = new ModelImports(join(f.root, "imports"));
  try {
    const review = await importer.prepare([f.file], license);
    await writeFile(join(f.root, "imports", review.id, "test.gguf"), "changed");
    await assert.rejects(
      importer.commit(review.id, review.reviewDigest),
      /CHANGED_ARTIFACT/,
    );
    const link = join(f.root, "link.gguf");
    await symlink(f.file, link);
    await assert.rejects(importer.prepare([link], license));
    for (const name of ["weights.pkl", "weights.bin", "model.py"]) {
      const path = join(f.root, name);
      await writeFile(path, "malicious");
      await assert.rejects(importer.prepare([path], license));
    }
    const header = Buffer.from(
      JSON.stringify({ x: { dtype: "F32", shape: [1], data_offsets: [0, 4] } }),
    );
    const tensor = Buffer.alloc(8 + header.length + 4);
    tensor.writeBigUInt64LE(BigInt(header.length));
    header.copy(tensor, 8);
    const tensorPath = join(f.root, "model.safetensors");
    await writeFile(tensorPath, tensor);
    const config = join(f.root, "config.json");
    await writeFile(
      config,
      JSON.stringify({
        model_type: "llama",
        auto_map: { AutoModel: "evil.py" },
      }),
    );
    await assert.rejects(
      importer.prepare([tensorPath, config], license),
      /UNSUPPORTED_FILE/,
    );
    await writeFile(config, JSON.stringify({ model_type: "llama" }));
    assert.equal(
      (await importer.prepare([tensorPath, config], license)).format,
      "safetensors",
    );
  } finally {
    await f.clean();
  }
});
test("cancellation before staging leaves no partial data and memory capacity is checked", async () => {
  const f = await fixture();
  try {
    const importer = new ModelImports(join(f.root, "imports"));
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(importer.prepare([f.file], license, abort.signal));
    assert.deepEqual(await readdir(join(f.root, "imports")), []);
    const small = new ModelImports(
      join(f.root, "small"),
      "http://127.0.0.1:11434",
      fakeCreate,
      Date.now,
      16,
    );
    await assert.rejects(small.prepare([f.file], license), /CAPACITY/);
  } finally {
    await f.clean();
  }
});
test("HF pins revision and hashes, strips credentials on CDN redirect, never sends prompts", async () => {
  const f = await fixture();
  const revision = "a".repeat(40),
    calls: { url: string; init: RequestInit | undefined }[] = [];
  const sha = createHash("sha256").update(gguf()).digest("hex");
  const fetcher: typeof fetch = async (u, i) => {
    const url = String(u);
    calls.push({ url, init: i });
    if (url.includes("/api/models/"))
      return new Response(
        JSON.stringify({
          sha: revision,
          cardData: { license: "apache-2.0" },
          siblings: [
            {
              rfilename: "test.gguf",
              size: 32,
              lfs: { size: 32, sha256: sha },
            },
          ],
        }),
      );
    if (new URL(url).hostname === "huggingface.co")
      return new Response(null, {
        status: 302,
        headers: { location: "https://cdn-lfs-us-1.hf.co/blob" },
      });
    return new Response(gguf());
  };
  try {
    const downloads = new HuggingFaceDownloads(
      join(f.root, "download"),
      new ModelImports(join(f.root, "imports")),
      fetcher,
    );
    const review = await downloads.review(
      "owner/model",
      revision,
      ["test.gguf"],
      "TEST_TOKEN",
    );
    const staged = await downloads.download(
      review,
      review.digest,
      "TEST_TOKEN",
    );
    assert.equal(staged.provenance.kind, "huggingface");
    assert.equal(staged.files[0]?.sha256, sha);
    const cdn = calls.find(
      (c) => new URL(c.url).hostname === "cdn-lfs-us-1.hf.co",
    )!;
    assert.equal(cdn.init?.headers, undefined);
    assert.ok(calls.every((c) => c.init?.body === undefined));
    assert.deepEqual(await readdir(join(f.root, "download")), []);
    await assert.rejects(
      downloads.review("owner/model", "main", ["test.gguf"]),
    );
    await assert.rejects(
      downloads.review("owner/model", revision, ["../secret"]),
    );
  } finally {
    await f.clean();
  }
});
test("HF rejects redirects outside exact approved hosts without following them", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const download = new HuggingFaceDownloads(
      join(f.root, "downloads"),
      new ModelImports(join(f.root, "imports")),
      async () => {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        });
      },
    );
    await assert.rejects(
      download.review("owner/model", "a".repeat(40), ["test.gguf"]),
      /DOWNLOAD_DENIED/,
    );
    assert.equal(calls, 1);
  } finally {
    await f.clean();
  }
});

test("an ambiguous runtime create is reconciled by inspection, never blindly retried", async () => {
  const f = await fixture();
  let creates = 0;
  const runtime = fakeRuntime();
  const importer = new ModelImports(
    join(f.root, "imports"),
    "http://127.0.0.1:11434",
    async (url, init) => {
      const result = await runtime(url, init);
      if (String(url).endsWith("/api/create")) {
        creates++;
        throw new Error("connection lost after acceptance");
      }
      return result;
    },
  );
  try {
    const review = await importer.prepare(
      [f.file],
      license,
      undefined,
      "qwen3",
    );
    await assert.rejects(
      importer.commit(review.id, review.reviewDigest),
      /connection lost/,
    );
    assert.equal(
      (await importer.status(review.id)).state,
      "needs_reconciliation",
    );
    assert.equal((await importer.cancel(review.id)).needsReconciliation, true);
    assert.equal((await importer.reconcile(review.id)).state, "installed");
    assert.equal(creates, 1);
    assert.equal((await importer.status(review.id)).state, "installed");
  } finally {
    await f.clean();
  }
});
test("HF corrupt downloads fail hash verification and remove partial files", async () => {
  const f = await fixture(),
    revision = "a".repeat(40);
  const fetcher: typeof fetch = async (url) =>
    String(url).includes("/api/models/")
      ? new Response(
          JSON.stringify({
            sha: revision,
            cardData: { license: "test" },
            siblings: [
              {
                rfilename: "test.gguf",
                size: 32,
                lfs: { size: 32, sha256: "0".repeat(64) },
              },
            ],
          }),
        )
      : new Response(gguf());
  try {
    const downloader = new HuggingFaceDownloads(
      join(f.root, "download"),
      new ModelImports(join(f.root, "imports")),
      fetcher,
    );
    const review = await downloader.review(
      "owner/abliterated-model",
      revision,
      ["test.gguf"],
    );
    await assert.rejects(
      downloader.download(review, review.digest),
      /CHANGED_ARTIFACT/,
    );
    assert.deepEqual(await readdir(join(f.root, "download")), []);
  } finally {
    await f.clean();
  }
});

test("unsupported runtime architecture is a controlled failure without exposing raw runtime errors", async () => {
  const f = await fixture();
  const importer = new ModelImports(
    join(f.root, "imports"),
    "http://127.0.0.1:11434",
    async (_url, init) =>
      init?.method === "HEAD"
        ? new Response(null, { status: 200 })
        : new Response(
            JSON.stringify({
              error:
                'unsupported architecture "ExampleForCausalLM" private runtime detail',
            }),
            { status: 500 },
          ),
  );
  try {
    const review = await importer.prepare([f.file], license);
    await assert.rejects(importer.commit(review.id, review.reviewDigest), {
      message: "UNSUPPORTED_ARCHITECTURE",
    });
    assert.equal((await importer.status(review.id)).state, "failed");
  } finally {
    await f.clean();
  }
});
