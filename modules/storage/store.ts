import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { Vault } from "./vault.js";
import {
  requestSchema,
  commandSchema,
  modelProfileSchema,
  inboxSchema,
  inboxMessageSchema,
  type TaskInput,
  type TaskStatus,
} from "../contracts/index.js";
export class StoreError extends Error {
  constructor(
    public code:
      | "NOT_FOUND"
      | "CONFLICT"
      | "STALE_CLAIM"
      | "INVALID_INPUT"
      | "EXPIRED"
      | "CAPACITY",
  ) {
    super(code);
  }
}
export interface Owner {
  userId: string;
  tenantId: string;
}
interface Row {
  id: string;
  user_id: string;
  tenant_id: string;
  conversation_id: string;
  sequence: number;
  status: TaskStatus;
  revision: number;
  generation: number;
  lease_until: number | null;
  worker_id: string | null;
  deadline: number | null;
  next_attempt_at: number;
  created_at: number;
  updated_at: number;
  input: Buffer;
  result: Buffer | null;
  payload_hash: string;
  attempts: number;
}
export interface Task {
  id: string;
  conversationId: string;
  sequence: number;
  status: TaskStatus;
  revision: number;
  generation: number;
  createdAt: number;
  updatedAt: number;
  input: TaskInput;
  result: unknown;
}
export interface Claim {
  task: Task;
  workerId: string;
  generation: number;
  leaseUntil: number;
}
const terminal = ["completed", "failed", "cancelled", "expired"];
export class Store {
  readonly db: Database.Database;
  constructor(
    path: string,
    private vault: Vault,
    private now: () => number = Date.now,
  ) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("secure_delete = ON");
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > 4) {
      this.db.close();
      throw new Error("Unsupported database version");
    }
    try {
      this.db.transaction(() => {
        this.db.exec(`
CREATE TABLE IF NOT EXISTS conversations(id TEXT NOT NULL,user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,next_sequence INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(id,user_id,tenant_id));
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,conversation_id TEXT NOT NULL,sequence INTEGER NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,generation INTEGER NOT NULL DEFAULT 0,lease_until INTEGER,worker_id TEXT,deadline INTEGER,next_attempt_at INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,input BLOB NOT NULL,result BLOB,payload_hash TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,UNIQUE(user_id,tenant_id,conversation_id,sequence));
CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(user_id,tenant_id,created_at);
CREATE INDEX IF NOT EXISTS tasks_claim ON tasks(status,next_attempt_at,lease_until);
CREATE TABLE IF NOT EXISTS dependencies(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,depends_on TEXT NOT NULL REFERENCES tasks(id),PRIMARY KEY(task_id,depends_on));
CREATE TABLE IF NOT EXISTS idempotency(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,PRIMARY KEY(user_id,tenant_id,key));
CREATE TABLE IF NOT EXISTS events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,revision INTEGER NOT NULL,type TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(task_id,revision));
CREATE TABLE IF NOT EXISTS outbox(event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,acknowledged_at INTEGER);
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,generation INTEGER NOT NULL,worker_id TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,outcome TEXT,UNIQUE(task_id,generation));
`);
        this.db.exec(`
CREATE TABLE IF NOT EXISTS vault_meta(id INTEGER PRIMARY KEY CHECK(id=1), verifier BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS inboxes(id TEXT NOT NULL,user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,definition BLOB NOT NULL,PRIMARY KEY(id,user_id,tenant_id));
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,inbox_id TEXT NOT NULL,conversation_id TEXT NOT NULL,sequence INTEGER NOT NULL,request_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,content BLOB NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(user_id,tenant_id,key),FOREIGN KEY(inbox_id,user_id,tenant_id) REFERENCES inboxes(id,user_id,tenant_id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS messages_cursor ON messages(user_id,tenant_id,inbox_id,sequence);
CREATE TABLE IF NOT EXISTS receipts(message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,user_id TEXT NOT NULL,kind TEXT NOT NULL,recorded_at INTEGER NOT NULL,PRIMARY KEY(message_id,user_id,kind));
CREATE TABLE IF NOT EXISTS checkins(id TEXT PRIMARY KEY,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,due_at INTEGER NOT NULL,closed_at INTEGER);
`);
        const verifier = this.db
          .prepare("SELECT verifier FROM vault_meta WHERE id=1")
          .get() as { verifier: Buffer } | undefined;
        if (verifier) {
          if (
            this.vault.open(verifier.verifier, "vault-verifier") !==
            "bittrees-ai"
          )
            throw new Error("Invalid storage key");
        } else {
          const previous = this.db
            .prepare("SELECT id,input FROM tasks LIMIT 1")
            .get() as { id: string; input: Buffer } | undefined;
          if (previous) this.vault.open(previous.input, "task:" + previous.id);
          this.db
            .prepare("INSERT INTO vault_meta VALUES(1,?)")
            .run(this.vault.seal("bittrees-ai", "vault-verifier"));
        }
        if (version < 3)
          this.db.exec("ALTER TABLE runs ADD COLUMN model_snapshot BLOB");
        this.db
          .exec(`CREATE TABLE IF NOT EXISTS model_profiles(id TEXT NOT NULL,user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,payload BLOB NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(id,user_id,tenant_id));
CREATE TABLE IF NOT EXISTS model_defaults(user_id TEXT NOT NULL,tenant_id TEXT NOT NULL,profile_id TEXT NOT NULL,PRIMARY KEY(user_id,tenant_id),FOREIGN KEY(profile_id,user_id,tenant_id) REFERENCES model_profiles(id,user_id,tenant_id));`);
        this.db.pragma("user_version = 4");
      })();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  addProfile(owner: Owner, raw: unknown) {
    const profile = modelProfileSchema.parse(raw);
    if (profile.maxOutputTokens + 256 >= profile.contextTokens)
      throw new StoreError("INVALID_INPUT");
    const old = this.db
      .prepare(
        "SELECT id FROM model_profiles WHERE id=? AND user_id=? AND tenant_id=?",
      )
      .get(profile.id, owner.userId, owner.tenantId);
    if (old) throw new StoreError("CONFLICT");
    this.db
      .prepare("INSERT INTO model_profiles VALUES(?,?,?,?,?)")
      .run(
        profile.id,
        owner.userId,
        owner.tenantId,
        this.vault.seal(
          profile,
          "profile:" + owner.tenantId + ":" + owner.userId + ":" + profile.id,
        ),
        this.now(),
      );
    return profile;
  }
  profile(owner: Owner, id: string) {
    const row = this.db
      .prepare(
        "SELECT payload FROM model_profiles WHERE id=? AND user_id=? AND tenant_id=?",
      )
      .get(id, owner.userId, owner.tenantId) as { payload: Buffer } | undefined;
    if (!row) throw new StoreError("NOT_FOUND");
    return this.vault.open<ReturnType<typeof modelProfileSchema.parse>>(
      row.payload,
      "profile:" + owner.tenantId + ":" + owner.userId + ":" + id,
    );
  }
  profiles(owner: Owner) {
    return (
      this.db
        .prepare(
          "SELECT id FROM model_profiles WHERE user_id=? AND tenant_id=? ORDER BY created_at,id",
        )
        .all(owner.userId, owner.tenantId) as { id: string }[]
    ).map((p) => this.profile(owner, p.id));
  }
  setDefaultProfile(owner: Owner, id: string) {
    this.profile(owner, id);
    this.db
      .prepare(
        "INSERT INTO model_defaults VALUES(?,?,?) ON CONFLICT(user_id,tenant_id) DO UPDATE SET profile_id=excluded.profile_id",
      )
      .run(owner.userId, owner.tenantId, id);
  }
  defaultProfile(owner: Owner) {
    const row = this.db
      .prepare(
        "SELECT profile_id FROM model_defaults WHERE user_id=? AND tenant_id=?",
      )
      .get(owner.userId, owner.tenantId) as { profile_id: string } | undefined;
    return row ? this.profile(owner, row.profile_id) : null;
  }
  switchModel(
    owner: Owner,
    id: string,
    profileId: string,
    expectedRevision: number,
  ) {
    this.profile(owner, profileId);
    return this.db
      .transaction(() => {
        const row = this.row(owner, id);
        if (
          row.revision !== expectedRevision ||
          !["queued", "running", "paused"].includes(row.status)
        )
          throw new StoreError("CONFLICT");
        const input = { ...this.task(row).input, modelProfileId: profileId };
        this.db
          .prepare(
            "UPDATE runs SET finished_at=?,outcome='model_switched' WHERE task_id=? AND finished_at IS NULL",
          )
          .run(this.now(), id);
        this.db
          .prepare(
            "UPDATE tasks SET input=?,status=?,generation=generation+1,revision=revision+1,lease_until=NULL,worker_id=NULL,updated_at=? WHERE id=?",
          )
          .run(
            this.vault.seal(input, "task:" + id),
            row.status === "paused" ? "paused" : "queued",
            this.now(),
            id,
          );
        this.event(id, "model_switched");
        return this.get(owner, id);
      })
      .immediate();
  }
  private row(owner: Owner, id: string): Row {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE id=? AND user_id=? AND tenant_id=?")
      .get(id, owner.userId, owner.tenantId) as Row | undefined;
    if (!row) throw new StoreError("NOT_FOUND");
    return row;
  }
  private task(row: Row): Task {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      sequence: row.sequence,
      status: row.status,
      revision: row.revision,
      generation: row.generation,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      input: this.vault.open(row.input, "task:" + row.id),
      result: row.result
        ? this.vault.open(row.result, "result:" + row.id)
        : null,
    };
  }
  get(owner: Owner, id: string): Task {
    return this.task(this.row(owner, id));
  }
  list(owner: Owner, limit = 50): Task[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM tasks WHERE user_id=? AND tenant_id=? ORDER BY created_at DESC,id LIMIT ?",
        )
        .all(
          owner.userId,
          owner.tenantId,
          Math.max(1, Math.min(limit, 100)),
        ) as Row[]
    ).map((r) => this.task(r));
  }
  private event(id: string, type: string) {
    const r = this.db
      .prepare("SELECT revision FROM tasks WHERE id=?")
      .get(id) as { revision: number };
    const eid = randomUUID();
    this.db
      .prepare(
        "INSERT INTO events(id,task_id,revision,type,created_at) VALUES(?,?,?,?,?)",
      )
      .run(eid, id, r.revision, type, this.now());
    this.db.prepare("INSERT INTO outbox(event_id) VALUES(?)").run(eid);
  }
  create(owner: Owner, raw: unknown, key: string): Task {
    const input = requestSchema.parse(raw);
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(key))
      throw new StoreError("INVALID_INPUT");
    return this.db
      .transaction(() => {
        const hash = this.vault.fingerprint(input);
        const previous = this.db
          .prepare(
            "SELECT hash,task_id FROM idempotency WHERE user_id=? AND tenant_id=? AND key=?",
          )
          .get(owner.userId, owner.tenantId, key) as
          { hash: string; task_id: string } | undefined;
        if (previous) {
          if (previous.hash !== hash) throw new StoreError("CONFLICT");
          return this.get(owner, previous.task_id);
        }
        const now = this.now(),
          deadline = input.deadline ? Date.parse(input.deadline) : null;
        if (deadline !== null && deadline <= now)
          throw new StoreError("EXPIRED");
        for (const dep of input.dependencies) this.row(owner, dep);
        this.db
          .prepare(
            "INSERT OR IGNORE INTO conversations(id,user_id,tenant_id) VALUES(?,?,?)",
          )
          .run(input.conversationId, owner.userId, owner.tenantId);
        const sequence = (
          this.db
            .prepare(
              "UPDATE conversations SET next_sequence=next_sequence+1 WHERE id=? AND user_id=? AND tenant_id=? RETURNING next_sequence-1 AS sequence",
            )
            .get(input.conversationId, owner.userId, owner.tenantId) as {
            sequence: number;
          }
        ).sequence;
        const id = randomUUID();
        this.db
          .prepare(
            "INSERT INTO tasks(id,user_id,tenant_id,conversation_id,sequence,status,deadline,created_at,updated_at,input,payload_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            owner.userId,
            owner.tenantId,
            input.conversationId,
            sequence,
            "queued",
            deadline,
            now,
            now,
            this.vault.seal(input, "task:" + id),
            hash,
          );
        for (const dep of new Set(input.dependencies))
          this.db.prepare("INSERT INTO dependencies VALUES(?,?)").run(id, dep);
        this.db
          .prepare("INSERT INTO idempotency VALUES(?,?,?,?,?)")
          .run(owner.userId, owner.tenantId, key, hash, id);
        this.event(id, "created");
        return this.get(owner, id);
      })
      .immediate();
  }
  command(owner: Owner, id: string, raw: unknown): Task {
    const command = commandSchema.parse(raw);
    return this.db
      .transaction(() => {
        const r = this.row(owner, id);
        if (
          r.revision !== command.expectedRevision ||
          terminal.includes(r.status)
        )
          throw new StoreError("CONFLICT");
        if (command.command === "resume" && r.status !== "paused")
          throw new StoreError("CONFLICT");
        if (command.command === "pause" && r.status === "paused")
          throw new StoreError("CONFLICT");
        const status =
          command.command === "cancel"
            ? "cancelled"
            : command.command === "pause"
              ? "paused"
              : "queued";
        this.db
          .prepare(
            "UPDATE runs SET finished_at=?,outcome=? WHERE task_id=? AND finished_at IS NULL",
          )
          .run(this.now(), status, id);
        this.db
          .prepare(
            "UPDATE tasks SET status=?,revision=revision+1,generation=generation+1,lease_until=NULL,worker_id=NULL,updated_at=? WHERE id=?",
          )
          .run(status, this.now(), id);
        this.event(id, status);
        return this.get(owner, id);
      })
      .immediate();
  }
  claim(owner: Owner, workerId: string, leaseMs = 30_000): Claim | null {
    if (!workerId || leaseMs < 100 || leaseMs > 300_000)
      throw new StoreError("INVALID_INPUT");
    return this.db
      .transaction(() => {
        const now = this.now();
        const expired = this.db
          .prepare(
            "SELECT id FROM tasks WHERE user_id=? AND tenant_id=? AND deadline<=? AND status NOT IN ('completed','failed','cancelled','expired')",
          )
          .all(owner.userId, owner.tenantId, now) as { id: string }[];
        for (const { id } of expired) {
          this.db
            .prepare(
              "UPDATE tasks SET status='expired',revision=revision+1,generation=generation+1,lease_until=NULL,worker_id=NULL,updated_at=? WHERE id=?",
            )
            .run(now, id);
          this.db
            .prepare(
              "UPDATE runs SET finished_at=?,outcome='expired' WHERE task_id=? AND finished_at IS NULL",
            )
            .run(now, id);
          this.event(id, "expired");
        }
        const r = this.db
          .prepare(
            `SELECT t.* FROM tasks t WHERE user_id=? AND tenant_id=? AND (status='queued' OR(status='running' AND lease_until<=?)) AND next_attempt_at<=?
AND NOT EXISTS(SELECT 1 FROM tasks earlier WHERE earlier.user_id=t.user_id AND earlier.tenant_id=t.tenant_id AND earlier.conversation_id=t.conversation_id AND earlier.sequence<t.sequence AND earlier.status NOT IN ('completed','failed','cancelled','expired'))
AND NOT EXISTS(SELECT 1 FROM dependencies d JOIN tasks p ON p.id=d.depends_on WHERE d.task_id=t.id AND p.status!='completed') ORDER BY created_at,id LIMIT 1`,
          )
          .get(owner.userId, owner.tenantId, now, now) as Row | undefined;
        if (!r) return null;
        this.db
          .prepare(
            "UPDATE runs SET finished_at=?,outcome='lease_expired' WHERE task_id=? AND finished_at IS NULL",
          )
          .run(now, r.id);
        this.db
          .prepare(
            "UPDATE tasks SET status='running',revision=revision+1,generation=generation+1,lease_until=?,worker_id=?,updated_at=?,attempts=attempts+1 WHERE id=?",
          )
          .run(now + leaseMs, workerId, now, r.id);
        this.db
          .prepare(
            "INSERT INTO runs(id,task_id,generation,worker_id,started_at) VALUES(?,?,?,?,?)",
          )
          .run(randomUUID(), r.id, r.generation + 1, workerId, now);
        this.event(r.id, "claimed");
        return {
          task: this.get(owner, r.id),
          workerId,
          generation: r.generation + 1,
          leaseUntil: now + leaseMs,
        };
      })
      .immediate();
  }
  private validClaim(
    owner: Owner,
    id: string,
    worker: string,
    generation: number,
  ): Row {
    const r = this.row(owner, id);
    if (
      r.status !== "running" ||
      r.worker_id !== worker ||
      r.generation !== generation ||
      (r.lease_until ?? 0) <= this.now() ||
      (r.deadline !== null && r.deadline <= this.now())
    )
      throw new StoreError("STALE_CLAIM");
    return r;
  }
  heartbeat(
    owner: Owner,
    id: string,
    worker: string,
    generation: number,
    leaseMs = 30_000,
  ) {
    if (leaseMs < 100 || leaseMs > 300_000)
      throw new StoreError("INVALID_INPUT");
    return this.db
      .transaction(() => {
        this.validClaim(owner, id, worker, generation);
        this.db
          .prepare("UPDATE tasks SET lease_until=? WHERE id=?")
          .run(this.now() + leaseMs, id);
      })
      .immediate();
  }
  recordModel(
    owner: Owner,
    id: string,
    worker: string,
    generation: number,
    snapshot: unknown,
  ) {
    this.db
      .transaction(() => {
        this.validClaim(owner, id, worker, generation);
        const changed = this.db
          .prepare(
            "UPDATE runs SET model_snapshot=? WHERE task_id=? AND generation=? AND model_snapshot IS NULL",
          )
          .run(
            this.vault.seal(snapshot, "run:" + id + ":" + generation),
            id,
            generation,
          );
        if (changed.changes !== 1) throw new StoreError("CONFLICT");
      })
      .immediate();
  }
  runHistory(owner: Owner, id: string) {
    this.row(owner, id);
    return (
      this.db
        .prepare("SELECT * FROM runs WHERE task_id=? ORDER BY generation")
        .all(id) as {
        id: string;
        task_id: string;
        worker_id: string;
        generation: number;
        started_at: number;
        finished_at: number | null;
        outcome: string | null;
        model_snapshot: Buffer | null;
      }[]
    ).map(({ model_snapshot, ...row }) => ({
      ...row,
      model: model_snapshot
        ? this.vault.open(model_snapshot, "run:" + id + ":" + row.generation)
        : null,
    }));
  }
  complete(
    owner: Owner,
    id: string,
    worker: string,
    generation: number,
    result: unknown,
  ): Task {
    if (Buffer.byteLength(JSON.stringify(result) ?? "") > 256_000)
      throw new StoreError("INVALID_INPUT");
    return this.db
      .transaction(() => {
        this.validClaim(owner, id, worker, generation);
        this.db
          .prepare(
            "UPDATE tasks SET status='completed',revision=revision+1,result=?,lease_until=NULL,worker_id=NULL,updated_at=? WHERE id=?",
          )
          .run(this.vault.seal(result, "result:" + id), this.now(), id);
        this.db
          .prepare(
            "UPDATE runs SET finished_at=?,outcome='completed' WHERE task_id=? AND generation=?",
          )
          .run(this.now(), id, generation);
        this.event(id, "completed");
        return this.get(owner, id);
      })
      .immediate();
  }
  fail(
    owner: Owner,
    id: string,
    worker: string,
    generation: number,
    transient: boolean,
  ) {
    return this.db
      .transaction(() => {
        const r = this.validClaim(owner, id, worker, generation);
        const retry = transient && r.attempts < 3;
        this.db
          .prepare(
            "UPDATE tasks SET status=?,revision=revision+1,lease_until=NULL,worker_id=NULL,next_attempt_at=?,updated_at=? WHERE id=?",
          )
          .run(
            retry ? "queued" : "failed",
            this.now() + 1000 * 2 ** r.attempts,
            this.now(),
            id,
          );
        this.db
          .prepare(
            "UPDATE runs SET finished_at=?,outcome=? WHERE task_id=? AND generation=?",
          )
          .run(this.now(), retry ? "retry" : "failed", id, generation);
        this.event(id, retry ? "retry_scheduled" : "failed");
        return this.get(owner, id);
      })
      .immediate();
  }
  events(owner: Owner, after = 0) {
    return this.db
      .prepare(
        "SELECT e.* FROM events e JOIN tasks t ON t.id=e.task_id WHERE t.user_id=? AND t.tenant_id=? AND e.cursor>? ORDER BY cursor LIMIT 100",
      )
      .all(owner.userId, owner.tenantId, after);
  }
  pending(owner: Owner) {
    return this.db
      .prepare(
        "SELECT e.* FROM events e JOIN tasks t ON t.id=e.task_id JOIN outbox o ON o.event_id=e.id WHERE t.user_id=? AND t.tenant_id=? AND o.acknowledged_at IS NULL ORDER BY e.cursor LIMIT 100",
      )
      .all(owner.userId, owner.tenantId);
  }
  acknowledge(owner: Owner, eventId: string) {
    this.db
      .prepare(
        "UPDATE outbox SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE event_id=? AND event_id IN(SELECT e.id FROM events e JOIN tasks t ON t.id=e.task_id WHERE t.user_id=? AND t.tenant_id=?)",
      )
      .run(this.now(), eventId, owner.userId, owner.tenantId);
  }
  export(owner: Owner) {
    return (
      this.db
        .prepare(
          "SELECT * FROM tasks WHERE user_id=? AND tenant_id=? ORDER BY created_at,id",
        )
        .all(owner.userId, owner.tenantId) as Row[]
    ).map((r) => this.task(r));
  }
  createInbox(owner: Owner, raw: unknown) {
    const inbox = inboxSchema.parse(raw);
    // Personal-device pilot: agent/manager inboxes may represent only this user.
    if (
      inbox.tenantId !== owner.tenantId ||
      inbox.memberUserIds.some((id) => id !== owner.userId) ||
      (inbox.ownerType === "user" && inbox.ownerId !== owner.userId)
    )
      throw new StoreError("INVALID_INPUT");
    const purpose =
      "inbox:" + owner.tenantId + ":" + owner.userId + ":" + inbox.id;
    this.db
      .prepare(
        "INSERT INTO inboxes VALUES(?,?,?,?) ON CONFLICT(id,user_id,tenant_id) DO UPDATE SET definition=excluded.definition",
      )
      .run(
        inbox.id,
        owner.userId,
        owner.tenantId,
        this.vault.seal(inbox, purpose),
      );
    return inbox;
  }
  appendMessage(owner: Owner, raw: unknown, key: string) {
    const input = inboxMessageSchema.parse(raw);
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(key))
      throw new StoreError("INVALID_INPUT");
    return this.db
      .transaction(() => {
        const hash = this.vault.fingerprint(input);
        const prior = this.db
          .prepare(
            "SELECT id,hash FROM messages WHERE user_id=? AND tenant_id=? AND key=?",
          )
          .get(owner.userId, owner.tenantId, key) as
          { id: string; hash: string } | undefined;
        if (prior) {
          if (prior.hash !== hash) throw new StoreError("CONFLICT");
          return this.message(owner, prior.id);
        }
        const inbox = this.db
          .prepare(
            "SELECT id FROM inboxes WHERE id=? AND user_id=? AND tenant_id=?",
          )
          .get(input.recipientInboxId, owner.userId, owner.tenantId);
        if (!inbox) throw new StoreError("NOT_FOUND");
        if (
          input.requestId &&
          this.row(owner, input.requestId).conversation_id !==
            input.conversationId
        )
          throw new StoreError("INVALID_INPUT");
        if (input.replyToId) {
          const parent = this.message(owner, input.replyToId);
          if (
            parent.input.conversationId !== input.conversationId ||
            parent.input.recipientInboxId !== input.recipientInboxId
          )
            throw new StoreError("INVALID_INPUT");
        }
        this.db
          .prepare(
            "INSERT OR IGNORE INTO conversations(id,user_id,tenant_id) VALUES(?,?,?)",
          )
          .run(input.conversationId, owner.userId, owner.tenantId);
        const sequence = (
          this.db
            .prepare(
              "UPDATE conversations SET next_sequence=next_sequence+1 WHERE id=? AND user_id=? AND tenant_id=? RETURNING next_sequence-1 AS sequence",
            )
            .get(input.conversationId, owner.userId, owner.tenantId) as {
            sequence: number;
          }
        ).sequence;
        const id = randomUUID();
        this.db
          .prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?)")
          .run(
            id,
            owner.userId,
            owner.tenantId,
            input.recipientInboxId,
            input.conversationId,
            sequence,
            input.requestId ?? null,
            this.vault.seal(input, "message:" + id),
            key,
            hash,
            this.now(),
          );
        if (input.replyExpected && input.replyDueAt)
          this.db
            .prepare("INSERT INTO checkins VALUES(?,?,?,NULL)")
            .run(randomUUID(), id, Date.parse(input.replyDueAt));
        if (input.replyToId)
          this.db
            .prepare(
              "UPDATE checkins SET closed_at=COALESCE(closed_at,?) WHERE message_id=?",
            )
            .run(this.now(), input.replyToId);
        return this.message(owner, id);
      })
      .immediate();
  }
  message(owner: Owner, id: string) {
    const row = this.db
      .prepare(
        "SELECT id,content,sequence,created_at FROM messages WHERE id=? AND user_id=? AND tenant_id=?",
      )
      .get(id, owner.userId, owner.tenantId) as
      | { id: string; content: Buffer; sequence: number; created_at: number }
      | undefined;
    if (!row) throw new StoreError("NOT_FOUND");
    return {
      id: row.id,
      sequence: row.sequence,
      createdAt: row.created_at,
      input: this.vault.open<ReturnType<typeof inboxMessageSchema.parse>>(
        row.content,
        "message:" + id,
      ),
    };
  }
  messages(owner: Owner, inboxId: string, conversationId: string, after = 0) {
    return (
      this.db
        .prepare(
          "SELECT id FROM messages WHERE user_id=? AND tenant_id=? AND inbox_id=? AND conversation_id=? AND sequence>? ORDER BY sequence LIMIT 100",
        )
        .all(owner.userId, owner.tenantId, inboxId, conversationId, after) as {
        id: string;
      }[]
    ).map((r) => this.message(owner, r.id));
  }
  receipt(
    owner: Owner,
    id: string,
    kind: "delivered" | "read" | "acknowledged",
  ) {
    this.message(owner, id);
    this.db
      .prepare("INSERT OR IGNORE INTO receipts VALUES(?,?,?,?)")
      .run(id, owner.userId, kind, this.now());
  }
  checkins(owner: Owner) {
    return this.db
      .prepare(
        "SELECT c.id,c.message_id,c.due_at,c.closed_at,CASE WHEN c.closed_at IS NOT NULL THEN 'closed' WHEN c.due_at<=? THEN 'overdue' ELSE 'open' END AS status FROM checkins c JOIN messages m ON m.id=c.message_id WHERE m.user_id=? AND m.tenant_id=? ORDER BY c.due_at LIMIT 100",
      )
      .all(this.now(), owner.userId, owner.tenantId);
  }
  exportMessages(owner: Owner) {
    return (
      this.db
        .prepare(
          "SELECT id FROM messages WHERE user_id=? AND tenant_id=? ORDER BY created_at,id",
        )
        .all(owner.userId, owner.tenantId) as { id: string }[]
    ).map((r) => this.message(owner, r.id));
  }
  deleteAll(owner: Owner) {
    this.db
      .transaction(() => {
        this.db
          .prepare("DELETE FROM model_defaults WHERE user_id=? AND tenant_id=?")
          .run(owner.userId, owner.tenantId);
        this.db
          .prepare("DELETE FROM model_profiles WHERE user_id=? AND tenant_id=?")
          .run(owner.userId, owner.tenantId);
        this.db
          .prepare("DELETE FROM inboxes WHERE user_id=? AND tenant_id=?")
          .run(owner.userId, owner.tenantId);
        this.db
          .prepare(
            "DELETE FROM dependencies WHERE task_id IN(SELECT id FROM tasks WHERE user_id=? AND tenant_id=?)",
          )
          .run(owner.userId, owner.tenantId);
        this.db
          .prepare("DELETE FROM tasks WHERE user_id=? AND tenant_id=?")
          .run(owner.userId, owner.tenantId);
        this.db
          .prepare("DELETE FROM conversations WHERE user_id=? AND tenant_id=?")
          .run(owner.userId, owner.tenantId);
      })
      .immediate();
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }
  async backup(destination: string) {
    await this.db.backup(destination);
  }
  close() {
    this.db.close();
  }
}
