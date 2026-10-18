import { RuntimeHandoff } from "./handoff.js";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import Database from "better-sqlite3";
import { z } from "zod";
import { exchangeActivation, type ActivationScope } from "./activation.js";
import {
  runtimeEnrollmentSchema,
  runtimeEnrollmentMessage,
} from "./runtime-contract.js";
import { Vault } from "../storage/vault.js";
import { canonical } from "../contracts/canonical-json.js";
import {
  activeLease,
  digest,
  signChallenges,
  taskContent,
  validateChallenge,
  type SyncIdentity,
  type SyncTask,
} from "./proof-contract.js";
const SOURCE = "https://agent.bittrees.org/tasks.json";
const taskSchema = z.strictObject({
  content: taskContent.strict(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  destination: z.strictObject({ projectId: z.uuid(), workspaceId: z.uuid() }),
});
const identitySchema = z.strictObject({
  principal: z.string().regex(/^agent:[a-f0-9-]{36}$/),
  credentialId: z.string().regex(/^[a-f0-9]{64}$/),
  tenant: z.string().min(1).max(128),
  workspace: z.string().min(1).max(128),
  sourceWorkspace: z.uuid(),
  subject: z.string().min(1).max(128),
  leaseId: z.uuid(),
  runtimeBindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  activatedAt: z.number().finite(),
  expiresAt: z.number().finite(),
});
const approvalSchema = z.strictObject({
  identity: identitySchema,
  token: z.string().min(16).max(4096).regex(/^\S+$/),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  tasks: z.array(taskSchema).min(1).max(1000),
  mappings: z
    .array(
      z.strictObject({
        sourceProjectId: z.string().min(1).max(128),
        siteUrl: z.string().url().nullable(),
        crmProjectId: z.uuid(),
        workspaceId: z.uuid(),
      }),
    )
    .min(1)
    .max(100),
});
type Approval = z.infer<typeof approvalSchema>;
class Held extends Error {}
/** One-shot deterministic source sync. Does not claim the local model authored or completed imported tasks. */
export class TaskSyncRunner {
  private db: Database.Database;
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private handoff: RuntimeHandoff;
  private reviewing: Promise<void> | null = null;
  constructor(
    path: string,
    private vault: Vault,
    private verifyActivation: (
      input: unknown,
      device: ReturnType<TaskSyncRunner["device"]>,
    ) => Promise<unknown> = async () => {
      throw new Held("Verified Roles activation is required");
    },
    private request: typeof fetch = fetch,
    private now = () => Date.now(),
    private attestProof: (
      request: unknown,
      signature: string,
      signal: AbortSignal,
    ) => Promise<unknown> = async () => {
      throw new Held("Runtime attestation is not configured");
    },
    attestRuntime: (
      purpose: "enroll" | "activate",
      request: unknown,
      signature: string,
    ) => Promise<unknown> = async () => {
      throw new Held("Device attestation unavailable");
    },
  ) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value BLOB NOT NULL)",
    );
    this.handoff = new RuntimeHandoff(
      () => this.get("handoff"),
      (s) => {
        this.put("handoff", s);
        if (s.status === "complete" && s.candidate.kind === "enroll")
          this.put("enrollment", s.result);
      },
      () => this.device(),
      (message) =>
        sign(null, Buffer.from(message), this.key().privateKey).toString(
          "base64",
        ),
      attestRuntime,
      this.request,
      this.now,
    );
  }
  private get(key: string): any {
    const row = this.db
      .prepare("SELECT value FROM state WHERE key=?")
      .get(key) as { value: Buffer } | undefined;
    return row ? this.vault.open(row.value, "task-sync:" + key) : null;
  }
  private put(key: string, value: unknown) {
    this.db
      .prepare("INSERT OR REPLACE INTO state(key,value) VALUES(?,?)")
      .run(key, this.vault.seal(value, "task-sync:" + key));
  }
  private key() {
    let k = this.get("key");
    if (!k) {
      const pair = generateKeyPairSync("ed25519", {
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      k = { ...pair, principal: "agent:" + randomUUID() };
      this.put("key", k);
    }
    return k;
  }
  device() {
    const k = this.key();
    return {
      principal: k.principal,
      publicKey: k.publicKey,
      credentialId: digestPem(k.publicKey),
    };
  }
  enrollment(input: {
    profileId: string;
    authorityId: string;
    deviceId: string;
    sourceWorkspace: string;
  }) {
    const device = this.device();
    const request = runtimeEnrollmentSchema.parse({
      version: 1,
      audience: "https://mcp.bittrees.org",
      ...input,
      principal: device.principal,
      publicKey: device.publicKey,
      issuedAt: this.now(),
      nonce: randomUUID(),
    });
    return {
      request,
      signature: sign(
        null,
        Buffer.from(runtimeEnrollmentMessage(request)),
        this.key().privateKey,
      ).toString("base64"),
    };
  }
  configureReview(input: unknown) {
    if (
      this.get("approval") ||
      this.get("enrollment") ||
      ["pending", "approved"].includes(this.handoff.status()?.status || "")
    )
      throw new Held("A pending or enrolled review cannot be replaced");
    const review = approvalSchema
      .omit({ identity: true, token: true })
      .extend({ sourceWorkspace: z.uuid() })
      .parse(input);
    if (
      review.tasks.some(
        (t) =>
          t.destination.workspaceId !== review.sourceWorkspace ||
          digest(t.content) !== t.fingerprint,
      )
    )
      throw new Held("Invalid source review");
    this.put("review", review);
    return this.status();
  }
  async startEnrollment(device: {
    authorityId: string;
    deviceId: string;
    ownerWallet: string;
  }) {
    const review = this.get("review");
    if (!review)
      throw new Held("Select a reviewed synchronization workflow first");
    return this.handoff.start({
      kind: "enroll",
      ...device,
      sourceWorkspace: review.sourceWorkspace,
    });
  }
  async startActivation(input: { leaseId: string; policyDigest: string }) {
    const e = this.get("enrollment");
    if (!e) throw new Held("Enroll this Mac first");
    const b = e.binding;
    return this.handoff.start({
      kind: "activate",
      authorityId: b.authorityId,
      deviceId: b.deviceId,
      ownerWallet: b.ownerWallet,
      sourceWorkspace: b.sourceWorkspace,
      runtimeBindingDigest: e.runtimeBindingDigest,
      ...input,
    });
  }
  prepareActivation(input: unknown) {
    if (this.get("approval")) throw new Held("Already activated");
    this.put(
      "activationReview",
      z
        .strictObject({
          leaseId: z.uuid(),
          policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .parse(input),
    );
    return this.status();
  }
  async requestActivation() {
    const input = this.get("activationReview");
    if (!input) throw new Held("A finalized permission review is required");
    return this.startActivation(input);
  }
  pollOwnerReview(rolesPublicKey?: string) {
    if (this.reviewing) return this.reviewing;
    this.reviewing = this.ownerReview(rolesPublicKey).finally(() => {
      this.reviewing = null;
    });
    return this.reviewing;
  }
  private async ownerReview(rolesPublicKey?: string) {
    await this.handoff.tick();
    const h = this.handoff.status(),
      result = this.handoff.result();
    if (
      h?.kind !== "activate" ||
      h.status !== "complete" ||
      this.get("approval") ||
      !rolesPublicKey
    )
      return;
    const e = this.get("enrollment"),
      review = this.get("review"),
      candidate = this.get("handoff").candidate;
    if (!e || !review) throw new Held("Missing saved enrollment or review");
    const b = e.binding;
    const attempts = this.get("connectionAttempts") || 0;
    if (attempts >= 3 || (this.get("connectionRetryAt") || 0) > this.now())
      return;
    this.put("connectionAttempts", attempts + 1);
    this.put("connectionRetryAt", this.now() + 30000);
    try {
      await this.activateReceipt(
        { receipt: result.receipt, signature: result.signature },
        {
          principal: b.principal,
          credentialId: b.credentialId,
          tenant: b.tenant,
          workspace: b.workspace,
          sourceWorkspace: b.sourceWorkspace,
          subject: b.principal,
          leaseId: candidate.leaseId,
          policyDigest: candidate.policyDigest,
          runtimeBindingDigest: e.runtimeBindingDigest,
          projectIds: [
            ...new Set([
              "crm",
              ...review.mappings.map((m: any) => m.sourceProjectId),
            ]),
          ],
        },
        rolesPublicKey,
        {
          revision: review.revision,
          tasks: review.tasks,
          mappings: review.mappings,
        },
      );
      this.put("connectionError", null);
    } catch {
      this.put(
        "connectionError",
        "Synchronization has not started because the approved connection could not be verified. Check the connection before retrying.",
      );
    }
  }
  retryConnection() {
    if (this.get("approval")) throw new Held("Already connected");
    this.put("connectionAttempts", 0);
    this.put("connectionRetryAt", 0);
    this.put("connectionError", null);
    return this.status();
  }
  status() {
    const a = this.get("approval"),
      receipts = this.get("receipts") || [];
    return {
      configured: !!a,
      reviewReady: !!this.get("review"),
      enrolled: !!this.get("enrollment"),
      enrollment: this.get("enrollment"),
      activationReady: !!this.get("activationReview"),
      connectionError: this.get("connectionError"),
      ownerReview: this.handoff.status(),
      enabled: this.get("enabled") === true,
      running: !!this.running,
      progress: this.get("progress"),
      completedImports: receipts.length,
      total: a?.tasks.length || 0,
      expiresAt: a?.identity.expiresAt ?? null,
      device: this.get("key") ? this.device() : null,
      receipts,
    };
  }
  async activate(input: unknown) {
    return this.saveActivation(
      await this.verifyActivation(input, this.device()),
    );
  }
  async activateReceipt(
    receipt: unknown,
    scope: ActivationScope,
    rolesPublicKey: string,
    review: Pick<Approval, "revision" | "tasks" | "mappings">,
  ) {
    const d = this.device();
    if (
      scope.principal !== d.principal ||
      scope.credentialId !== d.credentialId ||
      scope.subject !== d.principal
    )
      throw new Held("Activation is for a different device");
    if (this.running || this.get("approval"))
      throw new Held("This runner already has an activation");
    const task = review.tasks[0];
    if (!task) throw new Held("Review the source tasks first");
    const connection = await exchangeActivation(
      receipt,
      scope,
      rolesPublicKey,
      task,
      async (challenge, identity, signal) => {
        const proof = JSON.parse(
          Buffer.from(
            signChallenges(
              [challenge],
              this.key().privateKey,
              identity,
              this.now(),
            ),
            "base64url",
          ).toString(),
        ).proofs[0];
        proof.attestation = await this.attestProof(
          proof.request,
          proof.signature,
          signal,
        );
        return proof;
      },
      this.request,
      this.now,
    );
    return this.saveActivation({ ...review, ...connection });
  }
  private saveActivation(input: unknown) {
    if (this.running || this.get("approval"))
      throw new Held(
        "This runner already has an activation; do not renew or replace it",
      );
    const a = approvalSchema.parse(input);
    activeLease(a.identity, this.now());
    const device = this.device();
    if (
      a.identity.principal !== device.principal ||
      a.identity.subject !== device.principal ||
      a.identity.credentialId !== device.credentialId
    )
      throw new Held("Activation is for a different device");
    const ids = new Set<string>();
    for (const t of a.tasks) {
      if (
        ids.has(t.content.sourceId) ||
        digest(t.content) !== t.fingerprint ||
        !a.mappings.some(
          (m) =>
            m.sourceProjectId === t.content.projectId &&
            m.crmProjectId === t.destination.projectId &&
            m.workspaceId === t.destination.workspaceId,
        ) ||
        t.destination.workspaceId !== a.identity.sourceWorkspace
      )
        throw new Held("Invalid reviewed task or destination");
      ids.add(t.content.sourceId);
    }
    this.db.transaction(() => {
      this.put("approval", a);
      this.put("enabled", true);
      this.put("receipts", []);
      this.put("progress", { state: "ready" });
    })();
    return this.status();
  }
  async pause() {
    this.put("enabled", false);
    this.controller?.abort();
    await this.running;
    return this.status();
  }
  resume() {
    const a = this.get("approval");
    if (
      !a ||
      ["held", "expired", "finished"].includes(this.get("progress")?.state)
    )
      throw new Held("Review the stopped run before continuing");
    activeLease(a.identity, this.now());
    this.put("enabled", true);
    return this.status();
  }
  tick() {
    if (this.running) return this.running;
    const a = this.get("approval") as Approval | null;
    if (!a || !this.get("enabled")) return Promise.resolve();
    this.controller = new AbortController();
    const signal = AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(
        Math.max(1, Math.min(60000, a.identity.expiresAt - this.now())),
      ),
    ]);
    this.running = this.work(a, signal)
      .catch((e) => {
        if (!this.get("enabled")) return;
        const expired = this.now() >= a.identity.expiresAt;
        const held = e instanceof Held || expired;
        this.put("progress", {
          state: expired ? "expired" : held ? "held" : "retry-pending",
          message: held
            ? e.message
            : "Transport not confirmed; exact pending work retained.",
        });
        if (held) this.put("enabled", false);
      })
      .finally(() => {
        this.running = null;
        this.controller = null;
      });
    return this.running;
  }
  private async read(response: Response, max: number) {
    const reader = response.body?.getReader();
    if (!reader) throw new Held("Missing response");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        size += r.value.length;
        if (size > max) throw new Held("Response exceeds limit");
        chunks.push(r.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString());
    } finally {
      await reader.cancel();
    }
  }
  private async source(a: Approval, signal: AbortSignal) {
    const r = await this.request(SOURCE, { redirect: "error", signal });
    if (!r.ok) throw Error("Source unavailable");
    const feed = (await this.read(r, 2_000_000))?.data;
    if (
      feed?.schema !== "agent.bittrees.task-feed.v1" ||
      feed.source !== "https://agent.bittrees.org" ||
      feed.revision !== a.revision ||
      !Array.isArray(feed.projects) ||
      !Array.isArray(feed.tombstones)
    )
      throw new Held("Source revision changed; review required");
    const found = new Map<string, unknown>();
    for (const group of feed.projects) {
      const m = a.mappings.find((m) => m.sourceProjectId === group.projectId);
      if (!m || m.siteUrl !== group.siteUrl || !Array.isArray(group.tasks))
        throw new Held("Source mapping changed");
      for (const raw of group.tasks) {
        const c = taskContent.parse(raw);
        if (c.projectId !== group.projectId || found.has(c.sourceId))
          throw new Held("Duplicate or mismatched source task");
        const u = new URL(c.sourceUrl);
        if (
          u.origin !== "https://agent.bittrees.org" ||
          u.pathname !== "/readiness" ||
          u.username ||
          u.password
        )
          throw new Held("Unexpected source URL");
        found.set(c.sourceId, c);
      }
    }
    if (found.size !== a.tasks.length)
      throw new Held("Source task set changed");
    for (const t of a.tasks)
      if (digest(found.get(t.content.sourceId)) !== t.fingerprint)
        throw new Held("Source task content changed");
  }
  private async work(a: Approval, signal: AbortSignal) {
    activeLease(a.identity, this.now());
    await this.source(a, signal);
    const receipts = this.get("receipts") || [],
      task = a.tasks[receipts.length];
    if (!task) {
      this.put("enabled", false);
      this.put("progress", { state: "finished" });
      return;
    }
    let pending = this.get("pending") || {
      sourceId: task.content.sourceId,
      attempts: 0,
      import: null,
    };
    if (pending.sourceId !== task.content.sourceId || pending.attempts >= 3)
      throw new Held(
        "Uncertain import retry limit reached; review its source receipt",
      );
    pending.attempts++;
    this.put("pending", pending);
    const challenges: ReturnType<typeof validateChallenge>[] = [];
    const query = new URLSearchParams({
      mode: "selected",
      projects: [
        ...new Set(["crm", ...a.mappings.map((m) => m.sourceProjectId)]),
      ].join(","),
    });
    for (let attempt = 0; attempt < 4; attempt++) {
      activeLease(a.identity, this.now());
      if (signal.aborted || !this.get("enabled")) return;
      const id = randomUUID(),
        headers: Record<string, string> = {
          Authorization: "Bearer " + a.token,
          "Content-Type": "application/json",
          Accept: "application/json",
        };
      if (challenges.length) {
        const bundle = JSON.parse(
          Buffer.from(
            signChallenges(
              challenges,
              this.key().privateKey,
              a.identity,
              this.now(),
            ),
            "base64url",
          ).toString(),
        );
        await Promise.all(
          bundle.proofs.map(async (p: any) => {
            p.attestation = await this.attestProof(
              p.request,
              p.signature,
              signal,
            );
          }),
        );
        activeLease(a.identity, this.now());
        const encoded = Buffer.from(JSON.stringify(bundle)).toString(
          "base64url",
        );
        if (encoded.length > 16384)
          throw new Held("Attested signature bundle exceeds limit");
        headers["x-bittrees-agent-proof"] = encoded;
      }
      const response = await this.request(
        "https://mcp.bittrees.org/mcp?" + query,
        {
          method: "POST",
          redirect: "error",
          signal,
          headers,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: {
              name: "task_sync_execute",
              arguments: {
                sourceId: task.content.sourceId,
                expectedFingerprint: task.fingerprint,
                confirmed: true,
              },
            },
          }),
        },
      );
      const body = await this.read(response, 256000);
      if (body.id !== id) throw new Held("Mismatched gateway response");
      if (response.status === 428) {
        let c;
        try {
          c = validateChallenge(
            body.error?.data,
            a.identity,
            task,
            pending.import,
            this.now(),
          );
        } catch {
          throw new Held(
            "Gateway challenge differs from approved scope or content",
          );
        }
        if (challenges.some((x) => x.parameters.tool === c.parameters.tool))
          throw new Held("Gateway changed or repeated its signature challenge");
        if (c.parameters.tool === "tasks.import_source") {
          pending.import = c.parameters;
          this.put("pending", pending);
        }
        challenges.push(c);
        continue;
      }
      if (!response.ok || body.error || body.result?.isError) {
        if (response.status >= 500) throw Error("Gateway response uncertain");
        throw new Held("Gateway or source denied this import; review required");
      }
      const result = z
        .object({
          state: z.enum(["accepted", "unchanged"]),
          taskId: z.uuid(),
          version: z.int().positive(),
        })
        .passthrough()
        .parse(body.result?.structuredContent);
      const receipt = {
        sourceId: task.content.sourceId,
        fingerprint: task.fingerprint,
        taskId: result.taskId,
        version: result.version,
        state: result.state,
        receivedAt: new Date(this.now()).toISOString(),
      };
      this.db.transaction(() => {
        this.put("receipts", [...receipts, receipt]);
        this.put("pending", null);
        this.put("progress", { ...receipt, state: "import-confirmed" });
      })();
      return;
    }
    throw new Held("Signature continuation limit reached");
  }
  async close() {
    this.controller?.abort();
    await this.running;
    await this.reviewing;
    await this.handoff.close();
    this.db.close();
  }
}
import { createHash } from "node:crypto";
function digestPem(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
