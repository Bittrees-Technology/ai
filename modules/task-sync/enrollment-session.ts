import Database from "better-sqlite3";
import {
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { canonical } from "../contracts/canonical-json.js";
import { Vault } from "../storage/vault.js";
import {
  EnrollmentTransportPlan,
  enrollmentOperation,
  type EnrollmentReview,
} from "./enrollment-transport-plan.js";
import { EnrollmentJournal } from "./enrollment-journal.js";
import { EnrollmentExchange } from "./enrollment-exchange.js";
import { EnrollmentResponseVerifier } from "./enrollment-verifier.js";
import {
  validateEnrollmentStart,
  validateEnrollmentPoll,
} from "./enrollment-response.js";
const hash = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
const scope = (r: EnrollmentReview) =>
  hash({
    epoch: r.epoch,
    expiresAt: r.expiresAt,
    authorityId: r.authorityId,
    deviceId: r.deviceId,
    sourceWorkspace: r.sourceWorkspace,
    principal: r.principal,
    publicKey: r.publicKey,
    ownerWallet: r.ownerWallet,
  });
type State = {
  calls?: number;
  polls?: number;
  lastPoll?: number;
  epoch: string;
  scopeDigest: string;
  requestId?: string;
  pollSecretHash?: string;
  enrollmentRequestDigest?: string;
  challenge?: unknown;
  start?: unknown;
  completion?: unknown;
};
/** Inactive assembly. Owner scope and dispatch are injected by trusted native code.
 * Does not create reviews, extend deadlines, grant roles, or automatically poll/retry.
 * State and mutation journal survive restart; uncertain mutations remain held.
 */
export class EnrollmentSession {
  private db!: Database.Database;
  private journal: EnrollmentJournal;
  private exchange: EnrollmentExchange;
  private state: State;
  private busy = false;
  private ownerPath: string;
  private ownerToken = randomUUID();
  private closed = false;
  constructor(
    path: string,
    private vault: Vault,
    private current: () => EnrollmentReview | null,
    dispatch: ConstructorParameters<typeof EnrollmentExchange>[2],
    pinnedSigner: string,
    private now = Date.now,
  ) {
    const initial = current();
    if (!initial) throw Error("Explicit review required");
    this.ownerPath = path + ".enrollment-owner";
    let fd: number;
    try {
      fd = openSync(this.ownerPath, "wx", 0o600);
    } catch {
      throw Error(
        "Enrollment owner already present; reconcile stale owner before reuse",
      );
    }
    try {
      writeFileSync(fd, this.ownerToken);
    } finally {
      closeSync(fd);
    }
    try {
      this.db = new Database(path);
      this.db.pragma("journal_mode=WAL");
      this.db.pragma("synchronous=FULL");
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS enrollment_sessions(epoch TEXT PRIMARY KEY,value BLOB NOT NULL)",
      );
      const row = this.db
        .prepare("SELECT value FROM enrollment_sessions WHERE epoch=?")
        .get(initial.epoch) as { value: Buffer } | undefined;
      const scopeDigest = scope(initial);
      this.state = row
        ? vault.open<State>(row.value, "enrollment-session:" + initial.epoch)
        : { epoch: initial.epoch, scopeDigest };
      if (this.state.scopeDigest !== scopeDigest) {
        this.db.close();
        throw Error("Persisted owner scope changed");
      }
      this.save();
      const context = () => this.context();
      const planner = new EnrollmentTransportPlan(context, now);
      this.journal = new EnrollmentJournal(path, vault, () => {
        planner.assertCurrent();
      });
      const verifier = new EnrollmentResponseVerifier(
        context,
        () => this.state.challenge,
        pinnedSigner,
        now,
      );
      this.exchange = new EnrollmentExchange(
        planner,
        this.journal,
        dispatch,
        verifier.verify,
      );
    } catch (error) {
      try {
        this.db!.close();
      } catch {}
      this.releaseOwner();
      throw error;
    }
  }
  private releaseOwner() {
    if (readFileSync(this.ownerPath, "utf8") !== this.ownerToken)
      throw Error("Enrollment owner changed; preserve lock for reconciliation");
    unlinkSync(this.ownerPath);
  }
  private context(): EnrollmentReview | null {
    const r = this.current();
    if (
      !r ||
      r.epoch !== this.state.epoch ||
      scope(r) !== this.state.scopeDigest ||
      !Number.isSafeInteger(this.now()) ||
      r.expiresAt <= this.now()
    )
      return null;
    return {
      ...r,
      requestId: this.state.requestId,
      pollSecretHash: this.state.pollSecretHash,
      enrollmentRequestDigest: this.state.enrollmentRequestDigest,
    };
  }
  private save() {
    this.db
      .prepare("INSERT OR REPLACE INTO enrollment_sessions VALUES(?,?)")
      .run(
        this.state.epoch,
        this.vault.seal(this.state, "enrollment-session:" + this.state.epoch),
      );
  }
  async execute(raw: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.closed) throw Error("Enrollment session closed");
    if (this.busy) throw Error("Enrollment session already active");
    const op = enrollmentOperation.parse(raw);
    this.busy = true;
    try {
      signal.throwIfAborted();
      if (!this.context()) throw Error("Owner scope expired or changed");
      if ((this.state.calls ?? 0) >= 108)
        throw Error("Persisted enrollment call limit reached");
      if (
        op.operation === "poll" &&
        ((this.state.polls ?? 0) >= 100 ||
          (this.state.lastPoll !== undefined &&
            this.now() - this.state.lastPoll < 3000))
      )
        throw Error("Persisted polling bound reached");
      this.state.calls = (this.state.calls ?? 0) + 1;
      if (op.operation === "poll") {
        this.state.polls = (this.state.polls ?? 0) + 1;
        this.state.lastPoll = this.now();
      }
      // Reserve budget before dispatch. Failed/uncertain requests do not refund it.
      this.save();
      const response = await this.exchange.execute(op, signal);
      const review = this.context();
      if (!review) throw Error("Review revoked before state persistence");
      signal.throwIfAborted();
      if (op.operation === "start") {
        const start = validateEnrollmentStart(response, review, this.now());
        this.state = {
          ...this.state,
          start,
          requestId: start.id,
          pollSecretHash: hash(start.pollSecret),
        };
      } else if (
        op.operation === "poll" &&
        (response as { status?: string }).status === "approved"
      ) {
        const approved = validateEnrollmentPoll(response, review, this.now());
        if (approved.status !== "approved") throw Error("Expected challenge");
        this.state = {
          ...this.state,
          challenge: approved.request,
          enrollmentRequestDigest: hash(approved.request),
        };
      } else if (
        op.operation === "complete" ||
        (op.operation === "poll" &&
          (response as { status?: string }).status === "complete")
      ) {
        this.state = { ...this.state, completion: response };
      }
      this.save();
      return response;
    } finally {
      this.busy = false;
    }
  }
  close() {
    if (this.closed) return;
    if (this.busy) throw Error("Cannot close an active enrollment exchange");
    this.journal.close();
    this.db.close();
    this.releaseOwner();
    this.closed = true;
  }
}
