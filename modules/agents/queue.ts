import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { Vault } from "../storage/vault.js";
export type TaskTurn = <T>(
  label: string,
  signal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
) => Promise<T>;
export const immediateTask: TaskTurn = async (_label, signal, work) => {
  signal.throwIfAborted();
  return work(signal);
};
export type QueueEntry = {
  id: string;
  label: string;
  state: "queued" | "running" | "returned" | "held" | "cancelled";
  createdAt: number;
  updatedAt: number;
};
/** One whole task owns the execution slot. Aborting a waiter never releases its predecessor. */
export class AgentQueue {
  private db: Database.Database;
  private tail: Promise<void> = Promise.resolve();
  private controllers = new Map<string, AbortController>();
  private paused = false;
  private stopped = false;
  private wake?: () => void;
  constructor(
    path: string,
    private vault: Vault,
  ) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY, value BLOB NOT NULL); CREATE TABLE IF NOT EXISTS controls(id INTEGER PRIMARY KEY,value INTEGER NOT NULL)",
    );
    this.paused = !!(
      this.db.prepare("SELECT value FROM controls WHERE id=1").get() as
        { value: number } | undefined
    )?.value;
    // Callback execution cannot safely be replayed after a crash. Source owners reconcile it.
    for (const row of this.list())
      if (row.state === "running" || row.state === "queued")
        this.save({ ...row, state: "held", updatedAt: Date.now() });
  }
  private save(row: QueueEntry) {
    this.db
      .prepare("INSERT OR REPLACE INTO entries VALUES(?,?)")
      .run(row.id, this.vault.seal(row, "agent-queue:" + row.id));
  }
  list(): QueueEntry[] {
    return (
      this.db.prepare("SELECT id,value FROM entries ORDER BY rowid").all() as {
        id: string;
        value: Buffer;
      }[]
    ).map((r) => this.vault.open<QueueEntry>(r.value, "agent-queue:" + r.id));
  }
  status() {
    const rows = this.list();
    return {
      paused: this.paused,
      concurrency: 1,
      active: rows.find((r) => r.state === "running") ?? null,
      waiting: rows.filter((r) => r.state === "queued"),
      history: rows
        .filter((r) => !["running", "queued"].includes(r.state))
        .slice(-100),
    };
  }
  pause() {
    this.paused = true;
    this.db.prepare("INSERT OR REPLACE INTO controls VALUES(1,1)").run();
    return this.status();
  }
  resume() {
    this.paused = false;
    this.db.prepare("INSERT OR REPLACE INTO controls VALUES(1,0)").run();
    this.wake?.();
    return this.status();
  }
  cancel(id: string) {
    this.controllers.get(id)?.abort(Error("Cancelled by owner"));
    return this.status();
  }
  run: TaskTurn = async (label, parent, work) => {
    if (this.stopped) throw Error("Coordinator stopped");
    parent.throwIfAborted();
    if (this.controllers.size >= 200) throw Error("Task queue full");
    // Retain evidence; refuse growth rather than silently discarding history.
    if (this.list().length >= 10000)
      throw Error("Queue history needs export before more work");
    const row: QueueEntry = {
      id: randomUUID(),
      label: label.slice(0, 160),
      state: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const controller = new AbortController();
    this.controllers.set(row.id, controller);
    const signal = AbortSignal.any([parent, controller.signal]);
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => {
      release = r;
    });
    this.save(row);
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([previous, aborted]);
      signal.throwIfAborted();
      while (this.paused && !signal.aborted)
        await Promise.race([
          new Promise<void>((r) => {
            this.wake = r;
          }),
          aborted,
        ]);
      signal.throwIfAborted();
      row.state = "running";
      row.updatedAt = Date.now();
      this.save(row);
      // Work owns its own cancellation/source reconciliation. Do not release while it is still executing.
      const result = await work(signal);
      signal.throwIfAborted();
      row.state = "returned";
      if (result === false && label === "Local task") row.label = "";
      return result;
    } catch (error) {
      row.state = signal.aborted ? "cancelled" : "held";
      throw error;
    } finally {
      row.updatedAt = Date.now();
      if (row.label) this.save(row);
      else this.db.prepare("DELETE FROM entries WHERE id=?").run(row.id);
      signal.removeEventListener("abort", onAbort);
      this.controllers.delete(row.id);
      void previous.then(release);
    }
  };
  async close() {
    this.stopped = true;
    this.wake?.();
    for (const c of this.controllers.values())
      c.abort(Error("Coordinator stopping"));
    await this.tail;
    this.db.close();
  }
}
