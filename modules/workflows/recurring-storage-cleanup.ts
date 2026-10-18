import Database from "better-sqlite3";
import { z } from "zod";
import { homedir } from "node:os";
import { posix } from "node:path";
import { Vault } from "../storage/vault.js";

const reserve = 20 * 1024 ** 3;
const downloads = new Set([
  posix.join(homedir(), ".npm/_cacache"),
  posix.join(homedir(), "Library/Caches/Yarn"),
]);
const compilerSuffixes = new Set([
  ".next/cache/webpack",
  ".next/cache/turbopack",
  ".next/cache/swc",
  "node_modules/.cache/babel-loader",
  "node_modules/.cache/prettier",
]);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const proofSchema = z.strictObject({
  path: z.string().max(4096),
  checkout: z.string().max(4096).optional(),
  measuredAt: z.number().int().nonnegative(),
  availableBytes: z.number().int().nonnegative().safe(),
  snapshotHash: digest,
  oldestChangeAgeMs: z.number().int().nonnegative(),
  noSymlinksOrSpecialFiles: z.literal(true),
  noOpenFiles: z.literal(true),
  noBuildOrPackageProcesses: z.literal(true),
  stableSnapshot: z.literal(true),
  fileCount: z.number().int().nonnegative().optional(),
  ignoredAndUntracked: z.literal(true).optional(),
  repositoryStatusHash: digest.optional(),
});
export type StorageCleanupProof = z.infer<typeof proofSchema>;
const resultSchema = z.strictObject({
  removed: z.literal(true),
  repositoryStatusUnchanged: z.literal(true),
  afterAvailableBytes: z.number().int().nonnegative().safe(),
  completedAt: z.number().int().nonnegative(),
  sourceReceiptHash: digest,
});
export type StorageCleanupResult = z.infer<typeof resultSchema>;
type RecordValue = {
  state: "started" | "confirmed" | "held";
  requestHash: string;
  proof: StorageCleanupProof;
  result?: StorageCleanupResult;
  actualFreeBytesChange?: number;
};

/** Lexical scope is only one gate. The operator's filesystem adapter must independently
 * verify every ancestor/inode, ignored/tracked state, activity and a stable snapshot.
 * Never expose this interface to model-provided paths or a generic command executor.
 */
export function assertCleanupScope(proof: StorageCleanupProof) {
  const path = proof.path;
  if (!path.startsWith("/") || posix.normalize(path) !== path)
    throw Error("Cache path is not canonical");
  if (downloads.has(path)) {
    if (proof.checkout !== undefined)
      throw Error("Download cache is not a checkout");
    return;
  }
  const root = proof.checkout;
  if (
    !root ||
    !root.startsWith(homedir() + "/") ||
    posix.normalize(root) !== root ||
    root
      .split("/")
      .some((part) => ["sources", "node_modules", ".git"].includes(part)) ||
    !path.startsWith(root + "/") ||
    ![...compilerSuffixes].some((suffix) => {
      const relative = path.slice(root.length + 1);
      return (
        (relative === suffix || relative.endsWith("/" + suffix)) &&
        !relative
          .slice(0, -suffix.length)
          .split("/")
          .some((part) => ["sources", ".git", "node_modules"].includes(part))
      );
    }) ||
    !proof.ignoredAndUntracked ||
    !proof.repositoryStatusHash
  )
    throw Error("Cache is outside the reviewed cleanup scope");
}

/** Durable admission for the future typed filesystem adapter. Not registered in the
 * native app yet: this module alone grants no filesystem action or schedule authority.
 * A crash/uncertain outcome holds the entire cleanup source until reconciliation;
 * changing the operation ID cannot bypass that hold.
 */
export class StorageCleanupJournal {
  private db: Database.Database;
  private busy = false;
  constructor(
    path: string,
    private vault: Vault,
    private host: {
      authorized: () => boolean;
      revalidate: (
        proof: StorageCleanupProof,
        signal: AbortSignal,
      ) => Promise<StorageCleanupProof>;
      removeVerifiedCache: (
        proof: StorageCleanupProof,
        signal: AbortSignal,
      ) => Promise<StorageCleanupResult>;
      now?: () => number;
    },
  ) {
    this.db = new Database(path);
    this.db.pragma("synchronous = FULL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS cleanup_operations(id TEXT PRIMARY KEY,state TEXT NOT NULL,value BLOB NOT NULL)",
    );
  }
  private put(id: string, value: RecordValue) {
    this.db
      .prepare("INSERT OR REPLACE INTO cleanup_operations VALUES(?,?,?)")
      .run(id, value.state, this.vault.seal(value, "storage-cleanup:" + id));
  }
  async execute(
    id: string,
    supplied: StorageCleanupProof,
    signal: AbortSignal,
  ) {
    digest.parse(id);
    signal.throwIfAborted();
    if (!this.host.authorized())
      throw Error("Storage action approval required");
    if (this.busy) throw Error("Storage cleanup already running");
    const proof = proofSchema.parse(supplied);
    assertCleanupScope(proof);
    const requestHash = this.vault.fingerprint(proof);
    const previous = this.db
      .prepare("SELECT value FROM cleanup_operations WHERE id=?")
      .get(id) as { value: Buffer } | undefined;
    if (previous) {
      const saved = this.vault.open<RecordValue>(
        previous.value,
        "storage-cleanup:" + id,
      );
      if (saved.requestHash !== requestHash)
        throw Error("Operation identity conflicts with prior proof");
      if (saved.state !== "confirmed")
        throw Error("Uncertain cleanup requires source reconciliation");
      return saved;
    }
    if (
      this.db
        .prepare(
          "SELECT id FROM cleanup_operations WHERE state!='confirmed' LIMIT 1",
        )
        .get()
    )
      throw Error("Uncertain cleanup requires source reconciliation");
    this.busy = true;
    try {
      const fresh = proofSchema.parse(
        await this.host.revalidate(proof, signal),
      );
      assertCleanupScope(fresh);
      const now = (this.host.now ?? Date.now)();
      if (
        fresh.path !== proof.path ||
        fresh.checkout !== proof.checkout ||
        fresh.snapshotHash !== proof.snapshotHash ||
        fresh.repositoryStatusHash !== proof.repositoryStatusHash ||
        fresh.oldestChangeAgeMs < 3600000 ||
        now - fresh.measuredAt < 0 ||
        now - fresh.measuredAt > 5000 ||
        fresh.availableBytes >= reserve
      )
        throw Error("Cache changed, measurement stale, or cleanup unnecessary");
      signal.throwIfAborted();
      if (!this.host.authorized())
        throw Error("Storage action approval changed");
      const record: RecordValue = {
        state: "started",
        requestHash,
        proof: fresh,
      };
      this.db
        .transaction(() => {
          if (
            this.db
              .prepare(
                "SELECT id FROM cleanup_operations WHERE id=? OR state!='confirmed' LIMIT 1",
              )
              .get(id)
          )
            throw Error(
              "Concurrent or uncertain cleanup requires reconciliation",
            );
          this.db
            .prepare("INSERT INTO cleanup_operations VALUES(?,?,?)")
            .run(
              id,
              record.state,
              this.vault.seal(record, "storage-cleanup:" + id),
            );
        })
        .immediate(); // persist exclusive admission before the first mutation
      try {
        const result = resultSchema.parse(
          await this.host.removeVerifiedCache(fresh, signal),
        );
        signal.throwIfAborted();
        if (!this.host.authorized() || result.completedAt < fresh.measuredAt)
          throw Error("Post-action verification requires reconciliation");
        record.state = "confirmed";
        record.result = result;
        record.actualFreeBytesChange =
          result.afterAvailableBytes - fresh.availableBytes;
        this.put(id, record);
        return record;
      } catch {
        record.state = "held";
        this.put(id, record);
        throw Error(
          "Cleanup outcome uncertain; reconcile source before another action",
        );
      }
    } finally {
      this.busy = false;
    }
  }
  close() {
    if (this.busy) throw Error("Cleanup still running");
    this.db.close();
  }
}
