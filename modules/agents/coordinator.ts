import { CloudConnection } from "./cloud-connection.js";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { Vault } from "../storage/vault.js";
import { AgentQueue } from "./queue.js";
import { AgentProfiles, draftRequest, profilePrompt } from "./profiles.js";
import { Ollama } from "../models/ollama.js";
import { canonical } from "../contracts/canonical-json.js";
/** Typed draft adapter. Existing source workers retain their own authority and completion receipts. */
export class AgentCoordinator {
  private db: Database.Database;
  private pending = new Map<string, Promise<unknown>>();
  constructor(
    path: string,
    private vault: Vault,
    readonly queue: AgentQueue,
    readonly profiles: AgentProfiles,
    private runtime: Pick<Ollama, "pin" | "generate">,
    private model: (id: string) => unknown,
    private allowed: () => boolean,
    readonly cloud?: CloudConnection,
  ) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY,value BLOB NOT NULL)",
    );
    for (const r of this.drafts())
      if (r.state === "queued" || r.state === "running")
        this.save({
          ...r,
          state: "held",
          reason: "Interrupted operation; review before resubmitting",
        });
  }
  private save(r: any) {
    this.db
      .prepare("INSERT OR REPLACE INTO drafts VALUES(?,?)")
      .run(r.id, this.vault.seal(r, "agent-draft:" + r.id));
  }
  drafts(): any[] {
    return (
      this.db.prepare("SELECT id,value FROM drafts ORDER BY rowid").all() as {
        id: string;
        value: Buffer;
      }[]
    ).map((r) => this.vault.open<any>(r.value, "agent-draft:" + r.id));
  }
  status() {
    return {
      queue: this.queue.status(),
      profiles: this.profiles.list(),
      bindings: this.profiles.bindings(),
      drafts: this.drafts().slice(-100),
      openRouter: this.cloud?.status() ?? {
        enabled: false,
        reason: "Cloud connection unavailable",
      },
      transport: {
        local: "Authenticated loopback REST",
        remote: "HTTPS REST transport prepared; no remote peer enrolled",
      },
    };
  }
  submit(raw: unknown) {
    const input = draftRequest.parse(raw);
    const inputHash = createHash("sha256")
      .update(canonical(input))
      .digest("hex");
    const old = this.drafts().find((d) => d.id === input.operationId);
    if (old) {
      if (old.inputHash !== inputHash)
        throw Error("Operation ID already used with different input");
      return { id: old.id, state: old.state };
    }
    if (!this.allowed()) throw Error("Local execution is paused");
    if (this.drafts().length >= 1000)
      throw Error("Draft storage full; export before continuing");
    const snapshot = this.profiles.snapshot(
      this.profiles.resolve(input.workflow, input.agentProfileId),
    );
    if (
      snapshot.profile.provider === "openrouter" &&
      (!input.cloudConsent || !this.cloud?.status().enabled)
    )
      throw Error(
        "Cloud task needs an enabled connection and explicit export confirmation",
      );
    const row: any = {
      id: input.operationId,
      inputHash,
      input,
      snapshot,
      state: "queued",
      createdAt: Date.now(),
    };
    this.save(row);
    const done = this.queue
      .run(
        "Agent: " + snapshot.profile.name,
        new AbortController().signal,
        async (signal) => {
          if (!this.allowed()) throw Error("Local execution paused");
          if (
            this.profiles.snapshot(this.profiles.get(snapshot.profile.id))
              .revision !== snapshot.revision
          )
            throw Error("Profile changed; review queued task");
          row.state = "running";
          this.save(row);
          const prompt = profilePrompt(snapshot.profile, input.instruction);
          let model: { profile: { model: string }; digest: string };
          let output: string;
          let remoteReceipt: unknown;
          if (snapshot.profile.provider === "openrouter") {
            if (!input.cloudConsent || !this.cloud)
              throw Error("Cloud export not approved");
            const remote = await this.cloud.generate(
              prompt,
              snapshot.profile.modelProfileId,
              signal,
              input.operationId,
            );
            output = remote.output;
            model = {
              profile: { model: remote.model },
              digest: "remote-provider-receipt",
            };
            remoteReceipt = remote;
          } else {
            model = await this.runtime.pin(
              this.model(snapshot.profile.modelProfileId),
              signal,
            );
            output = await this.runtime.generate(model as any, prompt, signal);
          }
          signal.throwIfAborted();
          if (!this.allowed()) throw Error("Local authority changed");
          if (
            this.profiles.snapshot(this.profiles.get(snapshot.profile.id))
              .revision !== snapshot.revision
          )
            throw Error("Profile changed during execution");
          row.state = "draft";
          row.receipt = {
            remoteReceipt,
            model: model.profile.model,
            digest: model.digest,
            profileRevision: snapshot.revision,
            inputHash,
            output,
            sourceWrites: false,
            completedAt: Date.now(),
          };
          this.save(row);
        },
      )
      .catch(() => {
        row.state = "held";
        row.reason =
          "Cancelled, unavailable model, changed profile or authority. No source completion claimed.";
        this.save(row);
      })
      .finally(() => this.pending.delete(row.id));
    this.pending.set(row.id, done);
    return { id: row.id, state: "queued" };
  }
  async close() {
    await Promise.all(this.pending.values());
    this.db.close();
    this.profiles.close();
    this.cloud?.close();
  }
}
