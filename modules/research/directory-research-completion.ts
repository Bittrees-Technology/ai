import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { z } from "zod";
import { digest } from "../task-sync/proof-contract.js";
import { canonical } from "../contracts/canonical-json.js";
import { Vault } from "../storage/vault.js";

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const evidenceSchema = z.strictObject({
  model: z.string().min(1).max(160),
  modelDigest: z.string().min(1).max(160),
  inputHash: hex,
  output: z.string().min(1).max(16000),
});
const bindingSchema = z.strictObject({
  scopeDigest: hex,
  originalValidationRunId: z.uuid(),
  connectionId: z.uuid(),
  workflowId: z.string().min(1).max(128),
  job: z.strictObject({
    id: z.uuid(),
    runId: z.uuid(),
    leaseId: z.uuid(),
    leaseUntil: z.iso.datetime({ offset: true }),
    stepIndex: z.int().min(0).max(29),
    input: z.strictObject({
      title: z.string().max(120),
      instruction: z.string().max(600),
    }),
    inputHash: hex,
  }),
});
const completionSchema = z.strictObject({
  completed: z.literal(true),
  runId: z.uuid(),
  followUpQueued: z.boolean(),
  replayed: z.boolean().optional(),
});
type RecordState = {
  binding: z.infer<typeof bindingSchema>;
  operationId: string;
  result: unknown;
  evidence: z.infer<typeof evidenceSchema>;
  attempts: number;
  completion?: z.infer<typeof completionSchema>;
};

/** Completion uses the existing workflow_complete contract. Full research
 * receipts remain encrypted locally; central evidence carries their digests. */
export class DirectoryResearchCompletion {
  private active = false;
  private db: Database.Database;
  private binding: z.infer<typeof bindingSchema>;
  constructor(
    path: string,
    private vault: Vault,
    rawBinding: unknown,
    private complete: (args: unknown, signal: AbortSignal) => Promise<unknown>,
  ) {
    this.binding = bindingSchema.parse(rawBinding);
    const { job, scopeDigest, originalValidationRunId } = this.binding;
    if (
      digest(job.input) !== job.inputHash ||
      job.input.instruction !==
        canonical({
          kind: "cryptodirectory-research",
          scopeDigest,
          originalValidationRunId,
        })
    )
      throw Error("Central job does not match reviewed directory scope");
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS directory_research_completion (scope TEXT PRIMARY KEY, record BLOB NOT NULL)",
    );
  }
  close() {
    this.db.close();
  }
  private read() {
    const row = this.db
      .prepare("SELECT record FROM directory_research_completion WHERE scope=?")
      .get(this.binding.scopeDigest) as { record: Buffer } | undefined;
    return row
      ? this.vault.open<RecordState>(
          row.record,
          "directory-completion:" + this.binding.scopeDigest,
        )
      : undefined;
  }
  private save(state: RecordState) {
    this.db
      .prepare(
        "INSERT INTO directory_research_completion VALUES (?,?) ON CONFLICT(scope) DO UPDATE SET record=excluded.record",
      )
      .run(
        this.binding.scopeDigest,
        this.vault.seal(
          state,
          "directory-completion:" + this.binding.scopeDigest,
        ),
      );
  }
  pending() {
    return this.read() !== undefined;
  }
  async run(result: unknown | undefined, signal: AbortSignal) {
    if (this.active) throw Error("Central research completion is active");
    this.active = true;
    try {
      return await this.dispatch(result, signal);
    } finally {
      this.active = false;
    }
  }
  private async dispatch(result: unknown | undefined, signal: AbortSignal) {
    signal.throwIfAborted();
    let state = this.read();
    if (!state) {
      const batch = z
        .object({
          scopeDigest: hex,
          receipts: z
            .array(
              z.object({
                originalReceiptId: z.uuid(),
                lastRecordedRetryReceiptId: z.uuid(),
                sourceHash: hex,
                model: z.string(),
                modelDigest: z.string(),
                answer: z.unknown(),
              }),
            )
            .length(9),
        })
        .parse(result);
      if (batch.scopeDigest !== this.binding.scopeDigest)
        throw Error("Research receipt scope mismatch");
      const first = batch.receipts[0]!;
      if (
        batch.receipts.some(
          (r) => r.model !== first.model || r.modelDigest !== first.modelDigest,
        )
      )
        throw Error("Research model evidence changed within batch");
      const evidence = evidenceSchema.parse({
        model: first.model,
        modelDigest: first.modelDigest,
        inputHash: this.binding.job.inputHash,
        output: canonical({
          kind: "cryptodirectory-research-receipts",
          scopeDigest: batch.scopeDigest,
          originalValidationRunId: this.binding.originalValidationRunId,
          receipts: batch.receipts.map((r) => ({
            originalReceiptId: r.originalReceiptId,
            lastRecordedRetryReceiptId: r.lastRecordedRetryReceiptId,
            sourceHash: r.sourceHash,
            answerDigest: digest(r.answer),
          })),
          receiptDigest: digest(result),
        }),
      });
      state = {
        binding: this.binding,
        operationId: randomUUID(),
        result,
        evidence,
        attempts: 0,
      };
      this.save(state);
    }
    if (canonical(state.binding) !== canonical(this.binding))
      throw Error("Central research binding changed");
    if (!state.completion) {
      if (state.attempts >= 2)
        throw Error("Central research completion budget exhausted");
      state.attempts++;
      this.save(state);
      const completion = completionSchema.parse(
        await this.complete(
          {
            connectionId: this.binding.connectionId,
            workflowId: this.binding.workflowId,
            jobId: this.binding.job.id,
            leaseId: this.binding.job.leaseId,
            operationId: state.operationId,
            evidence: state.evidence,
          },
          signal,
        ),
      );
      signal.throwIfAborted();
      if (completion.runId !== this.binding.job.runId)
        throw Error("Central research completion run mismatch");
      state.completion = completion;
      this.save(state);
    }
    return { research: state.result, completion: state.completion };
  }
}
