import Database from "better-sqlite3";
import { z } from "zod";
import type { Vault } from "../storage/vault.js";
import { Ollama, ModelError, type PinnedModel } from "../models/ollama.js";
import type { ModelTurn } from "../models/local-turns.js";
import { AssignmentRunner } from "./assignment-runner.js";
import { nativeAssignmentRequest } from "./assignment-native.js";
import { assignmentModel } from "./assignment-model.js";
import { assignmentValidationReceipt } from "./assignment-contract.js";
import {
  assignmentServiceReview,
  type AssignmentServiceClient,
} from "./assignment-service-native.js";

type Phase = "disabled" | "idle" | "running" | "paused" | "held";
type Hold =
  | "native-unavailable"
  | "model-changed"
  | "source-or-authority"
  | "attempt-budget"
  | "inference-unconfirmed"
  | "invalid-model-result"
  | "validation-required"
  | "validation-rejected"
  | "completion-unconfirmed"
  | "source-finalization-unconfirmed"
  | "source-finalization-approval-unavailable";
export class AssignmentService {
  private db?: Database.Database;
  private runner?: AssignmentRunner;
  private work?: Promise<void>;
  private abort?: AbortController;
  private stopping = false;
  private currentAssignment?: string;
  private phase: Phase = "disabled";
  private hold: Hold | null = null;
  private failure: string | null = null;
  private review?: z.infer<typeof assignmentServiceReview>;
  constructor(
    private options: {
      path: string;
      runnerPath: string;
      vault: Vault;
      client?: AssignmentServiceClient;
      runtime: Ollama;
      profile: (id: string) => unknown;
      turn: ModelTurn;
      admission: () => boolean;
      now?: () => number;
    },
  ) {
    if (!options.client) return;
    this.db = new Database(options.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS assignment_service(id TEXT PRIMARY KEY,attempts INTEGER NOT NULL,terminal INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS assignment_service_settings(id INTEGER PRIMARY KEY,paused INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS assignment_model_calls(id TEXT PRIMARY KEY)",
    );
    const client = options.client;
    this.runner = new AssignmentRunner(
      options.runnerPath,
      options.vault,
      {
        authorize: async (binding, signal) => {
          const review = this.review;
          if (!review) throw Error("Current native assignment review required");
          const response = await client.execute(
            { kind: "authorize", epoch: review.epoch, binding },
            signal,
          );
          if (!response.ok || (await response.json()).authorized !== true)
            throw Error("Assignment authority unavailable");
        },
        request: async (url, init, binding) => {
          const review = this.review;
          if (!review) throw Error("Current native assignment review required");
          return nativeAssignmentRequest({
            execute: (raw, signal) =>
              client.execute(
                { ...(raw as object), epoch: review.epoch },
                signal ?? new AbortController().signal,
              ),
          })(url, init, binding);
        },
        completeTask: () => this.review?.completeTask === true,
        modelTurn: options.turn,
        validator: () => this.review?.validator ?? null,
        validate: async (input, signal) => {
          const review = this.review;
          if (!review?.validator)
            throw Error("Independent assignment validator required");
          const response = await client.execute(
            { kind: "validate", epoch: review.epoch, input },
            signal,
          );
          if (!response.ok)
            throw Error("Independent assignment validation held");
          return z
            .strictObject({ validation: assignmentValidationReceipt })
            .parse(await response.json()).validation;
        },
        generate: async (input, signal) => {
          const review = this.review;
          if (!review || !options.admission())
            throw Error("Local inference is paused");
          const model = await options.runtime.pin(
            options.profile(review.profileId),
            signal,
          );
          if (
            this.modelDigest(model) !==
            review.modelDigest.replace(/^sha256:/, "")
          )
            throw new ModelError("MODEL_CHANGED");
          const id = this.currentAssignment;
          if (
            !id ||
            this.db!.prepare(
              "INSERT INTO assignment_model_calls VALUES(?) ON CONFLICT DO NOTHING",
            ).run(id).changes !== 1
          )
            throw Error("Assignment inference already started or unconfirmed");
          return assignmentModel(options.runtime, model)(input, signal);
        },
      },
      options.now,
    );
    this.phase = this.paused() ? "paused" : "idle";
  }
  private modelDigest(model: PinnedModel) {
    return model.digest.replace(/^sha256:/, "");
  }
  private paused() {
    return Boolean(
      (
        this.db
          ?.prepare("SELECT paused FROM assignment_service_settings WHERE id=1")
          .get() as { paused: number } | undefined
      )?.paused,
    );
  }
  status() {
    const assignments =
      this.review?.assignments.map((assignment) => ({
        ...this.runner?.status(assignment.assignmentId),
        assignmentId: assignment.assignmentId,
        taskId: assignment.taskId,
        taskRevision: assignment.taskRevision,
        workflowId: assignment.workflowId,
        workflowRevision: assignment.workflowRevision,
        modelGenerations: this.db
          ?.prepare("SELECT id FROM assignment_model_calls WHERE id=?")
          .get(assignment.assignmentId)
          ? 1
          : 0,
        attempts:
          (
            this.db
              ?.prepare("SELECT attempts FROM assignment_service WHERE id=?")
              .get(assignment.assignmentId) as { attempts: number } | undefined
          )?.attempts ?? 0,
      })) ?? [];
    return {
      phase: this.phase,
      hold: this.hold,
      failure: this.failure,
      expiresAt: this.review?.expiresAt ?? null,
      assignments,
    };
  }
  async pause() {
    this.db
      ?.prepare(
        "INSERT INTO assignment_service_settings VALUES(1,1) ON CONFLICT(id) DO UPDATE SET paused=1",
      )
      .run();
    this.abort?.abort();
    await this.work;
    this.phase = this.options.client ? "paused" : "disabled";
    return this.status();
  }
  resume() {
    if (this.stopping) throw Error("Assignment service closed");
    this.db
      ?.prepare(
        "INSERT INTO assignment_service_settings VALUES(1,0) ON CONFLICT(id) DO UPDATE SET paused=0",
      )
      .run();
    this.phase = this.options.client ? "idle" : "disabled";
    this.hold = null;
    return this.status();
  }
  tick(): Promise<void> {
    if (this.work) return this.work;
    if (this.stopping || !this.options.client || !this.runner || this.paused())
      return Promise.resolve();
    this.work = this.run().finally(() => {
      this.work = undefined;
      this.abort = undefined;
      this.currentAssignment = undefined;
    });
    return this.work;
  }
  private async run() {
    const client = this.options.client!,
      runner = this.runner!,
      db = this.db!;
    this.abort = new AbortController();
    const signal = AbortSignal.any([
      this.abort.signal,
      AbortSignal.timeout(120000),
    ]);
    this.phase = "running";
    this.hold = null;
    this.failure = null;
    try {
      if (!this.options.admission()) {
        this.phase = "paused";
        return;
      }
      const response = await client.execute({ kind: "review" }, signal);
      if (!response.ok) throw Error("Native assignment review unavailable");
      const { review } = z
        .strictObject({ review: assignmentServiceReview })
        .parse(await response.json());
      const at = (this.options.now ?? Date.now)();
      if (
        review.approvedAt > at ||
        review.expiresAt <= at ||
        review.expiresAt - review.approvedAt > 900000
      )
        throw Error("Native assignment review expired");
      this.review = review;
      if (!review.validator) {
        this.phase = "held";
        this.hold = "validation-required";
        return;
      }
      for (const assignment of review.assignments) {
        const id = assignment.assignmentId;
        if (runner.status(id)?.phase === "completed") continue;
        if (runner.status(id)?.phase === "completed-unvalidated") {
          this.phase = "held";
          this.hold = "validation-required";
          continue;
        }
        const row = db
          .prepare(
            "SELECT attempts,terminal FROM assignment_service WHERE id=?",
          )
          .get(id) as { attempts: number; terminal: number } | undefined;
        if (row?.terminal) {
          this.phase = "held";
          this.hold =
            runner.status(id)?.phase === "inference-unconfirmed"
              ? "inference-unconfirmed"
              : "source-or-authority";
          continue;
        }
        if ((row?.attempts ?? 0) >= 3) {
          this.phase = "held";
          this.hold = "attempt-budget";
          continue;
        }
        db.prepare(
          "INSERT INTO assignment_service VALUES(?,1,0) ON CONFLICT(id) DO UPDATE SET attempts=attempts+1",
        ).run(id);
        if (!runner.status(id)?.runId) {
          const intake = await client.execute(
            {
              kind: "assignment",
              epoch: review.epoch,
              input: { kind: "intake", assignmentId: id },
            },
            signal,
          );
          if (!intake.ok) throw Error("Assignment intake unavailable");
          z.object({ runId: z.uuid(), replayed: z.boolean().optional() }).parse(
            await intake.json(),
          );
        }
        this.currentAssignment = id;
        const result = await runner.run(assignment, signal);
        if (result.state === "held") {
          db.prepare("UPDATE assignment_service SET terminal=1 WHERE id=?").run(
            id,
          );
          this.phase = "held";
          this.hold =
            result.reason === "validation-required" ||
            result.reason === "legacy-completion-unvalidated"
              ? "validation-required"
              : result.reason === "completion-unconfirmed" ||
                  result.reason === "source-finalization-unconfirmed" ||
                  result.reason === "source-finalization-approval-unavailable"
                ? result.reason
                : result.reason === "inference-uncertain"
                  ? "inference-unconfirmed"
                  : "source-or-authority";
        } else this.phase = "idle";
        return;
      }
      if (this.phase === "running") this.phase = "idle";
    } catch (error) {
      this.failure =
        error instanceof ModelError
          ? error.code
          : error instanceof Error &&
              [
                "TimeoutError",
                "AbortError",
                "TypeError",
                "SyntaxError",
              ].includes(error.name)
            ? error.name
            : "ACTION_FAILED";
      this.phase = this.paused() ? "paused" : "held";
      this.hold =
        this.currentAssignment &&
        this.runner?.status(this.currentAssignment)?.block?.reason ===
          "validation-rejected"
          ? "validation-rejected"
          : error instanceof ModelError && error.code === "MODEL_CHANGED"
            ? "model-changed"
            : error instanceof ModelError && error.code === "INVALID_OUTPUT"
              ? "invalid-model-result"
              : "source-or-authority";
    }
  }
  async close() {
    this.stopping = true;
    this.abort?.abort();
    await this.work;
    this.runner?.close();
    this.db?.close();
  }
}
