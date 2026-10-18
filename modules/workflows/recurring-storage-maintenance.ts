import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { Vault } from "../storage/vault.js";
import { canonical } from "../contracts/canonical-json.js";
import type { RecurringReceipt } from "./recurring.js";
import type { StorageCleanupSource } from "./recurring-storage-source.js";
import type { StorageCleanupProof } from "./recurring-storage-cleanup.js";

const reserve = 20 * 1024 ** 3;
const hash = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
type Plan = {
  id: string;
  authority: string;
  at: number;
  before: number;
  complete: boolean;
  proofs: StorageCleanupProof[];
  skipped: string[];
};
type Report = {
  producer: "bittrees-ai-storage-cleanup";
  day: string;
  operationId: string;
  at: number;
  before: number;
  after: number;
  actualFreeBytesChange: number;
  growthSincePriorCheck: number | null;
  removed: string[];
  skipped: string[];
  inventoryComplete: boolean;
  needsReview: boolean;
  notify: boolean;
  receipt: RecurringReceipt;
};
export class StorageMaintenance {
  private db: Database.Database;
  private busy = false;
  private activeAuthority?: string;
  constructor(
    path: string,
    private vault: Vault,
    private source: Pick<
      StorageCleanupSource,
      "inventory" | "inspect" | "execute"
    >,
    private options: {
      authorized: () => boolean;
      authority: () => string | undefined;
      reportsDirectory: string;
      now?: () => number;
    },
  ) {
    this.db = new Database(path);
    this.db.pragma("synchronous = FULL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS storage_maintenance(id TEXT PRIMARY KEY,value BLOB NOT NULL)",
    );
  }
  private get<T>(id: string): T | undefined {
    const row = this.db
      .prepare("SELECT value FROM storage_maintenance WHERE id=?")
      .get(id) as { value: Buffer } | undefined;
    return row
      ? this.vault.open<T>(row.value, "storage-maintenance:" + id)
      : undefined;
  }
  private put(id: string, value: unknown) {
    this.db
      .prepare("INSERT OR REPLACE INTO storage_maintenance VALUES(?,?)")
      .run(id, this.vault.seal(value, "storage-maintenance:" + id));
  }
  private check(signal: AbortSignal) {
    signal.throwIfAborted();
    if (
      !this.options.authorized() ||
      !this.options.authority() ||
      (this.activeAuthority &&
        this.options.authority() !== this.activeAuthority)
    )
      throw Error("Reviewed storage authority required");
  }
  operationAuthorized() {
    return (
      !!this.activeAuthority &&
      this.options.authorized() &&
      this.options.authority() === this.activeAuthority
    );
  }
  status() {
    return {
      plan: this.get<Plan>("plan") ?? null,
      report: this.get<Report>("report") ?? null,
      pending: this.get("pending") ?? null,
      running: this.busy,
    };
  }
  async collect(signal: AbortSignal, id: string): Promise<RecurringReceipt> {
    this.check(signal);
    if (this.busy || this.get("pending"))
      throw Error("Storage operation needs reconciliation or is running");
    this.busy = true;
    this.activeAuthority = this.options.authority();
    try {
      const inventory = await this.source.inventory(signal);
      const plan: Plan = {
        id,
        authority: this.activeAuthority!,
        at: inventory.measuredAt,
        before: inventory.availableBytes,
        complete: inventory.complete,
        proofs: [],
        skipped: [],
      };
      if (plan.before < reserve && inventory.complete) {
        for (const candidate of inventory.candidates) {
          this.check(signal);
          try {
            const proof = await this.source.inspect(
              candidate.path,
              candidate.checkout ?? undefined,
              signal,
            );
            if (proof.fileCount !== 0) plan.proofs.push(proof);
          } catch {
            this.check(signal);
            plan.skipped.push(candidate.path);
          }
        }
      }
      this.check(signal);
      this.put("plan", plan);
      if (!plan.complete || !plan.proofs.length)
        return (await this.report(plan, id, plan.before, [])).receipt;
      return {
        state: "confirmed",
        observedAt: plan.at,
        fingerprint: hash(plan),
        evidence: {
          planId: id,
          eligibleCaches: plan.proofs.length,
          skipped: plan.skipped,
          availableBytes: plan.before,
        },
      };
    } finally {
      this.busy = false;
      this.activeAuthority = undefined;
    }
  }
  decide(receipt: RecurringReceipt) {
    const evidence = receipt.evidence as {
      eligibleCaches?: number;
      notify?: boolean;
    };
    if (receipt.state === "held")
      return {
        decision: "escalate" as const,
        summary:
          "Storage inspection is incomplete; saved report requires review.",
      };
    if (evidence.eligibleCaches)
      return {
        decision: "act" as const,
        actionId: "local.storage.cleanup",
        summary: "Clean only the inspected caches after fresh safety checks.",
      };
    return {
      decision: evidence.notify ? ("escalate" as const) : ("wait" as const),
      summary: evidence.notify
        ? "Storage report requires review."
        : "No meaningful storage change.",
    };
  }
  async execute(signal: AbortSignal, id: string): Promise<RecurringReceipt> {
    this.check(signal);
    const prior = this.get<Report>("done:" + id);
    if (prior) return prior.receipt;
    if (this.busy || this.get("pending"))
      throw Error("Storage operation needs reconciliation or is running");
    const plan = this.get<Plan>("plan");
    const now = (this.options.now ?? Date.now)();
    if (
      !plan ||
      plan.authority !== this.options.authority() ||
      !plan.complete ||
      now - plan.at < 0 ||
      now - plan.at > 120000
    )
      throw Error("Fresh complete cleanup plan required");
    this.busy = true;
    this.activeAuthority = plan.authority;
    try {
      this.db
        .transaction(() => {
          if (this.get("pending"))
            throw Error("Storage operation needs reconciliation");
          this.put("pending", { id, planId: plan.id });
        })
        .immediate();
      const removed: string[] = [];
      let after = plan.before;
      for (const proof of plan.proofs) {
        this.check(signal);
        if (after >= reserve) break;
        const result = await this.source.execute(
          hash({ id, path: proof.path }),
          proof,
          signal,
        );
        this.check(signal);
        if (result.state !== "confirmed" || !result.result)
          throw Error("Cleanup outcome requires reconciliation");
        removed.push(proof.path);
        after = result.result.afterAvailableBytes;
      }
      const report = await this.report(plan, id, after, removed);
      this.check(signal);
      this.db.transaction(() => {
        this.put("done:" + id, report);
        this.db
          .prepare("DELETE FROM storage_maintenance WHERE id='pending'")
          .run();
      })();
      return report.receipt;
    } finally {
      this.busy = false;
      this.activeAuthority = undefined;
    }
  }
  private async report(
    plan: Plan,
    id: string,
    after: number,
    removed: string[],
  ): Promise<Report> {
    const at = (this.options.now ?? Date.now)();
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Lisbon",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
    const previous = this.get<Report>("report");
    const legacy = previous ? undefined : await this.legacyPrior(day);
    const needsReview = !plan.complete || after < reserve;
    const key = {
      needsReview,
      complete: plan.complete,
      bucket: Math.floor(after / 1024 ** 3),
      skipped: plan.skipped,
    };
    const notify =
      removed.length > 0 ||
      (this.get<string>("notification") !== hash(key) && needsReview);
    const receipt: RecurringReceipt = {
      state: plan.complete ? "confirmed" : "held",
      observedAt: at,
      fingerprint: hash(key),
      evidence: {
        operationId: id,
        inventoryComplete: plan.complete,
        beforeAvailableBytes: plan.before,
        afterAvailableBytes: after,
        actualFreeBytesChange: after - plan.before,
        removed,
        skipped: plan.skipped,
        needsReview,
        notify,
        review: needsReview
          ? "Space remains below reserve or inspection is incomplete. Uninspected paths and all backups/dependencies are retained for owner review."
          : "No further cleanup needed.",
      },
    };
    const report: Report = {
      producer: "bittrees-ai-storage-cleanup",
      day,
      operationId: id,
      at,
      before: plan.before,
      after,
      actualFreeBytesChange: after - plan.before,
      growthSincePriorCheck: previous
        ? previous.after - plan.before
        : legacy
          ? legacy.after - plan.before
          : null,
      removed,
      skipped: plan.skipped,
      inventoryComplete: plan.complete,
      needsReview,
      notify,
      receipt,
    };
    this.put("report", report); // retain evidence even if filesystem report writing fails
    await this.writeReport(report);
    this.put("notification", hash(key));
    return report;
  }
  private async legacyPrior(
    day: string,
  ): Promise<{ after: number; day: string } | undefined> {
    const root = this.options.reportsDirectory;
    try {
      for (let p = root; ; p = dirname(p)) {
        const info = await lstat(p);
        if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
        if (p === dirname(p)) break;
      }
      const names = (await readdir(root))
        .filter(
          (n) =>
            /^daily-safe-storage-\d{4}-\d{2}-\d{2}\.json$/.test(n) &&
            n.slice(19, 29) <= day,
        )
        .sort()
        .reverse()
        .slice(0, 30);
      for (const name of names) {
        const path = join(root, name),
          info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024)
          continue;
        try {
          const value = JSON.parse(await readFile(path, "utf8"));
          if (
            value.date !== name.slice(19, 29) ||
            !Number.isSafeInteger(value.after_free_bytes) ||
            value.after_free_bytes < 0 ||
            !Number.isSafeInteger(value.before_free_bytes) ||
            !Array.isArray(value.removed)
          )
            continue;
          // A saved measurement is not proof that a human received a notification.
          this.put("legacy-prior", {
            day: value.date,
            after: value.after_free_bytes,
            notificationAcknowledged: false,
          });
          return { day: value.date, after: value.after_free_bytes };
        } catch {
          /* Unrecognized source report is retained. */
        }
      }
    } catch {
      /* No safely readable legacy report. */
    }
    return undefined;
  }
  private async writeReport(report: Report) {
    const root = this.options.reportsDirectory;
    // Parent must already exist; do not follow a replaced log directory.
    for (let p = dirname(root); ; p = dirname(p)) {
      const info = await lstat(p);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw Error("Unsafe report directory");
      if (p === dirname(p)) break;
    }
    await mkdir(root, { recursive: false }).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw Error("Unsafe report directory");
    const target = join(root, `daily-safe-storage-${report.day}-local.json`);
    try {
      const old = await lstat(target);
      if (!old.isFile() || old.isSymbolicLink())
        throw Error("Unsafe report target");
      if (
        old.size > 256 * 1024 ||
        JSON.parse(await readFile(target, "utf8")).producer !==
          "bittrees-ai-storage-cleanup"
      )
        throw Error("Existing report is not owned by this workflow");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    const temporary = target + "." + hash(report).slice(0, 16) + ".tmp";
    await writeFile(temporary, JSON.stringify(report, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, target);
    const names = (await readdir(root))
      .filter((n) =>
        /^daily-safe-storage-\d{4}-\d{2}-\d{2}(?:-local)?\.json$/.test(n),
      )
      .sort();
    const owned: {
      path: string;
      ino: number;
      dev: number;
      mtimeMs: number;
      size: number;
    }[] = [];
    for (const name of names) {
      const path = join(root, name),
        info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024)
        continue;
      try {
        const value = JSON.parse(await readFile(path, "utf8"));
        const legacy =
          !name.endsWith("-local.json") &&
          value.date === name.slice(19, 29) &&
          Number.isFinite(value.before_free_bytes) &&
          Number.isFinite(value.after_free_bytes) &&
          Array.isArray(value.removed) &&
          (Array.isArray(value.skipped) || typeof value.status === "string");
        if (value.producer === "bittrees-ai-storage-cleanup" || legacy)
          owned.push({
            path,
            ino: info.ino,
            dev: info.dev,
            mtimeMs: info.mtimeMs,
            size: info.size,
          });
      } catch {
        /* Unrecognized reports are retained for review. */
      }
    }
    for (const { path, ino, dev, mtimeMs, size } of owned.slice(0, -30)) {
      const current = await lstat(path);
      if (
        current.isFile() &&
        !current.isSymbolicLink() &&
        current.ino === ino &&
        current.dev === dev &&
        current.mtimeMs === mtimeMs &&
        current.size === size
      )
        await unlink(path);
    }
  }
  close() {
    if (this.busy) throw Error("Storage task running");
    this.db.close();
  }
}
