import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { Vault } from "../storage/vault.js";
import { myCloudOperationIdSchema } from "./mycloud-operation-journal.js";
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
export async function verifyMyCloudPins(
  root = directory,
  expectedPins: Record<string, string> = pins,
) {
  for (let parent = root; ; parent = dirname(parent)) {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw Error("MyCloud source directory identity unavailable");
    if (parent === dirname(parent)) break;
  }
  for (const [name, expected] of Object.entries(expectedPins)) {
    const path = root + "/" + name,
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
}
export async function pinnedMyCloudCheck(signal: AbortSignal) {
  await verifyMyCloudPins();
  signal.throwIfAborted();
  const result = await new Promise<string>((resolve, reject) => {
    const bootstrap =
      "import sys,runpy;sys.path.insert(0," +
      JSON.stringify(directory) +
      ");import remote;remote.SSH=" +
      JSON.stringify([
        "/usr/bin/ssh",
        "-F",
        "/dev/null",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "UserKnownHostsFile=/Users/jhineline/.ssh/known_hosts",
        "-o",
        "GlobalKnownHostsFile=/dev/null",
        "-i",
        "/Users/jhineline/.ssh/mycloud_admin",
        "root@192.168.1.164",
      ]) +
      ";runpy.run_path(" +
      JSON.stringify(directory + "/health-check.py") +
      ",run_name='__main__')";
    const child = spawn("/usr/bin/python3", ["-I", "-c", bootstrap], {
      cwd: directory,
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: "/Users/jhineline",
        PYTHONNOUSERSITE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
      },
    });
    let failed = false,
      bytes = 0;
    const chunks: Buffer[] = [];
    // Own process group includes the checker's SSH child; never leave an orphan retry.
    const stop = () => {
      failed = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    };
    const timer = setTimeout(stop, 20000); // less than recurring verification's 30-second budget
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 32768) stop();
      else chunks.push(chunk);
    });
    child.on("error", () => {
      failed = true;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (failed || code !== 0 || signal.aborted)
        reject(Error("MyCloud checker failed or timed out"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
  await verifyMyCloudPins();
  signal.throwIfAborted();
  return result;
}
type State = {
  observation?: MyCloudObservation;
  sequence: number;
  receipt?: unknown;
};
/** Fixed original checker only. Network admission must be separately approved; never bypass sandbox. */
export class MyCloudSource {
  private db: Database.Database;
  private busy = false;
  constructor(
    path: string,
    private vault: Vault,
    private options: {
      authorized: () => boolean;
      check?: (signal: AbortSignal, operationId: string) => Promise<string>;
    },
  ) {
    this.db = new Database(path);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS health_state(id TEXT PRIMARY KEY,value BLOB NOT NULL); CREATE TABLE IF NOT EXISTS health_outbox(id INTEGER PRIMARY KEY,value BLOB NOT NULL)",
    );
  }
  authorized() {
    return this.options.authorized();
  }
  async read(signal: AbortSignal, operationId = "verify:" + randomUUID()) {
    myCloudOperationIdSchema.parse(operationId);
    signal.throwIfAborted();
    if (!this.options.authorized())
      throw Error(
        "MyCloud network source approval pending; offline restrictions retained",
      );
    if (this.busy) throw Error("MyCloud check already running");
    this.busy = true;
    try {
      const raw = await (this.options.check || pinnedMyCloudCheck)(
        signal,
        operationId,
      );
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
      result.receipt.evidence = {
        ...(result.receipt.evidence as Record<string, unknown>),
        operationId,
      };
      const sequence = prior.sequence + (result.notifications.length ? 1 : 0);
      this.db.transaction(() => {
        const capacity = this.db
          .prepare("SELECT COUNT(*) AS count FROM health_outbox")
          .get() as { count: number };
        if (result.notifications.length && capacity.count >= 1000)
          throw Error(
            "MyCloud notification outbox full; explicit retention review required",
          );
        this.db
          .prepare("INSERT OR REPLACE INTO health_state VALUES('baseline',?)")
          .run(
            this.vault.seal(
              {
                observation: result.observation,
                sequence,
                receipt: result.receipt,
              },
              "mycloud-baseline",
            ),
          );
        if (result.notifications.length)
          this.db.prepare("INSERT INTO health_outbox VALUES(?,?)").run(
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
  status() {
    const row = this.db
      .prepare("SELECT value FROM health_state WHERE id='baseline'")
      .get() as { value: Buffer } | undefined;
    return {
      lastAccepted: row
        ? this.vault.open<State>(row.value, "mycloud-baseline")
        : null,
      notifications: this.outbox(),
    };
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
