import { immediateTask, type TaskTurn } from "../agents/queue.js";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import Database from "better-sqlite3";
import { z } from "zod";
import { Vault } from "../storage/vault.js";
import { Ollama } from "../models/ollama.js";
import {
  centralWorkflowResponse,
  CentralWorkflowDenied,
} from "./central-response.js";
import {
  CentralFinitePilot,
  finitePilotReviewSchema,
} from "./central-finite-pilot.js";
import type { ModelTurn } from "../models/local-turns.js";
import { canonical } from "../contracts/canonical-json.js";
export { canonical } from "../contracts/canonical-json.js";

const hash = (v: any) =>
  createHash("sha256").update(canonical(v)).digest("hex");
const configSchema = z.strictObject({
  confirmed: z.literal(true),
  enabled: z.boolean(),
  tenant: z.string().min(1).max(128),
  workspace: z.string().min(1).max(128),
  connectionId: z.uuid(),
  workflowId: z.string().min(1).max(128),
  delegationId: z.uuid(),
  profileId: z.uuid(),
  mcpToken: z.string().min(16).max(4096).regex(/^\S+$/),
  finitePilot: finitePilotReviewSchema.optional(),
});
const jobSchema = z
  .strictObject({
    id: z.uuid(),
    runId: z.uuid(),
    stepIndex: z.int().min(0).max(29),
    leaseId: z.uuid(),
    leaseUntil: z.iso.datetime({ offset: true }),
    input: z.strictObject({
      title: z.string().max(120),
      instruction: z.string().max(600),
    }),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine(
    (job) => hash(job.input) === job.inputHash,
    "Workflow input hash mismatch",
  );
export class CentralWorkflowWorker {
  taskTurn: TaskTurn = immediateTask;
  private db: Database.Database;
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private finite: CentralFinitePilot;
  constructor(
    path: string,
    private vault: Vault,
    private runtime: Ollama,
    private profile: (id: string) => unknown,
    private admission: () => { reason: string; seconds: number },
    private turn: ModelTurn,
    private request: typeof fetch = fetch,
    private now = Date.now,
  ) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value BLOB NOT NULL)",
    );
    this.finite = new CentralFinitePilot(
      {
        read: () => this.get("finitePilot"),
        write: (s) => this.set("finitePilot", s),
        atomic: (f) => this.db.transaction(f).immediate(),
      },
      this.now,
    );
  }
  private get(key: string): any {
    const r = this.db
      .prepare("SELECT value FROM state WHERE key=?")
      .get(key) as { value: Buffer } | undefined;
    return r ? this.vault.open(r.value, "central-workflows:" + key) : null;
  }
  private set(key: string, value: any) {
    this.db
      .prepare("INSERT OR REPLACE INTO state(key,value) VALUES(?,?)")
      .run(key, this.vault.seal(value, "central-workflows:" + key));
  }
  private identity() {
    let i = this.get("identity");
    if (!i) {
      const k = generateKeyPairSync("ed25519", {
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      i = {
        principal: "agent:" + randomUUID(),
        ...k,
        credentialId: createHash("sha256").update(k.publicKey).digest("hex"),
      };
      this.set("identity", i);
    }
    return i;
  }
  enrollment(profileId: string) {
    z.uuid().parse(profileId);
    const i = this.identity();
    const request = {
      version: 1,
      audience: "https://mcp.bittrees.org",
      profileId,
      principal: i.principal,
      publicKey: i.publicKey,
      expiresAt: null,
      issuedAt: this.now(),
      nonce: randomUUID(),
    };
    return {
      request,
      signature: sign(
        null,
        Buffer.from(
          "Bittrees principal credential enrollment v1\n" + canonical(request),
        ),
        i.privateKey,
      ).toString("base64"),
    };
  }
  status() {
    const c = this.get("config"),
      i = this.get("identity"),
      pending = this.get("pending");
    return {
      configured: !!c,
      enabled: c?.enabled === true,
      running: !!this.running,
      principal: i?.principal ?? null,
      publicKey: i?.publicKey ?? null,
      credentialId: i?.credentialId ?? null,
      workflowId: c?.workflowId ?? null,
      connectionId: c?.connectionId ?? null,
      progress: this.get("progress"),
      pending: !!this.get("pending"),
      currentJob: pending?.job
        ? {
            id: pending.job.id,
            runId: pending.job.runId,
            stepIndex: pending.job.stepIndex,
            title: pending.job.input.title,
            leaseUntil: pending.job.leaseUntil,
            completionPending: !!pending.evidence,
          }
        : null,
      lastReceipt: this.get("lastReceipt"),
      finitePilot: this.finite.snapshot(),
      generationUncertain: this.generationUncertain(pending),
    };
  }
  configure(raw: unknown) {
    if (this.running)
      throw Error(
        "Pause and wait for the current step before changing its connection.",
      );
    const c = configSchema.parse(raw);
    this.profile(c.profileId);
    if (c.finitePilot && !this.get("identity"))
      throw Error(
        "Review an existing central identity before configuring a finite pilot",
      );
    if (this.get("pending"))
      throw Error(
        "Resolve the current pending step before changing its connection.",
      );
    this.finite.configure(c);
    if (!c.finitePilot) this.identity();
    this.set("config", c);
    return this.status();
  }
  resume() {
    const c = this.get("config");
    if (!c) throw Error("Connect a workflow first.");
    if (this.generationUncertain(this.get("pending")))
      throw Error("Reconcile the uncertain model turn before resuming");
    this.finite.assert(c);
    this.set("config", { ...c, enabled: true });
    return this.status();
  }
  async pause() {
    const c = this.get("config");
    if (c) {
      this.finite.stop(c, "paused");
      this.set("config", { ...c, enabled: false });
    }
    this.controller?.abort();
    await this.running;
    return this.status();
  }
  private async call(
    c: any,
    operation: string,
    args: any,
    signal: AbortSignal,
  ) {
    this.finite.reserve(c, operation, args.operationId);
    const i = this.get("identity");
    if (!i)
      throw Error("Existing central identity unavailable; no key was created");
    const id = randomUUID(),
      tool = "workflow_" + operation;
    const request = {
      version: 1,
      source: "mcp.bittrees.org",
      audience: "https://roles.bittrees.org/api/authority/mcp-decision",
      requestId: randomUUID(),
      operationId: args.operationId,
      parametersDigest: hash({ tool, arguments: args }),
      issuedAt: this.now(),
      principal: i.principal,
      credentialId: i.credentialId,
      delegationId: c.delegationId,
      tenant: c.tenant,
      workspace: c.workspace,
      project: "workflow",
      resource: "workflow:" + c.workflowId,
      action: "workflow:" + operation,
      stage: "execute",
    };
    const proof = {
      request,
      signature: sign(
        null,
        Buffer.from("Bittrees MCP authority request v1\n" + canonical(request)),
        i.privateKey,
      ).toString("base64"),
    };
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
    const r = await this.bounded(
      () =>
        this.request(
          "https://mcp.bittrees.org/mcp?mode=selected&projects=workflow",
          {
            method: "POST",
            redirect: "error",
            signal: bounded,
            headers: {
              authorization: "Bearer " + c.mcpToken,
              "content-type": "application/json",
              "x-bittrees-agent-proof": Buffer.from(
                JSON.stringify(proof),
              ).toString("base64url"),
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: { name: tool, arguments: args },
            }),
          },
        ),
      bounded,
    );
    this.finite.assert(c);
    const result = await centralWorkflowResponse(r, id, bounded);
    this.finite.assert(c);
    return result;
  }
  private generationUncertain(pending: any) {
    return Boolean(
      pending &&
      !pending.evidence &&
      (pending.generation ||
        (pending.job && pending.journalVersion !== 2) ||
        this.get("progress")?.state === "model-running"),
    );
  }
  private async bounded<T>(action: () => Promise<T>, signal: AbortSignal) {
    let cleanup = () => {};
    try {
      signal.throwIfAborted();
      const aborted = new Promise<never>((_, reject) => {
        const stop = () =>
          reject(Error("Central work cancelled; reconcile saved operation"));
        signal.addEventListener("abort", stop, { once: true });
        cleanup = () => signal.removeEventListener("abort", stop);
      });
      return await Promise.race([action(), aborted]);
    } finally {
      cleanup();
    }
  }
  tick() {
    if (this.running) return this.running;
    const c = this.get("config");
    if (!c?.enabled) return Promise.resolve();
    try {
      this.finite.assert(c);
      if (this.generationUncertain(this.get("pending")))
        throw Error("Uncertain generation requires reconciliation");
    } catch {
      this.set("config", { ...c, enabled: false });
      try {
        this.finite.stop(c, "held");
      } catch {}
      this.set("progress", {
        state: "held",
        message:
          "Finite review or saved model operation needs reconciliation; no automatic execution was performed.",
        at: new Date(this.now()).toISOString(),
      });
      return Promise.resolve();
    }
    if (this.admission().reason !== "ready") return Promise.resolve();
    this.controller = new AbortController();
    const signal = c.finitePilot
      ? AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(
            Math.max(1, c.finitePilot.expiresAt - this.now()),
          ),
        ])
      : this.controller.signal;
    this.running = this.work(c, signal)
      .catch((error) => {
        const pending = this.get("pending"),
          uncertain = this.generationUncertain(pending);
        const reconcile =
          !(error instanceof CentralWorkflowDenied) &&
          !signal.aborted &&
          this.get("config")?.enabled &&
          pending?.evidence &&
          pending.completeId &&
          this.finite.canReconcile(c, pending.completeId);
        if (uncertain || (c.finitePilot && !reconcile)) {
          const current = this.get("config");
          if (current) this.set("config", { ...current, enabled: false });
          try {
            this.finite.stop(c, uncertain ? "uncertain-generation" : "held");
          } catch {}
        }
        this.set("progress", {
          state: reconcile ? "completion-reconciliation-pending" : "held",
          message: uncertain
            ? "Model turn outcome is uncertain; automatic regeneration is stopped. Reconcile the saved operation."
            : "Workflow request or local execution needs attention; saved work is retained.",
          at: new Date(this.now()).toISOString(),
        });
      })
      .finally(() => {
        this.running = null;
        this.controller = null;
      });
    return this.running;
  }
  private async work(c: any, signal: AbortSignal) {
    return this.bounded(
      () =>
        this.taskTurn("Central workflow", signal, (queuedSignal) =>
          this.workExclusive(
            c,
            AbortSignal.any([
              queuedSignal,
              AbortSignal.timeout(
                Math.max(1000, Math.min(720, this.admission().seconds) * 1000),
              ),
            ]),
          ),
        ),
      signal,
    );
  }
  private async workExclusive(c: any, signal: AbortSignal) {
    signal.throwIfAborted();
    this.finite.assert(c);
    if (this.generationUncertain(this.get("pending")))
      throw Error("Uncertain model turn cannot be repeated");
    const base = { connectionId: c.connectionId, workflowId: c.workflowId };
    let pending = this.get("pending");
    if (!pending) {
      pending = { journalVersion: 2, claimId: randomUUID() };
      this.set("pending", pending);
    }
    if (!pending.job) {
      const r = z
        .strictObject({ job: jobSchema.nullable() })
        .parse(
          await this.call(
            c,
            "claim",
            { ...base, operationId: pending.claimId },
            signal,
          ),
        );
      if (!r?.job) {
        if (c.finitePilot) {
          this.finite.stop(c, "no-work");
          this.set("config", { ...this.get("config"), enabled: false });
        }
        this.set("pending", null);
        this.set("progress", {
          state: "waiting",
          at: new Date(this.now()).toISOString(),
        });
        return;
      }
      pending.job = jobSchema.parse(r.job);
      this.set("pending", pending);
    }
    let j = pending.job;
    if (c.finitePilot && (j.runId !== c.finitePilot.runId || j.stepIndex !== 0))
      throw Error("Finite pilot returned a different run or step");
    if (!pending.evidence && Date.parse(j.leaseUntil) <= this.now()) {
      if (c.finitePilot)
        throw Error("Finite pilot lease expired; no automatic reclaim");
      const recovered = z
        .strictObject({ job: jobSchema.nullable() })
        .parse(
          await this.call(
            c,
            "claim",
            { ...base, operationId: pending.claimId },
            signal,
          ),
        );
      if (!recovered?.job || recovered.job.id !== j.id)
        throw Error("The previous lease cannot be resumed automatically.");
      const fresh = jobSchema.parse(recovered.job);
      if (
        fresh.inputHash !== j.inputHash ||
        fresh.runId !== j.runId ||
        fresh.stepIndex !== j.stepIndex ||
        canonical(fresh.input) !== canonical(j.input)
      )
        throw Error("The saved workflow step changed during lease recovery");
      pending.job = fresh;
      j = fresh;
      this.set("pending", pending);
    }
    if (!pending.evidence) {
      if (this.generationUncertain(pending))
        throw Error("Uncertain model turn cannot be repeated");
      if (c.finitePilot && !pending.renewId) {
        pending.renewId = randomUUID();
        this.set("pending", pending);
      }
      const renewed = z
        .strictObject({
          leaseUntil: z.iso.datetime({ offset: true }),
        })
        .parse(
          await this.call(
            c,
            "renew",
            {
              ...base,
              operationId: pending.renewId ?? randomUUID(),
              jobId: j.id,
              leaseId: j.leaseId,
            },
            signal,
          ),
        );
      const leaseUntil = Date.parse(renewed.leaseUntil);
      // The source issues fifteen-minute leases. Never begin a model turn on
      // an expired, unbounded or unconfirmed renewal response.
      if (leaseUntil <= this.now() || leaseUntil > this.now() + 16 * 60000)
        throw Error("Workflow lease renewal could not be confirmed");
      pending.job = { ...j, leaseUntil: renewed.leaseUntil };
      j = pending.job;
      this.set("pending", pending);
      if (this.admission().reason !== "ready") {
        if (c.finitePilot) throw Error("Finite pilot admission changed");
        return;
      }
      const model = await this.bounded(
        () => this.runtime.pin(this.profile(c.profileId), signal),
        signal,
      );
      signal.throwIfAborted();
      this.finite.assert(c);
      this.db
        .transaction(() => {
          const latest = this.get("pending");
          if (
            !latest ||
            latest.job?.id !== j.id ||
            latest.evidence ||
            this.generationUncertain(latest)
          )
            throw Error("Saved model operation changed or is uncertain");
          this.finite.model(c);
          latest.generation = {
            operationId: randomUUID(),
            state: "started",
            invoked: false,
            inputHash: j.inputHash,
            model: model.profile.model,
            modelDigest: model.digest,
            startedAt: this.now(),
          };
          this.set("pending", latest);
          pending = latest;
        })
        .immediate();
      this.set("progress", {
        state: "model-running",
        runId: j.runId,
        stepIndex: j.stepIndex,
        model: model.profile.model,
        at: new Date(this.now()).toISOString(),
      });
      const output = await this.bounded(
        () =>
          this.turn(signal, () => {
            signal.throwIfAborted();
            this.finite.assert(c);
            if (!this.get("config")?.enabled)
              throw Error("Model operation was stopped before invocation");
            this.db
              .transaction(() => {
                const latest = this.get("pending");
                if (
                  !latest ||
                  latest.job?.id !== j.id ||
                  latest.job.inputHash !== j.inputHash ||
                  latest.generation?.operationId !==
                    pending.generation.operationId ||
                  latest.generation.invoked ||
                  latest.evidence
                )
                  throw Error("Model operation was already invoked or changed");
                latest.generation.invoked = true;
                latest.generation.invokedAt = this.now();
                this.set("pending", latest);
                pending = latest;
              })
              .immediate();
            signal.throwIfAborted();
            return this.runtime.generate(
              model,
              "Execute this workflow step. Return the requested result. Do not claim to have used tools, sent messages, or changed external records: this step supports local text generation only.\n" +
                j.input.instruction,
              signal,
            );
          }),
        signal,
      );
      if (signal.aborted || !this.get("config")?.enabled)
        throw Error("Model result was interrupted; reconcile saved operation");
      this.finite.assert(c);
      if (!output || output.length > 16000)
        throw Error("Workflow result exceeds the receipt limit");
      pending.evidence = {
        model: model.profile.model,
        modelDigest: model.digest,
        inputHash: j.inputHash,
        output,
      };
      pending.generation.state = "recorded";
      pending.completeId = randomUUID();
      this.set("pending", pending);
      this.set("receipt:" + j.id, {
        job: j,
        evidence: pending.evidence,
        state: "pending-sync",
      });
    }
    // A new Roles proof is generated on every retry; the logical completion ID stays stable.
    const result = z
      .strictObject({
        completed: z.literal(true),
        runId: z.uuid(),
        followUpQueued: z.boolean(),
        replayed: z.boolean().optional(),
      })
      .parse(
        await this.call(
          c,
          "complete",
          {
            ...base,
            operationId: pending.completeId,
            jobId: j.id,
            leaseId: j.leaseId,
            evidence: pending.evidence,
          },
          signal,
        ),
      );
    if (result?.completed !== true || result.runId !== j.runId)
      throw Error("Completion not confirmed");
    const receipt = {
      jobId: j.id,
      workflowId: c.workflowId,
      connectionId: c.connectionId,
      runId: j.runId,
      stepIndex: j.stepIndex,
      model: pending.evidence.model,
      evidenceHash: hash(pending.evidence),
      completedAt: new Date(this.now()).toISOString(),
      followUpQueued: result.followUpQueued === true,
    };
    this.db.transaction(() => {
      this.set("receipt:" + j.id, {
        ...receipt,
        evidence: pending.evidence,
        state: "completed",
      });
      this.set("lastReceipt", receipt);
      this.set("pending", null);
      if (c.finitePilot) {
        this.finite.stop(
          c,
          result.followUpQueued ? "unexpected-successor" : "terminal",
        );
        this.set("config", { ...this.get("config"), enabled: false });
      }
      this.set("progress", {
        state: c.finitePilot && result.followUpQueued ? "held" : "completed",
        ...receipt,
      });
    })();
  }
  async close() {
    this.controller?.abort();
    await this.running;
    this.db.close();
  }
}
