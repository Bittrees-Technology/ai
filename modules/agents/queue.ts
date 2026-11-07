import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { statfsSync } from "node:fs";
import { dirname } from "node:path";
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
    private path: string,
    private vault: Vault,
  ) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY, value BLOB NOT NULL); CREATE TABLE IF NOT EXISTS controls(id INTEGER PRIMARY KEY,value INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS history(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,value BLOB NOT NULL)",
    );
    this.paused = !!(
      this.db.prepare("SELECT value FROM controls WHERE id=1").get() as
        { value: number } | undefined
    )?.value;
    // Callback execution cannot safely be replayed after a crash. Source owners reconcile it.
    for (const row of this.current())
      if (row.state === "running" || row.state === "queued")
        this.save({ ...row, state: "held", updatedAt: Date.now() });
  }
  private save(row: QueueEntry) {
    this.db
      .prepare("INSERT OR REPLACE INTO entries VALUES(?,?)")
      .run(row.id, this.vault.seal(row, "agent-queue:" + row.id));
  }
  private current(): QueueEntry[] {
    return (
      this.db.prepare("SELECT id,value FROM entries ORDER BY rowid").all() as {
        id: string;
        value: Buffer;
      }[]
    ).map((r) => this.vault.open<QueueEntry>(r.value, "agent-queue:" + r.id));
  }
  list(): QueueEntry[] {
    const history = (
      this.db
        .prepare(
          "SELECT id,value FROM history ORDER BY sequence DESC LIMIT 100",
        )
        .all() as { id: string; value: Buffer }[]
    )
      .reverse()
      .map((r) => this.vault.open<QueueEntry>(r.value, "agent-queue:" + r.id));
    return [...history, ...this.current()];
  }
  private retainHistory() {
    const count = (
      this.db.prepare("SELECT count(*) AS n FROM entries").get() as {
        n: number;
      }
    ).n;
    if (count < 10000) return;
    const fs = statfsSync(dirname(this.path));
    const pages = Number(this.db.pragma("page_count", { simple: true }));
    const size = Number(this.db.pragma("page_size", { simple: true }));
    if (
      fs.bavail * fs.bsize < 20 * 1024 ** 3 ||
      pages * size >= 256 * 1024 ** 2
    )
      throw Error(
        "Queue history needs verified export; storage reserve retained",
      );
    // Copy ciphertext and retire only the identical terminal working row in one
    // transaction. Every receipt remains durable; active callbacks are untouched.
    this.db
      .transaction(() => {
        const rows = this.db
          .prepare("SELECT id,value FROM entries ORDER BY rowid")
          .all() as { id: string; value: Buffer }[];
        let moved = 0;
        for (const r of rows) {
          if (this.controllers.has(r.id)) continue;
          const row = this.vault.open<QueueEntry>(
            r.value,
            "agent-queue:" + r.id,
          );
          if (!["returned", "held", "cancelled"].includes(row.state)) continue;
          this.db
            .prepare("INSERT INTO history(id,value) VALUES(?,?)")
            .run(r.id, r.value);
          if (
            this.db
              .prepare("DELETE FROM entries WHERE id=? AND value=?")
              .run(r.id, r.value).changes !== 1
          )
            throw Error("Queue receipt changed during retention");
          moved++;
        }
        if (!moved) throw Error("Queue has no terminal history to retain");
      })
      .immediate();
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
    this.retainHistory();
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
