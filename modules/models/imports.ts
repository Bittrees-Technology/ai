import { constants } from "node:fs";
import { totalmem } from "node:os";
import { open, mkdir, rm, statfs, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { z } from "zod";

const maxFileBytes = 16 * 1024 ** 3;
const maxTotalBytes = 24 * 1024 ** 3;
const jsonFiles = new Set([
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "generation_config.json",
  "model.safetensors.index.json",
]);
const fileName = z
  .string()
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)
  .refine(
    (n) =>
      n.endsWith(".gguf") ||
      n.endsWith(".safetensors") ||
      jsonFiles.has(n) ||
      n === "tokenizer.model",
  );
export const provenanceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("local"),
    license: z.string().min(1).max(2000),
  }),
  z.strictObject({
    kind: z.literal("huggingface"),
    license: z.string().min(1).max(2000),
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
  }),
]);
export const promptFormatSchema = z.enum([
  "runtime_default",
  "chatml",
  "qwen3",
  "llama3",
]);
export type PromptFormat = z.infer<typeof promptFormatSchema>;
const promptFormats: Record<
  Exclude<PromptFormat, "runtime_default">,
  { template: string; parameters: { stop: string[] } }
> = {
  chatml: {
    template:
      "<|im_start|>user\n{{ .Prompt }}<|im_end|>\n<|im_start|>assistant\n",
    parameters: { stop: ["<|im_end|>", "<|endoftext|>"] },
  },
  qwen3: {
    template:
      "<|im_start|>user\n{{ .Prompt }}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n",
    parameters: { stop: ["<|im_end|>", "<|endoftext|>"] },
  },
  llama3: {
    template:
      "<|start_header_id|>user<|end_header_id|>\n\n{{ .Prompt }}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n",
    parameters: { stop: ["<|eot_id|>", "<|end_of_text|>"] },
  },
};
export interface ArtifactFile {
  name: string;
  size: number;
  sha256: string;
}
export interface ImportReview {
  id: string;
  model: string;
  format: "gguf" | "safetensors";
  promptFormat: PromptFormat;
  provenance: z.infer<typeof provenanceSchema>;
  files: ArtifactFile[];
  totalBytes: number;
  createdAt: number;
  expiresAt: number;
  reviewDigest: string;
  capabilities: { tools: false; tested: false };
}
export class ImportError extends Error {
  constructor(
    public code:
      | "UNSUPPORTED_FILE"
      | "INVALID_ARTIFACT"
      | "CAPACITY"
      | "CHANGED_ARTIFACT"
      | "REVIEW_EXPIRED"
      | "REVIEW_MISMATCH"
      | "RUNTIME_REJECTED"
      | "UNSUPPORTED_ARCHITECTURE"
      | "DOWNLOAD_DENIED",
  ) {
    super(code);
  }
}
export function reviewHash(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return "[" + item.map(canonical).join(",") + "]";
    if (item && typeof item === "object")
      return (
        "{" +
        Object.entries(item)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
          .join(",") +
        "}"
      );
    return JSON.stringify(item) ?? "null";
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function checkJSON(value: unknown) {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "auto_map" || (key === "trust_remote_code" && item))
      throw new ImportError("UNSUPPORTED_FILE");
    if (typeof item === "object") checkJSON(item);
  }
}
async function validate(path: string, name: string, size: number) {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const header = Buffer.alloc(24);
    const { bytesRead } = await f.read(header, 0, 24, 0);
    if (name.endsWith(".gguf")) {
      if (
        bytesRead < 24 ||
        header.subarray(0, 4).toString() !== "GGUF" ||
        ![2, 3].includes(header.readUInt32LE(4))
      )
        throw new ImportError("INVALID_ARTIFACT");
    } else if (name.endsWith(".safetensors")) {
      if (bytesRead < 8) throw new ImportError("INVALID_ARTIFACT");
      const n = header.readBigUInt64LE(0);
      if (n < 2n || n > 16n * 1024n * 1024n || n + 8n > BigInt(size))
        throw new ImportError("INVALID_ARTIFACT");
      const data = Buffer.alloc(Number(n));
      await f.read(data, 0, data.length, 8);
      const spec = JSON.parse(data.toString("utf8"));
      if (!spec || typeof spec !== "object" || Array.isArray(spec))
        throw new ImportError("INVALID_ARTIFACT");
      for (const [key, tensor] of Object.entries(spec)) {
        if (key === "__metadata__") continue;
        const t = z
          .object({
            dtype: z.string(),
            shape: z.array(z.number().int().nonnegative()),
            data_offsets: z.tuple([
              z.number().int().nonnegative(),
              z.number().int().nonnegative(),
            ]),
          })
          .parse(tensor);
        if (
          t.data_offsets[0] > t.data_offsets[1] ||
          t.data_offsets[1] > size - 8 - Number(n)
        )
          throw new ImportError("INVALID_ARTIFACT");
      }
    } else if (jsonFiles.has(name)) {
      if (size > 32 * 1024 * 1024) throw new ImportError("CAPACITY");
      checkJSON(JSON.parse(await readFile(path, "utf8")));
    } else if (name !== "tokenizer.model" || size > 32 * 1024 * 1024)
      throw new ImportError("UNSUPPORTED_FILE");
  } finally {
    await f.close();
  }
}
async function fingerprint(path: string, signal?: AbortSignal) {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const h = createHash("sha256");
    let size = 0;
    for await (const chunk of f.createReadStream({ autoClose: false })) {
      signal?.throwIfAborted();
      size += chunk.length;
      if (size > maxFileBytes) throw new ImportError("CAPACITY");
      h.update(chunk);
    }
    return { size, sha256: h.digest("hex") };
  } finally {
    await f.close();
  }
}
export class ModelImports {
  private active = new Map<string, AbortController>();
  constructor(
    private directory: string,
    private endpoint = "http://127.0.0.1:11434",
    private fetcher: typeof fetch = fetch,
    private now = Date.now,
    private maxMemoryBytes = Math.floor(totalmem() * 0.6),
  ) {
    const u = new URL(endpoint);
    if (
      u.protocol !== "http:" ||
      u.hostname !== "127.0.0.1" ||
      u.pathname !== "/" ||
      u.search ||
      u.hash ||
      u.username ||
      u.password
    )
      throw new ImportError("DOWNLOAD_DENIED");
  }
  private folder(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new ImportError("REVIEW_MISMATCH");
    return join(this.directory, id);
  }
  /** Trusted desktop file picker supplies these paths. Never expose caller-selected filesystem paths via HTTP. */
  async prepare(
    paths: string[],
    provenance: unknown,
    signal?: AbortSignal,
    promptFormat: PromptFormat = "runtime_default",
  ): Promise<ImportReview> {
    promptFormatSchema.parse(promptFormat);
    const source = provenanceSchema.parse(provenance);
    if (!paths.length || paths.length > 128) throw new ImportError("CAPACITY");
    const names = paths.map((p) => fileName.parse(basename(p)));
    if (new Set(names).size !== names.length)
      throw new ImportError("INVALID_ARTIFACT");
    const gguf = names.some((n) => n.endsWith(".gguf")),
      safetensors = names.some((n) => n.endsWith(".safetensors"));
    if (
      gguf === safetensors ||
      (safetensors && !names.includes("config.json")) ||
      (gguf && names.some((n) => !n.endsWith(".gguf")))
    )
      throw new ImportError("UNSUPPORTED_FILE");
    const id = randomUUID(),
      folder = this.folder(id);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    let total = 0;
    try {
      const files: ArtifactFile[] = [];
      for (let i = 0; i < paths.length; i++) {
        signal?.throwIfAborted();
        const input = await open(
          resolve(paths[i]!),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const stat = await input.stat();
          if (!stat.isFile() || stat.size < 1 || stat.size > maxFileBytes)
            throw new ImportError("CAPACITY");
          total += stat.size;
          if (total > maxTotalBytes || total > this.maxMemoryBytes)
            throw new ImportError("CAPACITY");
          const disk = await statfs(folder);
          if (disk.bavail * disk.bsize < stat.size * 2 + 512 * 1024 * 1024)
            throw new ImportError("CAPACITY");
          const target = join(folder, names[i]!);
          const output = await open(target, "wx", 0o600);
          const digest = createHash("sha256");
          let copied = 0;
          try {
            for await (const chunk of input.createReadStream({
              autoClose: false,
            })) {
              signal?.throwIfAborted();
              copied += chunk.length;
              if (copied > stat.size) throw new ImportError("CHANGED_ARTIFACT");
              digest.update(chunk);
              await output.writeFile(chunk);
            }
            await output.sync();
          } finally {
            await output.close();
          }
          if (copied !== stat.size) throw new ImportError("CHANGED_ARTIFACT");
          await validate(target, names[i]!, copied);
          files.push({
            name: names[i]!,
            size: copied,
            sha256: digest.digest("hex"),
          });
        } finally {
          await input.close();
        }
      }
      if (names.includes("model.safetensors.index.json")) {
        const index = JSON.parse(
          await readFile(join(folder, "model.safetensors.index.json"), "utf8"),
        );
        for (const name of Object.values(index.weight_map ?? {}))
          if (
            typeof name !== "string" ||
            !names.includes(name) ||
            !name.endsWith(".safetensors")
          )
            throw new ImportError("INVALID_ARTIFACT");
      }
      const review = {
        id,
        model: "bittrees-import/" + id + ":latest",
        format: gguf ? ("gguf" as const) : ("safetensors" as const),
        promptFormat,
        provenance: source,
        files,
        totalBytes: total,
        createdAt: this.now(),
        expiresAt: this.now() + 15 * 60_000,
        capabilities: { tools: false as const, tested: false as const },
      };
      const result = { ...review, reviewDigest: reviewHash(review) };
      await writeFile(join(folder, "review.json"), JSON.stringify(result), {
        mode: 0o600,
        flag: "wx",
      });
      return result;
    } catch (error) {
      await rm(folder, { recursive: true, force: true });
      throw error;
    }
  }
  async cancel(id: string) {
    const running = this.active.get(id);
    if (running) {
      running.abort();
      return { needsReconciliation: true };
    }
    try {
      await readFile(join(this.folder(id), "committing"));
      return { needsReconciliation: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rm(this.folder(id), { recursive: true, force: true });
    return { needsReconciliation: false };
  }
  async status(id: string) {
    const folder = this.folder(id);
    const review = JSON.parse(
      await readFile(join(folder, "review.json"), "utf8"),
    ) as ImportReview;
    for (const [file, state] of [
      ["installed.json", "installed"],
      ["failed.json", "failed"],
      ["needs-reconciliation.json", "needs_reconciliation"],
      ["committing", "creating"],
    ] as const) {
      try {
        await readFile(join(folder, file));
        return {
          id,
          model: review.model,
          state,
          expired: review.expiresAt <= this.now(),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return {
      id,
      model: review.model,
      state: "staged",
      expired: review.expiresAt <= this.now(),
    };
  }
  private async inspectInstalled(model: string, signal?: AbortSignal) {
    const tags = await this.fetcher(new URL("/api/tags", this.endpoint), {
      redirect: "error",
      signal,
    });
    if (!tags.ok) throw new ImportError("RUNTIME_REJECTED");
    const listed = z
      .object({
        models: z.array(
          z.object({
            name: z.string(),
            digest: z.string().regex(/^[a-f0-9]{64}$/),
            size: z.number().positive(),
          }),
        ),
      })
      .parse(await boundedJSON(tags));
    const found = listed.models.find((m) => m.name === model);
    if (!found) throw new ImportError("RUNTIME_REJECTED");
    const show = await this.fetcher(new URL("/api/show", this.endpoint), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
      redirect: "error",
      signal,
    });
    if (!show.ok) throw new ImportError("RUNTIME_REJECTED");
    const info = z
      .object({
        remote_model: z.string().optional(),
        remote_host: z.string().optional(),
        details: z
          .object({
            family: z.string().max(128).optional(),
            quantization_level: z.string().max(128).optional(),
            parameter_size: z.string().max(128).optional(),
          })
          .optional(),
      })
      .parse(await boundedJSON(show));
    if (info.remote_model || info.remote_host)
      throw new ImportError("RUNTIME_REJECTED");
    return {
      runtime: "ollama",
      modelDigest: found.digest,
      architecture: info.details?.family ?? "unknown",
      quantization: info.details?.quantization_level ?? "unknown",
      parameterSize: info.details?.parameter_size ?? "unknown",
      installedBytes: found.size,
    };
  }
  async reconcile(id: string, signal?: AbortSignal) {
    const folder = this.folder(id);
    const review = JSON.parse(
      await readFile(join(folder, "review.json"), "utf8"),
    ) as ImportReview;
    await readFile(join(folder, "committing"));
    if (this.active.has(id)) return { state: "creating" as const };
    const metadata = await this.inspectInstalled(review.model, signal);
    await writeFile(
      join(folder, "installed.json"),
      JSON.stringify({
        model: review.model,
        reviewDigest: review.reviewDigest,
        installedAt: this.now(),
        ...metadata,
      }),
      { mode: 0o600 },
    );
    return { state: "installed" as const, ...metadata };
  }
  async commit(id: string, reviewDigest: string, signal?: AbortSignal) {
    const folder = this.folder(id);
    const review = JSON.parse(
      await readFile(join(folder, "review.json"), "utf8"),
    ) as ImportReview;
    const { reviewDigest: stored, ...rest } = review;
    if (stored !== reviewDigest || stored !== reviewHash(rest))
      throw new ImportError("REVIEW_MISMATCH");
    if (review.expiresAt <= this.now()) throw new ImportError("REVIEW_EXPIRED");
    const abort = new AbortController();
    const requestSignal = AbortSignal.any([
      abort.signal,
      AbortSignal.timeout(30 * 60_000),
      ...(signal ? [signal] : []),
    ]);
    const files: Record<string, string> = {};
    for (const file of review.files) {
      const path = join(folder, fileName.parse(file.name));
      const actual = await fingerprint(path, requestSignal);
      if (actual.size !== file.size || actual.sha256 !== file.sha256)
        throw new ImportError("CHANGED_ARTIFACT");
      files[file.name] = "sha256:" + file.sha256;
    }
    // Reserve this import exactly once. On ambiguous runtime completion, inspect this unique model name before retrying.
    const lock = await open(join(folder, "committing"), "wx", 0o600);
    await lock.close();
    this.active.set(id, abort);
    try {
      for (const file of review.files) {
        requestSignal.throwIfAborted();
        const url = new URL("/api/blobs/sha256:" + file.sha256, this.endpoint);
        const existing = await this.fetcher(url, {
          method: "HEAD",
          redirect: "error",
          signal: requestSignal,
        });
        await existing.body?.cancel();
        if (existing.status === 200) continue;
        if (existing.status !== 404) throw new ImportError("RUNTIME_REJECTED");
        const handle = await open(
          join(folder, file.name),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const body = handle.createReadStream({ autoClose: false });
          const init = {
            method: "POST",
            body,
            duplex: "half",
            redirect: "error",
            signal: requestSignal,
          } as unknown as RequestInit;
          const uploaded = await this.fetcher(url, init);
          await uploaded.body?.cancel();
          if (uploaded.status !== 201 && uploaded.status !== 200)
            throw new ImportError("RUNTIME_REJECTED");
        } finally {
          await handle.close();
        }
      }
      const response = await this.fetcher(
        new URL("/api/create", this.endpoint),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: review.model,
            files,
            license: review.provenance.license,
            stream: false,
            ...(review.promptFormat === "runtime_default"
              ? {}
              : promptFormats[
                  promptFormatSchema.parse(review.promptFormat) as Exclude<
                    PromptFormat,
                    "runtime_default"
                  >
                ]),
          }),
          redirect: "error",
          signal: requestSignal,
        },
      );
      const result = await boundedJSON(response);
      if (
        !response.ok &&
        result &&
        typeof result === "object" &&
        typeof (result as { error?: unknown }).error === "string" &&
        /^unsupported architecture\b/i.test((result as { error: string }).error)
      )
        throw new ImportError("UNSUPPORTED_ARCHITECTURE");
      if (
        !response.ok ||
        !result ||
        typeof result !== "object" ||
        (result as { status?: string }).status !== "success"
      )
        throw new ImportError("RUNTIME_REJECTED");
      const metadata = await this.inspectInstalled(review.model, requestSignal);
      await writeFile(
        join(folder, "installed.json"),
        JSON.stringify({
          model: review.model,
          reviewDigest,
          installedAt: this.now(),
          ...metadata,
        }),
        { flag: "wx", mode: 0o600 },
      );
      return { ...review, ...metadata };
    } catch (error) {
      await writeFile(
        join(
          folder,
          error instanceof ImportError &&
            error.code === "UNSUPPORTED_ARCHITECTURE"
            ? "failed.json"
            : "needs-reconciliation.json",
        ),
        JSON.stringify({
          model: review.model,
          ...(error instanceof ImportError ? { code: error.code } : {}),
        }),
        { mode: 0o600 },
      );
      throw error;
    } finally {
      this.active.delete(id);
    }
  }
}
export async function boundedJSON(response: Response) {
  if (!response.body) throw new ImportError("DOWNLOAD_DENIED");
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 2 * 1024 * 1024) throw new ImportError("CAPACITY");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
