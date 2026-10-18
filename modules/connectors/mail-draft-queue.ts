import Database from "better-sqlite3";
import { Vault } from "../storage/vault.js";
import { AgentQueue } from "../agents/queue.js";
import { AgentProfiles } from "../agents/profiles.js";
import { Ollama } from "../models/ollama.js";
import { generateScopedReply } from "./mail-auto-reply.js";
import {
  mailDraftRequest,
  mailDigest,
  outputDigest,
  type MailDraftRequest,
  type MailDraftResult,
} from "./mail-draft-contract.js";
type Row = {
  id: string;
  requestDigest: string;
  state: "queued" | "running" | "done" | "held";
  result?: MailDraftResult;
  profileRevision: string;
  authorityEpoch: string;
  modelDigest?: string;
};
/** Inactive adapter: no HTTP registration, sockets, mailbox access, sending or cloud model fallback.
 * Caller must supply current reviewed source authority; hashes alone never grant authority.
 */
export class MailDraftQueue {
  private db: Database.Database;
  private pending = new Map<
    string,
    { controller: AbortController; done: Promise<MailDraftResult> }
  >();
  constructor(
    path: string,
    private vault: Vault,
    private queue: AgentQueue,
    private profiles: AgentProfiles,
    private runtime: Pick<Ollama, "pin" | "generate">,
    private model: (id: string) => unknown,
    private options: {
      enabled: () => boolean;
      authorize: (request: MailDraftRequest) => string | null;
      now?: () => number;
    },
  ) {
    this.db = new Database(path);
    this.db.pragma("journal_mode=WAL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS mail_drafts(id TEXT PRIMARY KEY,value BLOB NOT NULL)",
    );
    for (const r of this.rows())
      if (r.state === "queued" || r.state === "running")
        this.save({ ...r, state: "held" });
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private rows(): Row[] {
    return (
      this.db.prepare("SELECT id,value FROM mail_drafts").all() as {
        id: string;
        value: Buffer;
      }[]
    ).map((r) => this.vault.open<Row>(r.value, "mail-draft:" + r.id));
  }
  private save(row: Row) {
    this.db
      .prepare("INSERT OR REPLACE INTO mail_drafts VALUES(?,?)")
      .run(row.id, this.vault.seal(row, "mail-draft:" + row.id));
  }
  private authorize(request: MailDraftRequest) {
    const epoch = this.options.authorize(request);
    if (!this.options.enabled() || !epoch)
      throw Error("Mail draft authority unavailable");
    return epoch;
  }
  async generate(raw: unknown): Promise<MailDraftResult> {
    const request = mailDraftRequest.parse(raw);
    const authorityEpoch = this.authorize(request);
    const digest = mailDigest(request),
      old = this.rows().find((r) => r.id === request.operationId);
    if (old) {
      if (old.authorityEpoch !== authorityEpoch)
        throw Error("Source authority changed");
      if (old.requestDigest !== digest)
        throw Error("Operation binding changed");
      if (this.pending.has(old.id)) return this.pending.get(old.id)!.done;
      if (old.result) {
        if (
          this.profiles.snapshot(this.profiles.resolve("mail-draft"))
            .revision !== old.profileRevision
        )
          throw Error("Profile changed");
        if (this.now() >= request.deadline) throw Error("Draft expired");
        return old.result;
      }
      throw Error("Interrupted operation requires reconciliation");
    }
    if (
      request.deadline <= this.now() ||
      request.deadline > this.now() + 120000
    )
      throw Error("Invalid draft deadline");
    if (this.rows().length >= 1000)
      throw Error("Mail draft history requires review");
    const snapshot = this.profiles.snapshot(
      this.profiles.resolve("mail-draft"),
    );
    if (snapshot.profile.provider !== "local")
      throw Error("Mail draft requires local model");
    const row: Row = {
      id: request.operationId,
      requestDigest: digest,
      state: "queued",
      profileRevision: snapshot.revision,
      authorityEpoch,
    };
    const reserved = this.db
      .prepare("INSERT OR IGNORE INTO mail_drafts VALUES(?,?)")
      .run(row.id, this.vault.seal(row, "mail-draft:" + row.id));
    if (reserved.changes !== 1)
      throw Error("Operation already reserved; reconcile");
    const controller = new AbortController(),
      timer = setTimeout(
        () => controller.abort(Error("Deadline exceeded")),
        request.deadline - this.now(),
      );
    let modelName = "not-run";
    const result = (
      status: MailDraftResult["status"],
      text = "",
      factIds: number[] = [],
    ): MailDraftResult => ({
      contractVersion: request.contractVersion,
      operationId: request.operationId,
      requestDigest: digest,
      status,
      text,
      factIds,
      evidence: { model: modelName, outputDigest: outputDigest(text) },
    });
    const fence = (signal: AbortSignal) => {
      signal.throwIfAborted();
      if (this.authorize(request) !== authorityEpoch)
        throw Error("Source authority changed");
      if (this.now() >= request.deadline) throw Error("Draft expired");
      if (
        this.profiles.snapshot(this.profiles.resolve("mail-draft")).revision !==
        snapshot.revision
      )
        throw Error("Agent profile changed");
    };
    const done = this.queue
      .run("Mail draft", controller.signal, async (signal) => {
        fence(signal);
        row.state = "running";
        this.save(row);
        const pinned = await this.runtime.pin(
          this.model(snapshot.profile.modelProfileId),
          signal,
        );
        modelName = pinned.profile.model;
        row.modelDigest = pinned.digest;
        this.save(row);
        fence(signal);
        const draft = await generateScopedReply(
          request.input,
          async (prompt, format) => {
            fence(signal);
            const value = await this.runtime.generate(
              pinned,
              prompt,
              signal,
              format,
            );
            fence(signal);
            return value;
          },
        );
        fence(signal);
        return draft.decision === "reply"
          ? result("draft", draft.text, draft.factIds)
          : result("needs-review");
      })
      .catch(() => result(controller.signal.aborted ? "cancelled" : "failed"))
      .then((value) => {
        row.state = "done";
        row.result = value;
        this.save(row);
        return value;
      })
      .finally(() => {
        clearTimeout(timer);
        this.pending.delete(row.id);
      });
    this.pending.set(row.id, { controller, done });
    return done;
  }
  cancel(operationId: string) {
    this.pending
      .get(operationId)
      ?.controller.abort(Error("Mail caller cancelled"));
    return {
      operationId,
      cancellationRequested: this.pending.has(operationId),
    };
  }
  async close() {
    for (const p of this.pending.values())
      p.controller.abort(Error("Adapter stopping"));
    await Promise.allSettled([...this.pending.values()].map((p) => p.done));
    this.db.close();
  }
}
