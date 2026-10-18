import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { Vault } from "../storage/vault.js";
import {
  myCloudHealthReceipt,
  type MyCloudObservation,
} from "./recurring-mycloud-health.js";
const directory = "/Users/jhineline/Documents/MyCloud Maintenance 2026-09-19";
const pins = {
  "health-check.py":
    "d75ef8d0e3c5fc924d8710e0151a34855c9f3a765cd4de30c24d825e282fc346",
  "remote.py":
    "4c1c0eb7fb12dd2460c12114d03536526f2e8919f8df90378babda9a7ecbe738",
};
export async function pinnedMyCloudCheck(signal: AbortSignal) {
  for (const [name, expected] of Object.entries(pins)) {
    const path = directory + "/" + name,
      stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 65536 ||
      stat.mode & 0o022
    )
      throw Error("MyCloud checker identity unavailable");
    if (
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex") !== expected
    )
      throw Error("MyCloud checker changed; review required");
  }
  signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    execFile(
      "/usr/bin/python3",
      [directory + "/health-check.py"],
      {
        cwd: directory,
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: "/Users/jhineline",
          PYTHONNOUSERSITE: "1",
          PYTHONDONTWRITEBYTECODE: "1",
        },
        timeout: 45000,
        maxBuffer: 32768,
        signal,
      },
      (error, stdout) => {
        // Never propagate SSH stderr or credentials into workflow receipts.
        if (error) reject(Error("MyCloud checker failed or timed out"));
        else resolve(stdout);
      },
    );
  });
}
type State = { observation?: MyCloudObservation; sequence: number };
/** Fixed original checker only. Network admission must be separately approved; never bypass sandbox. */
export class MyCloudSource {
  private db: Database.Database;
  private busy = false;
  constructor(
    path: string,
    private vault: Vault,
    private options: {
      authorized: () => boolean;
      check?: typeof pinnedMyCloudCheck;
    },
  ) {
    this.db = new Database(path);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS health_state(id TEXT PRIMARY KEY,value BLOB NOT NULL); CREATE TABLE IF NOT EXISTS health_outbox(id INTEGER PRIMARY KEY,value BLOB NOT NULL)",
    );
  }
  async read(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.options.authorized())
      throw Error(
        "MyCloud network source approval pending; offline restrictions retained",
      );
    if (this.busy) throw Error("MyCloud check already running");
    this.busy = true;
    try {
      const raw = await (this.options.check || pinnedMyCloudCheck)(signal);
      signal.throwIfAborted();
      if (!this.options.authorized())
        throw Error("MyCloud source approval changed");
      const row = this.db
        .prepare("SELECT value FROM health_state WHERE id='baseline'")
        .get() as { value: Buffer } | undefined;
      const prior = row
        ? this.vault.open<State>(row.value, "mycloud-baseline")
        : { sequence: 0 };
      const result = myCloudHealthReceipt(raw, prior.observation);
      const sequence = prior.sequence + (result.notifications.length ? 1 : 0);
      this.db.transaction(() => {
        this.db
          .prepare("INSERT OR REPLACE INTO health_state VALUES('baseline',?)")
          .run(
            this.vault.seal(
              { observation: result.observation, sequence },
              "mycloud-baseline",
            ),
          );
        if (result.notifications.length)
          this.db
            .prepare("INSERT INTO health_outbox VALUES(?,?)")
            .run(
              sequence,
              this.vault.seal(
                {
                  id: sequence,
                  notifications: result.notifications,
                  receipt: result.receipt,
                },
                "mycloud-event:" + sequence,
              ),
            );
      })();
      return result.receipt;
    } finally {
      this.busy = false;
    }
  }
  outbox() {
    return (
      this.db
        .prepare(
          "SELECT id,value FROM health_outbox ORDER BY id DESC LIMIT 100",
        )
        .all() as { id: number; value: Buffer }[]
    ).map((row) => this.vault.open(row.value, "mycloud-event:" + row.id));
  }
  close() {
    if (this.busy) throw Error("MyCloud check running");
    this.db.close();
  }
}
