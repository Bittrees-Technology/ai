import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { z } from "zod";
import { Vault } from "../storage/vault.js";
import { immediateTurn, type ModelTurn } from "../models/local-turns.js";
import { ModelError } from "../models/ollama.js";
import { digest } from "./proof-contract.js";
import {
  assignmentSchema,
  assignmentClaimSchema as claimSchema,
  assignmentResultSchema as resultSchema,
  assignmentValidationInput,
  assignmentValidationReceipt,
  assignmentValidatorSchema,
  checkAssignmentValidation,
} from "./assignment-contract.js";
export { assignmentSchema } from "./assignment-contract.js";

export type TaskAssignment = z.infer<typeof assignmentSchema>;
const receiptSchema = z.strictObject({
  operationId: z.uuid(),
  resultDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
type RecordState = {
  assignment: TaskAssignment;
  claimId: string;
  claimAttempts?: number;
  writeId: string;
  completeId: string;
  claim?: z.infer<typeof claimSchema>;
  inferenceStarted?: true;
  result?: z.infer<typeof resultSchema>;
  validation?: z.infer<typeof assignmentValidationReceipt>;
  writeStarted?: true;
  written?: true;
  completeStarted?: true;
  completeAttempts?: number;
  centralCompleted?: true;
  completeTask?: boolean;
  finalizeStarted?: true;
  finalizeAttempts?: number;
  finalized?: true;
  completed?: true;
  block?: {
    action: Action;
    reason:
      | "authority-unavailable"
      | "assignment-changed"
      | "model-capacity"
      | "invalid-model-result"
      | "validation-rejected";
  };
};
type Action =
  | "claim"
  | "read"
  | "infer"
  | "validate"
  | "write"
  | "read-receipt"
  | "complete"
  | "read-completion"
  | "finalize"
  | "read-finalization";
export type AssignmentBinding = {
  assignment: TaskAssignment;
  claim?: RecordState["claim"];
  action: Action;
  request?: {
    url: string;
    method: string;
    bodyDigest: string;
    operationId: string | null;
  };
  inputDigest?: string;
};

/** Inactive REST integration candidate. Only an owner-provided protected
 * transport may send requests, and authorization is required on every action.
 * Proposed paths are tested against fixtures before any server rollout. */
export class AssignmentRunner {
  private db: Database.Database;
  private active = false;
  constructor(
    path: string,
    private vault: Vault,
    private host: {
      authorize(binding: AssignmentBinding, signal: AbortSignal): Promise<void>;
      request(
        url: string,
        init: RequestInit,
        context: AssignmentBinding & {
          crmOperationId: string;
          resultDigest?: string;
        },
      ): Promise<Response>;
      completeTask?: () => boolean;
      modelTurn?: ModelTurn;
      validator?: () => z.infer<typeof assignmentValidatorSchema> | null;
      validate?: (
        input: z.infer<typeof assignmentValidationInput>,
        signal: AbortSignal,
      ) => Promise<unknown>;
      generate(
        input: { instruction: string },
        signal: AbortSignal,
      ): Promise<unknown>;
    },
    private now = Date.now,
  ) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS assignments (id TEXT PRIMARY KEY, record BLOB NOT NULL)",
    );
  }
  close() {
    if (this.active) throw Error("Assignment run is active");
    this.db.close();
  }
  status(raw: unknown) {
    const id = z.uuid().parse(raw);
    const row = this.db
      .prepare("SELECT record FROM assignments WHERE id=?")
      .get(id) as { record: Buffer } | undefined;
    if (!row) return null;
    const state = this.vault.open<RecordState>(
      row.record,
      "task-assignment:" + id,
    );
    let phase = "awaiting-claim";
    if (state.completed)
      phase = state.validation ? "completed" : "completed-unvalidated";
    else if (state.centralCompleted)
      phase =
        (state.finalizeAttempts ?? 0) >= 2
          ? "source-finalization-unconfirmed"
          : state.finalizeStarted
            ? "source-finalization-reconciliation"
            : "central-completed";
    else if (state.completeStarted)
      phase =
        (state.completeAttempts ?? 1) >= 2
          ? "completion-unconfirmed"
          : "completion-reconciliation";
    else if (state.claim && state.claim.expiresAt <= this.now())
      phase = "lease-expired";
    else if (state.written) phase = "crm-result-confirmed";
    else if (state.writeStarted) phase = "crm-result-reconciliation";
    else if (state.block?.action === "validate" && state.result)
      phase = "validation-held";
    else if (state.result) phase = "result-ready";
    else if (state.inferenceStarted) phase = "inference-unconfirmed";
    else if (state.claim) phase = "claimed";
    else if ((state.claimAttempts ?? 0) >= 2) phase = "claim-unconfirmed";
    return {
      assignmentId: id,
      taskId: state.assignment.taskId,
      taskRevision: state.assignment.taskRevision,
      workflowId: state.assignment.workflowId,
      workflowRevision: state.assignment.workflowRevision,
      runId: state.claim?.runId ?? null,
      centralCompleted: state.centralCompleted === true,
      sourceFinalizationRequired: state.completeTask === true,
      sourceFinalized: state.finalized === true,
      completionAttempts:
        state.completeAttempts ?? (state.completeStarted ? 1 : 0),
      finalizationAttempts: state.finalizeAttempts ?? 0,
      lastReceiptId:
        state.centralCompleted || state.completed
          ? state.completeId
          : state.written
            ? state.writeId
            : null,
      phase,
      validation: state.validation
        ? {
            validatorId: state.validation.validatorId,
            revision: state.validation.validatorRevision,
            checkedAt: state.validation.checkedAt,
            crmOperationId: state.validation.crmOperationId,
            resultDigest: state.validation.resultDigest,
            evidenceDigest: digest(state.validation),
          }
        : null,
      block: state.block ?? null,
    };
  }
  async run(raw: unknown, parent: AbortSignal) {
    if (this.active) throw Error("Assignment runner is busy");
    const assignment = assignmentSchema.parse(raw);
    const id = assignment.assignmentId;
    const aad = "task-assignment:" + id;
    let previous: Buffer;
    const save = (state: RecordState) => {
      const next = this.vault.seal(state, aad);
      const updated = this.db
        .prepare("UPDATE assignments SET record=? WHERE id=? AND record=?")
        .run(next, id, previous);
      if (updated.changes !== 1)
        throw Error("Assignment advanced in another runner");
      previous = next;
    };
    const state = this.db
      .transaction(() => {
        const row = this.db
          .prepare("SELECT record FROM assignments WHERE id=?")
          .get(id) as { record: Buffer } | undefined;
        if (row) {
          previous = row.record;
          return this.vault.open<RecordState>(row.record, aad);
        }
        const record: RecordState = {
          assignment,
          claimId: randomUUID(),
          writeId: randomUUID(),
          completeId: randomUUID(),
          completeTask: this.host.completeTask?.() === true,
        };
        previous = this.vault.seal(record, aad);
        this.db
          .prepare("INSERT INTO assignments(id,record) VALUES(?,?)")
          .run(id, previous);
        return record;
      })
      .immediate();
    if (digest(state.assignment) !== digest(assignment))
      throw Error("Assignment identity or revision changed");
    if (state.completed) {
      if (!state.validation)
        return {
          state: "held",
          reason: "legacy-completion-unvalidated",
        } as const;
      return { state: "completed", runId: state.claim!.runId } as const;
    }
    const pin = assignmentValidatorSchema
      .nullable()
      .parse(this.host.validator?.() ?? null);
    if (!pin || !this.host.validate)
      return { state: "held", reason: "validation-required" } as const;

    if (state.completeTask === true && this.host.completeTask?.() !== true)
      return {
        state: "held",
        reason: "source-finalization-approval-unavailable",
      } as const;
    const signal = AbortSignal.any([parent, AbortSignal.timeout(120_000)]);
    const authority = async (
      action: Action,
      detail: Pick<AssignmentBinding, "request" | "inputDigest"> = {},
    ) => {
      const reconciliation =
        (action === "read-completion" && state.completeStarted === true) ||
        (["finalize", "read-finalization"].includes(action) &&
          state.centralCompleted === true);
      const actionSignal =
        state.claim && !reconciliation
          ? AbortSignal.any([
              signal,
              AbortSignal.timeout(
                Math.max(1, state.claim.expiresAt - this.now()),
              ),
            ])
          : signal;
      const current = () => {
        actionSignal.throwIfAborted();
        if (
          (action === "write" || action === "complete") &&
          (!state.validation ||
            state.validation.expiresAt <= this.now() ||
            state.validation.validatorId !== pin.id ||
            state.validation.validatorRevision !== pin.revision)
        )
          throw Error("Current independent assignment validation required");
        if (
          !reconciliation &&
          state.claim &&
          state.claim.expiresAt <= this.now()
        )
          throw Error("Assignment lease expired");
      };
      current();
      try {
        await this.host.authorize(
          structuredClone({
            assignment,
            claim: state.claim,
            action,
            ...detail,
          }),
          actionSignal,
        );
      } catch (error) {
        state.block = { action, reason: "authority-unavailable" };
        save(state);
        throw error;
      }
      current();
      return actionSignal;
    };
    const rest = async (
      action: Action,
      url: string,
      method: "GET" | "POST" | "PUT",
      payload?: unknown,
      operationId?: string,
      beforeDispatch?: () => void,
    ) => {
      const actionSignal = await authority(action, {
        request: {
          url,
          method,
          bodyDigest: digest(payload ?? null),
          operationId: operationId ?? null,
        },
      });
      beforeDispatch?.();
      const response = await this.host.request(
        url,
        {
          method,
          signal: actionSignal,
          redirect: "error",
          headers: {
            Accept: "application/json",
            ...(payload ? { "Content-Type": "application/json" } : {}),
            ...(operationId ? { "Idempotency-Key": operationId } : {}),
          },
          ...(payload ? { body: JSON.stringify(payload) } : {}),
        },
        {
          assignment,
          claim: state.claim,
          action,
          crmOperationId: state.writeId,
          resultDigest: state.result ? digest(state.result) : undefined,
        },
      );
      actionSignal.throwIfAborted();
      if (!response.ok) {
        await response.body?.cancel();
        throw Error(
          "Assignment REST " + action + " failed (" + response.status + ")",
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw Error("Missing assignment response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > 32_000) throw Error("Assignment response exceeds limit");
          chunks.push(next.value);
        }
        actionSignal.throwIfAborted();
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        );
      } finally {
        await reader.cancel();
      }
    };
    const completionUrl = () =>
      "https://workflow.bittrees.org/api/task-runs/" +
      state.claim!.runId +
      "/completions/" +
      state.completeId;
    const confirm = (rawReceipt: unknown, operationId: string) => {
      const receipt = receiptSchema.parse(rawReceipt);
      if (
        receipt.operationId !== operationId ||
        receipt.resultDigest !== digest(state.result)
      )
        throw Error("Assignment receipt mismatch");
    };
    const completionAttempt = () => {
      state.completeAttempts =
        (state.completeAttempts ?? (state.completeStarted ? 1 : 0)) + 1;
      state.completeStarted = true;
      save(state);
    };
    const finish = async () => {
      if (!state.centralCompleted)
        throw Error("Confirmed central completion required");
      if (state.completeTask && !state.finalized) {
        if ((state.finalizeAttempts ?? 0) >= 2)
          return {
            state: "held",
            reason: "source-finalization-unconfirmed",
          } as const;
        const verify = (raw: unknown) => {
          const receipt = z
            .strictObject({
              taskId: z.uuid(),
              taskVersion: z.int().positive(),
              status: z.literal("Done"),
              operationId: z.uuid(),
              replayed: z.boolean(),
            })
            .parse(raw);
          if (
            receipt.operationId !== state.completeId ||
            receipt.taskId !== assignment.taskId ||
            receipt.taskVersion !== assignment.taskRevision + 1
          )
            throw Error("CRM source finalization receipt mismatch");
        };
        const finalUrl =
          "https://crm.bittrees.org/api/automation/tasks/" +
          assignment.taskId +
          "/finalizations/" +
          state.completeId;
        const attempt = () => {
          state.finalizeAttempts = (state.finalizeAttempts ?? 0) + 1;
          state.finalizeStarted = true;
          save(state);
        };
        if (!state.finalizeStarted)
          verify(
            await rest(
              "finalize",
              finalUrl,
              "PUT",
              {
                assignment,
                crmOperationId: state.writeId,
                resultDigest: digest(state.result),
              },
              state.completeId,
              attempt,
            ),
          );
        // A successful write is also confirmed through the separately authorized
        // original-operation read route, within the same two-request budget.
        verify(
          await rest(
            "read-finalization",
            finalUrl,
            "GET",
            undefined,
            undefined,
            attempt,
          ),
        );
        state.finalized = true;
      }
      state.completed = true;
      delete state.block;
      save(state);
      return { state: "completed", runId: state.claim!.runId } as const;
    };
    this.active = true;
    try {
      // Recovery never reads changed task inputs, invokes a validator/model again,
      // or repeats a mutation. The current source/central services verify receipts.
      if (state.completeStarted || state.centralCompleted) {
        const v = assignmentValidationReceipt.parse(state.validation);
        if (
          !state.written ||
          !state.claim ||
          !state.result ||
          v.validatorId !== pin.id ||
          v.validatorRevision !== pin.revision ||
          v.assignmentDigest !== digest(assignment) ||
          v.crmOperationId !== state.writeId ||
          v.resultDigest !== digest(state.result)
        )
          throw Error("Original validated completion evidence required");
        if (!state.centralCompleted) {
          if ((state.completeAttempts ?? 1) >= 2)
            return { state: "held", reason: "completion-unconfirmed" } as const;
          confirm(
            await rest(
              "read-completion",
              completionUrl(),
              "GET",
              undefined,
              undefined,
              completionAttempt,
            ),
            state.completeId,
          );
          state.centralCompleted = true;
          save(state);
        }
        return await finish();
      }
      if (!state.claim) {
        if ((state.claimAttempts ?? 0) >= 2)
          return { state: "held", reason: "claim-unconfirmed" } as const;
        const claim = claimSchema.parse(
          await rest(
            "claim",
            "https://workflow.bittrees.org/api/task-assignments/" +
              id +
              "/claim",
            "POST",
            { assignment },
            state.claimId,
            () => {
              state.claimAttempts = (state.claimAttempts ?? 0) + 1;
              save(state);
            },
          ),
        );
        if (
          claim.assignmentDigest !== digest(assignment) ||
          claim.expiresAt <= this.now() ||
          claim.expiresAt > this.now() + 900_000
        )
          throw Error("Assignment claim differs from approved scope");
        state.claim = claim;
        save(state);
      }
      const task =
        "https://crm.bittrees.org/api/automation/tasks/" + assignment.taskId;
      const readTask = async () => {
        const snapshot = z
          .strictObject({
            assignment: assignmentSchema,
            instruction: z.string().min(1).max(8000),
          })
          .parse(await rest("read", task, "GET"));
        if (digest(snapshot.assignment) !== digest(assignment)) {
          state.block = { action: "read", reason: "assignment-changed" };
          save(state);
          throw Error("CRM task assignment changed");
        }
        return snapshot;
      };
      if (!state.result) {
        if (state.inferenceStarted)
          return { state: "held", reason: "inference-uncertain" } as const;
        await (this.host.modelTurn ?? immediateTurn)(signal, async () => {
          const { instruction } = await readTask();
          const inferenceSignal = await authority("infer", {
            inputDigest: digest(instruction),
          });
          state.inferenceStarted = true;
          save(state);
          try {
            state.result = resultSchema.parse(
              await this.host.generate({ instruction }, inferenceSignal),
            );
          } catch (error) {
            if (error instanceof ModelError && error.code === "CAPACITY") {
              state.block = { action: "infer", reason: "model-capacity" };
              save(state);
            } else if (
              error instanceof z.ZodError ||
              (error instanceof ModelError && error.code === "INVALID_OUTPUT")
            ) {
              state.block = { action: "infer", reason: "invalid-model-result" };
              save(state);
            }
            throw error;
          }
          inferenceSignal.throwIfAborted();
          save(state);
        });
      }
      if (!state.result) throw Error("Missing assignment model result");
      const resultDigest = digest(state.result);
      const snapshot = await readTask();
      const validationInput = assignmentValidationInput.parse({
        assignment,
        claim: state.claim,
        crmOperationId: state.writeId,
        inputDigest: digest(snapshot.instruction),
        resultDigest,
        result: state.result,
      });
      const validationSignal = await authority("validate", {
        inputDigest: validationInput.inputDigest,
      });
      if (digest(this.host.validator?.()) !== digest(pin))
        throw Error("Assignment validator changed");
      let validation: z.infer<typeof assignmentValidationReceipt>;
      try {
        validation = checkAssignmentValidation(
          await this.host.validate(
            structuredClone(validationInput),
            validationSignal,
          ),
          validationInput,
          pin,
          this.now(),
        );
      } catch (error) {
        state.block = { action: "validate", reason: "validation-rejected" };
        save(state);
        throw error;
      }
      validationSignal.throwIfAborted();
      if (digest(this.host.validator?.()) !== digest(pin))
        throw Error("Assignment validator changed");
      state.validation = validation;
      delete state.block;
      save(state);
      if (!state.written) {
        const url = task + "/results/" + state.writeId;
        if (!state.writeStarted) {
          await readTask();
          confirm(
            await rest(
              "write",
              url,
              "PUT",
              {
                assignment,
                claim: state.claim,
                result: state.result,
                resultDigest,
              },
              state.writeId,
              () => {
                state.writeStarted = true;
                save(state);
              },
            ),
            state.writeId,
          );
        }
        confirm(await rest("read-receipt", url, "GET"), state.writeId);
        state.written = true;
        save(state);
      }
      if ((state.completeAttempts ?? 0) >= 2)
        return { state: "held", reason: "completion-unconfirmed" } as const;
      confirm(
        await rest(
          "complete",
          completionUrl(),
          "PUT",
          {
            assignment,
            claim: state.claim,
            crmOperationId: state.writeId,
            resultDigest,
          },
          state.completeId,
          completionAttempt,
        ),
        state.completeId,
      );
      state.centralCompleted = true;
      save(state);
      return await finish();
    } finally {
      this.active = false;
    }
  }
}
