import { immediateTask, type TaskTurn } from "../agents/queue.js";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Vault } from "../storage/vault.js";
import { canonical } from "../contracts/canonical-json.js";
import { parseRecurringSchedule, recurringSlot } from "./recurring-schedule.js";

const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const operation = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9:._-]{0,127}$/),
  capability: z.string().min(1).max(160),
  arguments: z.record(z.string(), z.unknown()),
});
export const recurringDefinitionSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/),
  name: z.string().min(1).max(160),
  instructions: z.string().min(1).max(48000),
  executionBrief: z.string().min(1).max(4000),
  rrule: z.string().max(200),
  timezone: z.string().max(100),
  anchor: z.number().int().safe().positive(),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  originalState: z.enum(["active", "paused"]),
  modelProfileId: z.uuid(),
  collect: operation,
  actions: z.array(operation).max(10),
  mode: z.enum(["monitor", "finite"]),
  additionalSpendingUSD: z.literal(0),
});
export type RecurringDefinition = z.infer<typeof recurringDefinitionSchema>;
export type RecurringOperation = z.infer<typeof operation>;
export type RecurringReceipt = {
  state: "confirmed" | "held";
  evidence: unknown;
  fingerprint: string;
  observedAt: number;
  objectiveComplete?: boolean;
};
export type RecurringHost = {
  /** Recheck user approval, current source authorization AND zero additional cost. */
  authorize: (
    definition: RecurringDefinition,
    operation: RecurringOperation,
    signal: AbortSignal,
  ) => Promise<void>;
  execute: (
    definition: RecurringDefinition,
    operation: RecurringOperation,
    operationId: string,
    signal: AbortSignal,
  ) => Promise<RecurringReceipt>;
  decide: (
    definition: RecurringDefinition,
    receipt: RecurringReceipt,
    signal: AbortSignal,
  ) => Promise<unknown>;
  /** Must verify current PAUSED source and unchanged fingerprint excluding status. */
  sourcePaused: (definition: RecurringDefinition) => Promise<boolean>;
  admission: () => boolean;
};
const decisionSchema = z.strictObject({
  decision: z.enum(["wait", "act", "escalate"]),
  actionId: z.string().max(128).optional(),
  summary: z.string().min(1).max(1500),
});
type State = {
  definition: RecurringDefinition;
  revision: string;
  epoch: string;
  approved: boolean;
  enabled: boolean;
  verified: boolean;
  lastSlot?: string;
  pending?: { operationId: string; actionId: string };
  status?: string;
  lastReceipt?: RecurringReceipt;
  lastSummary?: string;
  modelEvidence?: unknown;
  exception?: {
    id: string;
    fingerprint: string;
    reason: string;
    createdAt: number;
  };
};

/** Single owner, encrypted local state. Model output can select only reviewed operations. */
export class RecurringWorkflows {
  taskTurn: TaskTurn = immediateTask;
  private db: Database.Database;
  private running: Promise<void> | null = null;
  private controller: AbortController | null = null;
  constructor(
    path: string,
    private vault: Vault,
    private host: RecurringHost,
    private now = Date.now,
  ) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS recurring(id TEXT PRIMARY KEY, value BLOB NOT NULL)",
    );
  }
  private rows(): State[] {
    return (
      this.db.prepare("SELECT id,value FROM recurring ORDER BY id").all() as {
        id: string;
        value: Buffer;
      }[]
    ).map((row) => this.vault.open<State>(row.value, "recurring:" + row.id));
  }
  private get(id: string) {
    const state = this.rows().find((row) => row.definition.id === id);
    if (!state) throw Error("Workflow unavailable");
    return state;
  }
  private put(state: State) {
    this.db
      .prepare("INSERT OR REPLACE INTO recurring(id,value) VALUES(?,?)")
      .run(
        state.definition.id,
        this.vault.seal(state, "recurring:" + state.definition.id),
      );
  }
  private fence(state: State) {
    const current = this.get(state.definition.id);
    if (
      !current.approved ||
      current.revision !== state.revision ||
      current.epoch !== state.epoch ||
      !current.enabled
    )
      throw Error("Workflow approval changed");
  }
  review(raw: unknown) {
    const input = z.array(recurringDefinitionSchema).min(1).max(50).parse(raw);
    if (new Set(input.map((d) => d.id)).size !== input.length)
      throw Error("Duplicate workflow");
    for (const definition of input) {
      parseRecurringSchedule(definition.rrule);
      new Intl.DateTimeFormat("en-GB", { timeZone: definition.timezone });
      const ids = [
        definition.collect.id,
        ...definition.actions.map((a) => a.id),
      ];
      if (new Set(ids).size !== ids.length) throw Error("Duplicate operation");
      if (
        this.rows().find((row) => row.definition.id === definition.id)?.enabled
      )
        throw Error("Pause before changing a workflow");
    }
    this.db.transaction(() => {
      for (const definition of input) {
        const revision = digest(definition),
          prior = this.rows().find(
            (row) => row.definition.id === definition.id,
          );
        if (prior?.revision === revision) continue;
        this.put({
          definition,
          revision,
          epoch: randomUUID(),
          approved: false,
          enabled: false,
          verified: false,
          status: "pending-review",
        });
      }
    })();
    return this.status();
  }
  approve(id: string, revision: string, confirmed: true) {
    const state = this.get(id);
    if (confirmed !== true || state.revision !== revision)
      throw Error("Review changed");
    state.approved = true;
    state.epoch = randomUUID();
    state.status = "approved-not-running";
    this.put(state);
    return this.status();
  }
  async verify(id: string) {
    return this.taskTurn(
      "Verify recurring source",
      new AbortController().signal,
      (signal) => this.verifyExclusive(id, signal),
    );
  }
  private async verifyExclusive(id: string, parent: AbortSignal) {
    if (this.running) throw Error("Wait for current work");
    const state = this.get(id);
    if (!state.approved) throw Error("Approval required");
    const signal = AbortSignal.any([parent, AbortSignal.timeout(30000)]);
    await this.host.authorize(
      state.definition,
      state.definition.collect,
      signal,
    );
    const receipt = await this.host.execute(
      state.definition,
      state.definition.collect,
      "verify:" + randomUUID(),
      signal,
    );
    this.receipt(receipt);
    const current = this.get(id);
    if (
      current.revision !== state.revision ||
      current.epoch !== state.epoch ||
      !current.approved
    )
      throw Error("Review changed");
    current.verified = receipt.state === "confirmed";
    current.lastReceipt = receipt;
    current.status = current.verified
      ? "verified-awaiting-cutover"
      : "needs-attention";
    this.put(current);
    return this.status();
  }
  async enable(id: string, revision: string) {
    const state = this.get(id);
    if (
      !state.approved ||
      !state.verified ||
      state.revision !== revision ||
      state.definition.originalState !== "active"
    )
      throw Error("Reviewed and verified active workflow required");
    if (!(await this.host.sourcePaused(state.definition)))
      throw Error("Original recurring task must be verifiably paused first");
    const current = this.get(id);
    if (
      current.revision !== revision ||
      current.epoch !== state.epoch ||
      !current.approved
    )
      throw Error("Review changed");
    current.enabled = true;
    current.lastSlot =
      recurringSlot(
        current.definition.rrule,
        current.definition.timezone,
        current.definition.anchor,
        this.now(),
      ) ?? undefined;
    current.status = "ready";
    this.put(current);
    return this.status();
  }
  pause(id: string) {
    const state = this.get(id);
    state.enabled = false;
    state.epoch = randomUUID();
    state.status = "paused";
    this.put(state);
    this.controller?.abort();
    return this.status();
  }
  revoke(id: string) {
    const state = this.get(id);
    state.enabled = false;
    state.epoch = randomUUID();
    state.approved = false;
    state.verified = false;
    state.status = "revoked";
    this.put(state);
    this.controller?.abort();
    return this.status();
  }
  recordDecision(id: string, evidence: any) {
    const state = this.get(id);
    if (
      !state.approved ||
      state.revision !== evidence.definitionHash ||
      JSON.stringify(evidence).length > 16000
    )
      return;
    state.modelEvidence = evidence;
    this.put(state);
  }
  detail(id: string) {
    const state = this.get(id);
    return { definition: state.definition, revision: state.revision };
  }
  status() {
    return this.rows().map(
      ({
        definition,
        revision,
        approved,
        enabled,
        verified,
        status,
        lastSummary,
        exception,
        lastReceipt,
        pending,
      }) => ({
        id: definition.id,
        name: definition.name,
        rrule: definition.rrule,
        timezone: definition.timezone,
        originalState: definition.originalState,
        revision,
        approved,
        enabled,
        verified,
        status,
        lastSummary,
        exception,
        lastReceipt,
        uncertainAction: !!pending,
        capabilities: [
          definition.collect.capability,
          ...definition.actions.map((a) => a.capability),
        ],
      }),
    );
  }
  private receipt(receipt: RecurringReceipt) {
    if (
      !receipt ||
      !["confirmed", "held"].includes(receipt.state) ||
      !/^[a-f0-9]{64}$/.test(receipt.fingerprint) ||
      !Number.isSafeInteger(receipt.observedAt) ||
      receipt.observedAt > this.now() + 1000 ||
      this.now() - receipt.observedAt > 60000 ||
      JSON.stringify(receipt).length > 32000
    )
      throw Error("Fresh bounded source evidence required");
  }
  private hold(
    state: State,
    reason: string,
    evidence: unknown,
    category = reason,
  ) {
    const current = this.get(state.definition.id);
    if (
      !current.enabled ||
      current.revision !== state.revision ||
      current.epoch !== state.epoch ||
      !current.approved
    )
      return;
    const fingerprint = digest({
      revision: state.revision,
      category,
      evidence,
    });
    if (current.exception?.fingerprint !== fingerprint)
      current.exception = {
        id: randomUUID(),
        fingerprint,
        reason,
        createdAt: this.now(),
      };
    current.status = "needs-attention";
    this.put(current);
  }
  tick() {
    if (this.running || !this.host.admission())
      return this.running ?? Promise.resolve();
    const state = this.rows().find((row) => {
      const slot = recurringSlot(
        row.definition.rrule,
        row.definition.timezone,
        row.definition.anchor,
        this.now(),
      );
      return (
        row.enabled && row.approved && slot !== null && slot !== row.lastSlot
      );
    });
    if (!state) return Promise.resolve();
    const slot = recurringSlot(
      state.definition.rrule,
      state.definition.timezone,
      state.definition.anchor,
      this.now(),
    );
    if (!slot) return Promise.resolve();
    state.lastSlot = slot;
    this.put(state);
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.running = this.run(state, slot, signal)
      .catch(() => {
        this.hold(
          state,
          "Local execution or source verification failed. Saved evidence is retained.",
          { pending: !!this.get(state.definition.id).pending },
        );
      })
      .finally(() => {
        this.running = null;
        this.controller = null;
      });
    return this.running;
  }
  private async run(state: State, slot: string, signal: AbortSignal) {
    return this.taskTurn("Recurring workflow", signal, (queuedSignal) =>
      this.runExclusive(
        state,
        slot,
        AbortSignal.any([queuedSignal, AbortSignal.timeout(120000)]),
      ),
    );
  }
  private async runExclusive(state: State, slot: string, signal: AbortSignal) {
    if (state.pending) {
      this.hold(
        state,
        "Previous action outcome needs reconciliation; it will not be replayed.",
        state.pending,
      );
      return;
    }
    this.fence(state);
    if (!(await this.host.sourcePaused(state.definition)))
      throw Error("Original schedule state changed");
    await this.host.authorize(
      state.definition,
      state.definition.collect,
      signal,
    );
    this.fence(state);
    signal.throwIfAborted();
    const receipt = await this.host.execute(
      state.definition,
      state.definition.collect,
      digest({
        id: state.definition.id,
        revision: state.revision,
        slot,
        collect: true,
      }),
      signal,
    );
    this.receipt(receipt);
    this.fence(state);
    signal.throwIfAborted();
    state.lastReceipt = receipt;
    this.put(state);
    if (receipt.state !== "confirmed") {
      this.hold(state, "Source evidence requires review", receipt.fingerprint);
      return;
    }
    if (receipt.objectiveComplete && state.definition.mode === "finite") {
      state.enabled = false;
      state.status = "completed";
      state.exception = undefined;
      this.put(state);
      return;
    }
    const decision = decisionSchema.parse(
      await this.host.decide(state.definition, receipt, signal),
    );
    this.fence(state);
    signal.throwIfAborted();
    state.lastSummary = decision.summary;
    if (decision.decision === "escalate") {
      this.hold(
        state,
        decision.summary,
        receipt.fingerprint,
        "model-needs-help",
      );
      return;
    }
    if (decision.decision === "act") {
      const action = state.definition.actions.find(
        (a) => a.id === decision.actionId,
      );
      if (!action) throw Error("Unreviewed action denied");
      await this.host.authorize(state.definition, action, signal);
      this.fence(state);
      signal.throwIfAborted();
      if (!(await this.host.sourcePaused(state.definition)))
        throw Error("Original schedule state changed");
      this.fence(state);
      signal.throwIfAborted();
      state.pending = {
        operationId: digest({
          id: state.definition.id,
          revision: state.revision,
          slot,
          action,
        }),
        actionId: action.id,
      };
      this.put(state);
      const result = await this.host.execute(
        state.definition,
        action,
        state.pending.operationId,
        signal,
      );
      this.receipt(result);
      this.fence(state);
      signal.throwIfAborted();
      if (result.state !== "confirmed") {
        this.hold(
          state,
          "Action outcome is not confirmed; reconcile source before retrying",
          state.pending,
        );
        return;
      }
      state.lastReceipt = result;
      state.pending = undefined;
      if (result.objectiveComplete && state.definition.mode === "finite")
        state.enabled = false;
    }
    state.exception = undefined;
    state.status = state.enabled ? "waiting" : "completed";
    this.put(state);
  }
  async close() {
    this.controller?.abort();
    await this.running;
    this.db.close();
  }
}
