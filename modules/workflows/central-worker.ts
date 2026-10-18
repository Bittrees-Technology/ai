import { immediateTask, type TaskTurn } from "../agents/queue.js";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import Database from "better-sqlite3";
import { z } from "zod";
import { Vault } from "../storage/vault.js";
import { Ollama } from "../models/ollama.js";
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
});
const jobSchema = z.strictObject({
  id: z.uuid(),
  runId: z.uuid(),
  stepIndex: z.int().min(0).max(29),
  leaseId: z.uuid(),
  leaseUntil: z.string(),
  input: z.strictObject({
    title: z.string().max(120),
    instruction: z.string().max(600),
  }),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export class CentralWorkflowWorker {
  taskTurn: TaskTurn = immediateTask;
  private db: Database.Database;
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;
  constructor(
    path: string,
    private vault: Vault,
    private runtime: Ollama,
    private profile: (id: string) => unknown,
    private admission: () => { reason: string; seconds: number },
    private turn: ModelTurn,
    private request: typeof fetch = fetch,
  ) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value BLOB NOT NULL)",
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
      issuedAt: Date.now(),
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
      i = this.get("identity");
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
      lastReceipt: this.get("lastReceipt"),
    };
  }
  configure(raw: unknown) {
    if (this.running)
      throw Error(
        "Pause and wait for the current step before changing its connection.",
      );
    const c = configSchema.parse(raw);
    this.profile(c.profileId);
    this.identity();
    if (this.get("pending"))
      throw Error(
        "Resolve the current pending step before changing its connection.",
      );
    this.set("config", c);
    return this.status();
  }
  resume() {
    const c = this.get("config");
    if (!c) throw Error("Connect a workflow first.");
    this.set("config", { ...c, enabled: true });
    return this.status();
  }
  async pause() {
    const c = this.get("config");
    if (c) this.set("config", { ...c, enabled: false });
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
    const i = this.identity(),
      id = randomUUID(),
      tool = "workflow_" + operation;
    const request = {
      version: 1,
      source: "mcp.bittrees.org",
      audience: "https://roles.bittrees.org/api/authority/mcp-decision",
      requestId: randomUUID(),
      operationId: args.operationId,
      parametersDigest: hash({ tool, arguments: args }),
      issuedAt: Date.now(),
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
    const r = await this.request(
      "https://mcp.bittrees.org/mcp?mode=selected&projects=workflow",
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        headers: {
          authorization: "Bearer " + c.mcpToken,
          "content-type": "application/json",
          "x-bittrees-agent-proof": Buffer.from(JSON.stringify(proof)).toString(
            "base64url",
          ),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: tool, arguments: args },
        }),
      },
    );
    const text = await r.text();
    if (!r.ok || text.length > 64000)
      throw Error("Workflow request not confirmed. Existing work is retained.");
    const body = JSON.parse(text);
    if (body.id !== id || body.error || body.result?.isError)
      throw Error("Workflow permission or operation was rejected.");
    return body.result?.structuredContent;
  }
  tick() {
    if (this.running) return this.running;
    const c = this.get("config");
    if (!c?.enabled || this.admission().reason !== "ready")
      return Promise.resolve();
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.running = this.work(c, signal)
      .catch(() => {
        this.set("progress", {
          state: "held",
          message:
            "Workflow request or local execution needs attention; saved work is retained.",
          at: new Date().toISOString(),
        });
      })
      .finally(() => {
        this.running = null;
        this.controller = null;
      });
    return this.running;
  }
  private async work(c: any, signal: AbortSignal) {
    return this.taskTurn("Central workflow", signal, (queuedSignal) =>
      this.workExclusive(
        c,
        AbortSignal.any([
          queuedSignal,
          AbortSignal.timeout(
            Math.max(1000, Math.min(720, this.admission().seconds) * 1000),
          ),
        ]),
      ),
    );
  }
  private async workExclusive(c: any, signal: AbortSignal) {
    const base = { connectionId: c.connectionId, workflowId: c.workflowId };
    let pending = this.get("pending");
    if (!pending) {
      pending = { claimId: randomUUID() };
      this.set("pending", pending);
    }
    if (!pending.job) {
      const r = await this.call(
        c,
        "claim",
        { ...base, operationId: pending.claimId },
        signal,
      );
      if (!r?.job) {
        this.set("pending", null);
        this.set("progress", {
          state: "waiting",
          at: new Date().toISOString(),
        });
        return;
      }
      pending.job = jobSchema.parse(r.job);
      if (hash(pending.job.input) !== pending.job.inputHash)
        throw Error("Workflow input hash mismatch");
      this.set("pending", pending);
    }
    let j = pending.job;
    if (!pending.evidence && Date.parse(j.leaseUntil) <= Date.now()) {
      const recovered = await this.call(
        c,
        "claim",
        { ...base, operationId: pending.claimId },
        signal,
      );
      if (!recovered?.job || recovered.job.id !== j.id)
        throw Error("The previous lease cannot be resumed automatically.");
      const fresh = jobSchema.parse(recovered.job);
      if (fresh.inputHash !== j.inputHash) throw Error("Instruction changed");
      pending.job = fresh;
      j = fresh;
      this.set("pending", pending);
    }
    if (!pending.evidence) {
      await this.call(
        c,
        "renew",
        { ...base, operationId: randomUUID(), jobId: j.id, leaseId: j.leaseId },
        signal,
      );
      if (this.admission().reason !== "ready") return;
      const model = await this.runtime.pin(this.profile(c.profileId), signal);
      this.set("progress", {
        state: "model-running",
        runId: j.runId,
        stepIndex: j.stepIndex,
        model: model.profile.model,
        at: new Date().toISOString(),
      });
      const output = await this.turn(signal, () =>
        this.runtime.generate(
          model,
          "Execute this workflow step. Return the requested result. Do not claim to have used tools, sent messages, or changed external records: this step supports local text generation only.\n" +
            j.input.instruction,
          signal,
        ),
      );
      if (signal.aborted || !this.get("config")?.enabled) return;
      if (!output || output.length > 16000)
        throw Error("Workflow result exceeds the receipt limit");
      pending.evidence = {
        model: model.profile.model,
        modelDigest: model.digest,
        inputHash: j.inputHash,
        output,
      };
      pending.completeId = randomUUID();
      this.set("pending", pending);
      this.set("receipt:" + j.id, {
        job: j,
        evidence: pending.evidence,
        state: "pending-sync",
      });
    }
    // A new Roles proof is generated on every retry; the logical completion ID stays stable.
    const result = await this.call(
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
    );
    if (result?.completed !== true || result.runId !== j.runId)
      throw Error("Completion not confirmed");
    const receipt = {
      jobId: j.id,
      runId: j.runId,
      stepIndex: j.stepIndex,
      model: pending.evidence.model,
      evidenceHash: hash(pending.evidence),
      completedAt: new Date().toISOString(),
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
      this.set("progress", { state: "completed", ...receipt });
    })();
  }
  async close() {
    this.controller?.abort();
    await this.running;
    this.db.close();
  }
}
