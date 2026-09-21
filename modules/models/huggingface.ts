import { z } from "zod";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, rm, statfs } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  ImportError,
  ModelImports,
  boundedJSON,
  reviewHash,
  promptFormatSchema,
  type PromptFormat,
} from "./imports.js";
const repoSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/);
const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const filenameSchema = z
  .string()
  .max(300)
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/);
const extraNames = new Set([
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "generation_config.json",
  "model.safetensors.index.json",
  "tokenizer.model",
]);
const fileSchema = z.strictObject({
  name: filenameSchema,
  size: z
    .number()
    .int()
    .positive()
    .max(16 * 1024 ** 3),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
const planSchema = z.strictObject({
  repo: repoSchema,
  revision: revisionSchema,
  license: z.string().min(1).max(2000),
  files: z.array(fileSchema).min(1).max(128),
  promptFormat: promptFormatSchema,
  expiresAt: z.number().int().positive(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type DownloadReview = z.infer<typeof planSchema>;
const hosts = new Set([
  "huggingface.co",
  "cas-server.xethub.hf.co",
  "cas-server.xethub-eu.hf.co",
  "transfer.xethub.hf.co",
  "transfer.xethub-eu.hf.co",
  "us.aws.cdn.hf.co",
  "us.gcp.cdn.hf.co",
  "cdn-lfs-us-1.hf.co",
  "cdn-lfs-eu-1.hf.co",
  "cas-bridge.xethub.hf.co",
]);
const digest = reviewHash;
export class HuggingFaceDownloads {
  constructor(
    private directory: string,
    private imports: ModelImports,
    private fetcher: typeof fetch = fetch,
    private now = Date.now,
  ) {}
  private async get(url: URL, token?: string, signal?: AbortSignal) {
    for (let redirects = 0; redirects < 5; redirects++) {
      if (
        url.protocol !== "https:" ||
        (url.port && url.port !== "443") ||
        url.username ||
        url.password ||
        !hosts.has(url.hostname)
      )
        throw new ImportError("DOWNLOAD_DENIED");
      const response = await this.fetcher(url, {
        redirect: "manual",
        signal,
        headers:
          url.hostname === "huggingface.co" && token
            ? { Authorization: "Bearer " + token }
            : undefined,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new ImportError("DOWNLOAD_DENIED");
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ImportError("DOWNLOAD_DENIED");
      }
      return response;
    }
    throw new ImportError("DOWNLOAD_DENIED");
  }
  async review(
    repo: string,
    revision: string,
    names: string[],
    token?: string,
    signal?: AbortSignal,
    promptFormat: PromptFormat = "runtime_default",
  ): Promise<DownloadReview> {
    promptFormatSchema.parse(promptFormat);
    signal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(signal ? [signal] : []),
    ]);
    repoSchema.parse(repo);
    revisionSchema.parse(revision);
    if (
      !names.length ||
      names.length > 128 ||
      new Set(names.map((n) => basename(n))).size !== names.length
    )
      throw new ImportError("UNSUPPORTED_FILE");
    for (const name of names) {
      filenameSchema.parse(name);
      if (
        !name.endsWith(".gguf") &&
        !name.endsWith(".safetensors") &&
        !extraNames.has(basename(name))
      )
        throw new ImportError("UNSUPPORTED_FILE");
    }
    const data = z
      .object({
        sha: revisionSchema,
        cardData: z.object({ license: z.string() }).optional(),
        siblings: z
          .array(
            z.object({
              rfilename: z.string(),
              size: z.number().optional(),
              lfs: z
                .object({ sha256: z.string(), size: z.number() })
                .optional(),
            }),
          )
          .max(10000),
      })
      .parse(
        await boundedJSON(
          await this.get(
            new URL(
              `https://huggingface.co/api/models/${repo}/revision/${revision}?blobs=true`,
            ),
            token,
            signal,
          ),
        ),
      );
    if (data.sha !== revision) throw new ImportError("CHANGED_ARTIFACT");
    const files = names.map((name) => {
      const f = data.siblings.find((s) => s.rfilename === name);
      if (!f) throw new ImportError("UNSUPPORTED_FILE");
      return fileSchema.parse({
        name,
        size: f.lfs?.size ?? f.size,
        ...(f.lfs ? { sha256: f.lfs.sha256 } : {}),
      });
    });
    if (files.reduce((n, f) => n + f.size, 0) > 24 * 1024 ** 3)
      throw new ImportError("CAPACITY");
    const review = {
      repo,
      revision,
      promptFormat,
      license:
        data.cardData?.license ??
        "not specified — review the repository license before installing",
      files,
      expiresAt: this.now() + 15 * 60_000,
    };
    return { ...review, digest: digest(review) };
  }
  async download(
    raw: unknown,
    approvedDigest: string,
    token?: string,
    signal?: AbortSignal,
  ) {
    const plan = planSchema.parse(raw),
      { digest: stored, ...body } = plan;
    if (stored !== approvedDigest || stored !== digest(body))
      throw new ImportError("REVIEW_MISMATCH");
    if (plan.expiresAt <= this.now()) throw new ImportError("REVIEW_EXPIRED");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(this.directory, "download-"));
    const bounded = AbortSignal.any([
      AbortSignal.timeout(30 * 60_000),
      ...(signal ? [signal] : []),
    ]);
    try {
      const total = plan.files.reduce((n, f) => n + f.size, 0),
        disk = await statfs(directory);
      if (disk.bavail * disk.bsize < total * 3 + 512 * 1024 * 1024)
        throw new ImportError("CAPACITY");
      const paths: string[] = [];
      for (const file of plan.files) {
        bounded.throwIfAborted();
        const response = await this.get(
          new URL(
            `https://huggingface.co/${plan.repo}/resolve/${plan.revision}/${file.name.split("/").map(encodeURIComponent).join("/")}`,
          ),
          token,
          bounded,
        );
        if (!response.body) throw new ImportError("DOWNLOAD_DENIED");
        const path = join(directory, basename(file.name)),
          output = await open(path, "wx", 0o600);
        const hash = createHash("sha256");
        let size = 0;
        const reader = response.body.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            bounded.throwIfAborted();
            size += value.length;
            if (size > file.size) throw new ImportError("CHANGED_ARTIFACT");
            hash.update(value);
            await output.writeFile(value);
          }
          await output.sync();
        } finally {
          await reader.cancel();
          await output.close();
        }
        if (
          size !== file.size ||
          (file.sha256 && hash.digest("hex") !== file.sha256)
        )
          throw new ImportError("CHANGED_ARTIFACT");
        paths.push(path);
      }
      return await this.imports.prepare(
        paths,
        {
          kind: "huggingface",
          repo: plan.repo,
          revision: plan.revision,
          license: plan.license,
        },
        bounded,
        plan.promptFormat,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
