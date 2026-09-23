import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { z } from "zod";
import { Vault } from "../storage/vault.js";
import {
  ImportError,
  ModelImports,
  promptFormatSchema,
  type ImportReview,
} from "./imports.js";
import { HuggingFaceDownloads, type DownloadReview } from "./huggingface.js";
const localSchema = z.strictObject({
  license: z.string().min(1).max(2000),
  promptFormat: promptFormatSchema,
});
const hfSchema = z.strictObject({
  repo: z.string().min(3).max(200),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  files: z.array(z.string().min(1).max(300)).min(1).max(128),
  promptFormat: promptFormatSchema,
});
type State =
  | "selecting"
  | "reviewing"
  | "download_review"
  | "downloading"
  | "staged"
  | "reconciling"
  | "installing"
  | "installed"
  | "cancelled"
  | "interrupted"
  | "uncertain"
  | "failed";
export interface ImportJob {
  id: string;
  state: State;
  createdAt: string;
  download?: DownloadReview;
  review?: ImportReview;
  error?: string;
  stagingCleanup?: {
    state: "pending" | "released" | "retry";
    updatedAt: number;
  };
  installation?: {
    modelDigest: string;
    architecture: string;
    quantization: string;
    parameterSize: string;
    installedBytes: number;
  };
}
/** Single personal-device coordinator. Only the trusted picker may supply local paths. */
export class ImportJobs {
  private db: Database.Database;
  private active = new Map<
    string,
    { abort: AbortController; done: Promise<void> }
  >();
  private stopped = false;
  private ready = false;
  constructor(
    private root: string,
    private vault: Vault,
    private picker: (signal: AbortSignal) => Promise<string[]>,
    private runtimeFetch: typeof fetch = fetch,
    private downloadFetch: typeof fetch = fetch,
    private removeStaging: (path: string) => Promise<void> = (path) =>
      rm(path, { recursive: true, force: true }),
  ) {
    this.db = new Database(join(root, "jobs.db"));
    try {
      if ((this.db.pragma("user_version", { simple: true }) as number) > 1)
        throw new Error("Unsupported import database version");
      this.db.pragma("journal_mode=WAL");
      this.db.pragma("secure_delete=ON");
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,payload BLOB NOT NULL)",
      );
      this.db.pragma("user_version=1");
      for (const job of this.list())
        if (
          [
            "selecting",
            "reviewing",
            "downloading",
            "installing",
            "reconciling",
          ].includes(job.state)
        ) {
          this.save({
            ...job,
            state: ["installing", "reconciling"].includes(job.state)
              ? "uncertain"
              : "interrupted",
            error: "INTERRUPTED",
          });
        }
      this.ready = true;
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private importer(id: string) {
    return new ModelImports(
      join(this.root, id, "artifacts"),
      "http://127.0.0.1:11434",
      this.runtimeFetch,
    );
  }
  private downloader(id: string) {
    return new HuggingFaceDownloads(
      join(this.root, id, "downloads"),
      this.importer(id),
      this.downloadFetch,
    );
  }
  private save(job: ImportJob) {
    this.db
      .prepare(
        "INSERT INTO jobs(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(job.id, this.vault.seal(job, "import-job:" + job.id));
    return job;
  }
  get(id: string) {
    z.uuid().parse(id);
    const row = this.db
      .prepare("SELECT payload FROM jobs WHERE id=?")
      .get(id) as { payload: Buffer } | undefined;
    if (!row) throw new ImportError("REVIEW_MISMATCH");
    const job = this.vault.open<ImportJob>(row.payload, "import-job:" + id);
    // If saving an outcome failed, never present a dead operation as still running or
    // let cancel erase uncertainty about a runtime request that may have committed.
    if (
      this.ready &&
      !this.active.has(id) &&
      [
        "selecting",
        "reviewing",
        "downloading",
        "installing",
        "reconciling",
      ].includes(job.state)
    ) {
      return {
        ...job,
        state: (["installing", "reconciling"].includes(job.state)
          ? "uncertain"
          : "interrupted") as State,
        error: "INTERRUPTED",
      };
    }
    return job;
  }
  list(): ImportJob[] {
    return (
      this.db.prepare("SELECT id FROM jobs ORDER BY rowid DESC").all() as {
        id: string;
      }[]
    ).map((row) => this.get(row.id));
  }
  private begin(state: State) {
    if (this.stopped || this.active.size) throw new ImportError("IMPORT_BUSY");
    if (this.list().length >= 100) throw new ImportError("CAPACITY");
    return this.save({
      id: randomUUID(),
      state,
      createdAt: new Date().toISOString(),
    });
  }
  private launch(
    job: ImportJob,
    fn: (signal: AbortSignal) => Promise<ImportJob>,
  ) {
    if (this.stopped || this.active.size) throw new ImportError("IMPORT_BUSY");
    const abort = new AbortController();
    // Reserve synchronously before any asynchronous picker, download or runtime request.
    const done = Promise.resolve().then(async () => {
      try {
        try {
          this.save(await fn(abort.signal));
        } catch (error) {
          this.save({
            ...this.get(job.id),
            state: ["installing", "reconciling", "uncertain"].includes(
              job.state,
            )
              ? "uncertain"
              : abort.signal.aborted ||
                  (error instanceof Error && error.name === "AbortError")
                ? "cancelled"
                : "failed",
            error:
              abort.signal.aborted ||
              (error instanceof Error && error.name === "AbortError")
                ? "CANCELLED"
                : error instanceof ImportError
                  ? error.code
                  : "IMPORT_FAILED",
          });
        }
        // Persist the operation outcome before touching temporary files. A cleanup
        // failure must never turn a confirmed installation into an uncertain one.
        const outcome = this.get(job.id);
        if (this.cleanupEligible(outcome)) await this.releaseFiles(outcome);
      } finally {
        this.active.delete(job.id);
      }
    });
    // Persistence failure leaves the durable in-progress state for restart recovery.
    // Attach a handler immediately; shutdown still observes the original rejection.
    void done.catch(() => {});
    this.active.set(job.id, { abort, done });
    return job;
  }
  local(raw: unknown) {
    const input = localSchema.parse(raw),
      job = this.begin("selecting");
    return this.launch(job, async (signal) => {
      const paths = await this.picker(signal);
      signal.throwIfAborted();
      const review = await this.importer(job.id).prepare(
        paths,
        { kind: "local", license: input.license },
        signal,
        input.promptFormat,
      );
      return { ...job, state: "staged", review };
    });
  }
  huggingface(raw: unknown) {
    const input = hfSchema.parse(raw),
      job = this.begin("reviewing");
    return this.launch(job, async (signal) => ({
      ...job,
      state: "download_review",
      download: await this.downloader(job.id).review(
        input.repo,
        input.revision,
        input.files,
        undefined,
        signal,
        input.promptFormat,
      ),
    }));
  }
  download(id: string, digest: string) {
    const job = this.get(id);
    if (
      job.state !== "download_review" ||
      !job.download ||
      job.download.digest !== digest
    )
      throw new ImportError("REVIEW_MISMATCH");
    if (this.active.size || this.stopped) throw new ImportError("IMPORT_BUSY");
    const next = this.save({ ...job, state: "downloading" });
    return this.launch(next, async (signal) => ({
      ...next,
      state: "staged",
      review: await this.downloader(id).download(
        job.download,
        digest,
        undefined,
        signal,
      ),
    }));
  }
  install(id: string, digest: string) {
    const job = this.get(id);
    if (
      job.state !== "staged" ||
      !job.review ||
      job.review.reviewDigest !== digest
    )
      throw new ImportError("REVIEW_MISMATCH");
    if (this.active.size || this.stopped) throw new ImportError("IMPORT_BUSY");
    const next = this.save({ ...job, state: "installing" });
    return this.launch(next, async (signal) => {
      const {
        modelDigest,
        architecture,
        quantization,
        parameterSize,
        installedBytes,
      } = await this.importer(id).commit(job.review!.id, digest, signal);
      return {
        ...next,
        state: "installed",
        installation: {
          modelDigest,
          architecture,
          quantization,
          parameterSize,
          installedBytes,
        },
      };
    });
  }
  reconcile(id: string) {
    const job = this.get(id);
    if (job.state !== "uncertain" || !job.review)
      throw new ImportError("REVIEW_MISMATCH");
    if (this.active.size || this.stopped) throw new ImportError("IMPORT_BUSY");
    const next = this.save({ ...job, state: "reconciling" });
    return this.launch(next, async (signal) => {
      const result = await this.importer(id).reconcile(
        job.review!.id,
        AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      );
      if (result.state !== "installed") throw new ImportError("IMPORT_BUSY");
      const {
        modelDigest,
        architecture,
        quantization,
        parameterSize,
        installedBytes,
      } = result;
      return {
        ...job,
        state: "installed",
        error: undefined,
        installation: {
          modelDigest,
          architecture,
          quantization,
          parameterSize,
          installedBytes,
        },
      };
    });
  }
  async cancel(id: string) {
    const job = this.get(id),
      running = this.active.get(id);
    if (running) {
      running.abort.abort();
      await running.done;
      return this.get(id);
    }
    if (job.state === "installed" || job.state === "uncertain") return job;
    if (this.active.size || this.stopped) throw new ImportError("IMPORT_BUSY");
    // Cancellation of an idle, uncommitted review needs no runtime request.
    this.save({ ...job, state: "cancelled" });
    await this.cleanup(id);
    return this.get(id);
  }
  private cleanupEligible(job: ImportJob) {
    return ["installed", "cancelled", "interrupted", "failed"].includes(
      job.state,
    );
  }
  private expiredReview(job: ImportJob) {
    return (
      (job.state === "staged" &&
        !!job.review &&
        job.review.expiresAt <= Date.now()) ||
      (job.state === "download_review" &&
        !!job.download &&
        job.download.expiresAt <= Date.now())
    );
  }
  private async releaseFiles(job: ImportJob) {
    if (job.stagingCleanup?.state === "released") return;
    const pending = this.save({
      ...job,
      stagingCleanup: { state: "pending", updatedAt: Date.now() },
    });
    try {
      // Only our UUID-named job directory is removed. Original picker files,
      // Ollama's model store and the encrypted jobs database are outside it.
      await this.removeStaging(join(this.root, z.uuid().parse(job.id)));
    } catch {
      this.save({
        ...pending,
        stagingCleanup: { state: "retry", updatedAt: Date.now() },
      });
      return;
    }
    this.save({
      ...pending,
      stagingCleanup: { state: "released", updatedAt: Date.now() },
    });
  }
  async cleanup(id: string) {
    let job = this.get(id);
    if (this.active.size || this.stopped) throw new ImportError("IMPORT_BUSY");
    if (this.expiredReview(job))
      job = this.save({ ...job, state: "failed", error: "REVIEW_EXPIRED" });
    if (!this.cleanupEligible(job)) throw new ImportError("REVIEW_MISMATCH");
    const abort = new AbortController();
    const done = Promise.resolve().then(() => this.releaseFiles(job));
    this.active.set(id, { abort, done });
    try {
      await done;
      return this.get(id);
    } finally {
      this.active.delete(id);
    }
  }
  /** Startup/idle maintenance never downloads, installs, reconciles or deletes history. */
  async maintain() {
    if (this.stopped || this.active.size) return;
    for (const job of this.list()) {
      if (this.stopped || this.active.size) return;
      if (
        job.stagingCleanup?.state !== "released" &&
        (this.cleanupEligible(job) || this.expiredReview(job))
      )
        await this.cleanup(job.id);
    }
  }
  async remove(id: string) {
    this.get(id);
    if (this.active.size || this.stopped) throw new ImportError("IMPORT_BUSY");
    const abort = new AbortController();
    const done = Promise.resolve().then(async () => {
      await rm(join(this.root, id), { recursive: true, force: true });
      this.db.prepare("DELETE FROM jobs WHERE id=?").run(id);
    });
    this.active.set(id, { abort, done });
    try {
      await done;
    } finally {
      this.active.delete(id);
    }
  }
  async shutdown() {
    this.stopped = true;
    const jobs = [...this.active.values()];
    for (const job of jobs) job.abort.abort();
    await Promise.all(jobs.map((job) => job.done));
  }
  close() {
    this.db.close();
  }
  async stop() {
    await this.shutdown();
    this.close();
  }
}
