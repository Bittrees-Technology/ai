import type { PinnedModel } from "../models/ollama.js";
import { z } from "zod";
import { StoreError, type Store, type Owner, type Task } from "./store.js";
import type { Vault } from "./vault.js";
import {
  resumeIdentitySchema,
  resumeApprovalSchema,
  resumeCommandSchema,
  resumeReceiptSchema,
} from "../remote/resume-contracts.js";
const permissionSchema = z.strictObject({
  approval: resumeApprovalSchema,
  approvedAt: z.number().int().nonnegative(),
  snapshot: z.string().regex(/^[a-f0-9]{64}$/),
  consumed: z.boolean(),
});
const savedReceiptSchema = z.strictObject({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  receipt: resumeReceiptSchema,
});
type Identity = z.infer<typeof resumeIdentitySchema>;
type Command = z.infer<typeof resumeCommandSchema>;
type Permission = z.infer<typeof permissionSchema>;
/** Host must freshly validate source, dependencies and pinned model outside SQL,
 * then return a bounded synchronous check through commit. No default allow path. */
export type ResumeAccess = (
  task: Task,
  profile: ReturnType<Store["profile"]>,
  approvedModelDigest: string,
) => Promise<() => void>;

/** Trusted in-process encrypted receiver boundary, never parsed from a request.
 * Cryptography must finish before calling executeDelivery. Both callbacks run
 * synchronously inside the SAME write transaction as the task and receipt.
 * check revalidates current private consent/keys even for duplicate receipts;
 * admit must retain/classify the exact authenticated envelope in the shared
 * replay ledger. A duplicate may not invent a missing admission record. */
export type ResumeAdmission = {
  check: () => void;
  admit: (receipt: z.infer<typeof resumeReceiptSchema>) => "new" | "duplicate";
};
function synchronousCheck(check: () => void) {
  const result: unknown = check();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    throw new StoreError("INVALID_INPUT");
  }
}

/** Companion-side foundation only: no route, credential issuer or polling loop.
 * Identity comes from future separately authenticated resume delivery; a request
 * body or an existing pause/cancel grant is never an identity provider. */
export class RemoteResumes {
  constructor(
    private store: Store,
    private vault: Vault,
    private now: () => number,
  ) {}
  private purpose(owner: Owner, kind: string, id: string) {
    return JSON.stringify([
      "remote-resume:v1",
      owner.tenantId,
      owner.userId,
      kind,
      id,
    ]);
  }
  private row(owner: Owner, id: string) {
    return this.store.db
      .prepare(
        "SELECT payload FROM remote_resume_permissions WHERE user_id=? AND tenant_id=? AND id=?",
      )
      .get(owner.userId, owner.tenantId, id) as
      { payload: Buffer | null } | undefined;
  }
  private permission(owner: Owner, id: string): Permission | null {
    const row = this.row(owner, id);
    return row?.payload
      ? permissionSchema.parse(
          this.vault.open(row.payload, this.purpose(owner, "permission", id)),
        )
      : null;
  }
  private current(owner: Owner, identity: Identity) {
    const value = this.permission(owner, identity.permissionId),
      now = this.now();
    if (
      !value ||
      !Number.isSafeInteger(now) ||
      now < value.approvedAt ||
      now >= value.approval.expiresAt ||
      this.vault.fingerprint(value.approval.identity) !==
        this.vault.fingerprint(identity)
    )
      throw new StoreError("NOT_FOUND");
    return value;
  }
  private snapshot(owner: Owner, task: Task) {
    return this.vault.fingerprint({
      input: task.input,
      source: this.store.sourceBinding(owner, task.id),
      profile: this.store.profile(owner, task.input.modelProfileId),
    });
  }
  private eligible(
    owner: Owner,
    approval: z.infer<typeof resumeApprovalSchema>,
  ) {
    const task = this.store.get(owner, approval.taskId);
    if (task.status !== "paused" || task.revision !== approval.taskRevision)
      throw new StoreError("CONFLICT");
    if (task.input.deadline && Date.parse(task.input.deadline) <= this.now())
      throw new StoreError("EXPIRED");
    return task;
  }
  /** Explicit local review of ONE paused task revision; never a blanket grant. */
  approve(owner: Owner, raw: unknown) {
    const approval = resumeApprovalSchema.parse(raw);
    return this.store.db
      .transaction(() => {
        const now = this.now();
        if (
          !Number.isSafeInteger(now) ||
          now < 0 ||
          approval.expiresAt <= now ||
          approval.expiresAt - now > 86400000
        )
          throw new StoreError("EXPIRED");
        const task = this.eligible(owner, approval),
          snapshot = this.snapshot(owner, task),
          id = approval.identity.permissionId;
        if (this.row(owner, id)) {
          const previous = this.current(owner, approval.identity);
          if (
            previous.consumed ||
            previous.snapshot !== snapshot ||
            this.vault.fingerprint(previous.approval) !==
              this.vault.fingerprint(approval)
          )
            throw new StoreError("CONFLICT");
          return structuredClone(previous.approval);
        }
        const count = this.store.db
          .prepare(
            "SELECT count(*) AS n FROM remote_resume_permissions WHERE user_id=? AND tenant_id=?",
          )
          .get(owner.userId, owner.tenantId) as { n: number };
        if (count.n >= 256) throw new StoreError("CAPACITY");
        this.revoke(owner, approval.identity.deviceId, task.id);
        const value: Permission = {
          approval,
          approvedAt: now,
          snapshot,
          consumed: false,
        };
        this.store.db
          .prepare("INSERT INTO remote_resume_permissions VALUES(?,?,?,?,?,?)")
          .run(
            owner.userId,
            owner.tenantId,
            id,
            approval.identity.deviceId,
            task.id,
            this.vault.seal(value, this.purpose(owner, "permission", id)),
          );
        if (this.now() < now || this.now() >= approval.expiresAt)
          throw new StoreError("EXPIRED");
        return structuredClone(approval);
      })
      .immediate();
  }
  revoke(owner: Owner, deviceId: string, taskId?: string) {
    z.uuid().parse(deviceId);
    if (taskId !== undefined) z.uuid().parse(taskId);
    this.store.db
      .prepare(
        `UPDATE remote_resume_permissions SET payload=NULL WHERE user_id=? AND tenant_id=? AND device_id=?${taskId ? " AND task_id=?" : ""}`,
      )
      .run(owner.userId, owner.tenantId, deviceId, ...(taskId ? [taskId] : []));
  }
  revokePermission(owner: Owner, permissionId: string) {
    z.uuid().parse(permissionId);
    this.store.db
      .prepare(
        "UPDATE remote_resume_permissions SET payload=NULL WHERE user_id=? AND tenant_id=? AND id=?",
      )
      .run(owner.userId, owner.tenantId, permissionId);
  }
  private prior(owner: Owner, command: Command, hash: string) {
    const row = this.store.db
      .prepare(
        "SELECT payload FROM remote_resume_receipts WHERE user_id=? AND tenant_id=? AND id=?",
      )
      .get(owner.userId, owner.tenantId, command.id) as
      { payload: Buffer } | undefined;
    if (!row) return null;
    const value = savedReceiptSchema.parse(
      this.vault.open(row.payload, this.purpose(owner, "receipt", command.id)),
    );
    if (value.hash !== hash) throw new StoreError("CONFLICT");
    return { receipt: value.receipt, duplicate: true };
  }
  execute(
    owner: Owner,
    identity: unknown,
    command: unknown,
    access?: ResumeAccess,
  ) {
    return this.executeInternal(owner, identity, command, access);
  }
  /** Host-only composition seam. This neither authenticates envelopes nor
   * issues authority. The encrypted receiver must supply BOTH callbacks. */
  executeDelivery(
    owner: Owner,
    identity: unknown,
    command: unknown,
    access: ResumeAccess | undefined,
    admission: ResumeAdmission,
  ) {
    if (
      !admission ||
      typeof admission.check !== "function" ||
      typeof admission.admit !== "function"
    )
      return Promise.reject(new StoreError("INVALID_INPUT"));
    const { check, admit } = admission;
    return this.executeInternal(owner, identity, command, access, {
      check,
      admit,
    });
  }
  private async executeInternal(
    ownerRaw: Owner,
    rawIdentity: unknown,
    raw: unknown,
    access?: ResumeAccess,
    admission?: ResumeAdmission,
  ) {
    const owner = { ...ownerRaw },
      identity = resumeIdentitySchema.parse(rawIdentity),
      command = resumeCommandSchema.parse(raw);
    if (this.store.db.inTransaction) throw new StoreError("CONFLICT");
    if (
      identity.deviceId !== command.deviceId ||
      identity.permissionId !== command.permissionId
    )
      throw new StoreError("INVALID_INPUT");
    const hash = this.vault.fingerprint({ identity, command });
    const initial = this.current(owner, identity);
    if (initial.approval.privatePeerBound && !admission)
      throw new StoreError("NOT_FOUND");
    if (
      initial.approval.taskId !== command.taskId ||
      initial.approval.taskRevision !== command.expectedRevision
    )
      throw new StoreError("CONFLICT");
    const checkAdmission = () => {
      if (admission) synchronousCheck(admission.check);
    };
    const admit = (
      receipt: z.infer<typeof resumeReceiptSchema>,
      duplicate: boolean,
    ) => {
      if (!admission) return;
      const result: unknown = admission.admit(structuredClone(receipt));
      if (result !== (duplicate ? "duplicate" : "new")) {
        void Promise.resolve(result).catch(() => {});
        throw new StoreError("CONFLICT");
      }
    };
    const duplicateResult = () => {
      this.current(owner, identity);
      checkAdmission();
      const prior = this.prior(owner, command, hash);
      if (!prior) throw new StoreError("CONFLICT");
      admit(prior.receipt, true);
      checkAdmission();
      this.current(owner, identity);
      // A trusted admission callback still must not change the saved outcome.
      if (
        this.vault.fingerprint(this.prior(owner, command, hash)) !==
        this.vault.fingerprint(prior)
      )
        throw new StoreError("CONFLICT");
      return prior;
    };
    const previous = this.prior(owner, command, hash);
    if (previous) return this.store.db.transaction(duplicateResult).immediate();
    if (!access) throw new StoreError("NOT_FOUND");
    const checkLease = () => {
      const now = this.now(),
        issued = Date.parse(command.issuedAt),
        expires = Date.parse(command.expiresAt);
      if (
        !Number.isSafeInteger(now) ||
        issued > now ||
        issued < initial.approvedAt ||
        expires <= now ||
        expires <= issued ||
        expires - issued > 300000 ||
        expires > initial.approval.expiresAt
      )
        throw new StoreError("EXPIRED");
    };
    checkLease();
    if (initial.consumed) throw new StoreError("CONFLICT");
    const task = this.eligible(owner, initial.approval);
    if (this.snapshot(owner, task) !== initial.snapshot)
      throw new StoreError("CONFLICT");
    if (admission) this.store.db.transaction(checkAdmission).immediate();
    const check = await access(
      structuredClone(task),
      structuredClone(this.store.profile(owner, task.input.modelProfileId)),
      initial.approval.modelDigest,
    );
    if (typeof check !== "function") throw new StoreError("NOT_FOUND");
    const runCheck = () => synchronousCheck(check);
    return this.store.db
      .transaction(() => {
        const current = this.current(owner, identity),
          previous = this.prior(owner, command, hash);
        if (previous) return duplicateResult();
        checkAdmission();
        checkLease();
        if (
          current.consumed ||
          this.vault.fingerprint(current) !== this.vault.fingerprint(initial)
        )
          throw new StoreError("CONFLICT");
        const before = this.eligible(owner, current.approval);
        if (this.snapshot(owner, before) !== current.snapshot)
          throw new StoreError("CONFLICT");
        runCheck();
        const count = this.store.db
          .prepare(
            "SELECT count(*) AS n FROM remote_resume_receipts WHERE user_id=? AND tenant_id=?",
          )
          .get(owner.userId, owner.tenantId) as { n: number };
        if (count.n >= 1024) throw new StoreError("CAPACITY");
        const resumed = this.store.command(owner, command.taskId, {
          command: "resume",
          expectedRevision: command.expectedRevision,
        });
        const receipt = resumeReceiptSchema.parse({
          version: 1,
          id: command.id,
          deviceId: command.deviceId,
          permissionId: command.permissionId,
          taskId: command.taskId,
          taskRevision: resumed.revision,
          outcome: resumed.status,
          completedAt: new Date(this.now()).toISOString(),
        });
        this.store.db
          .prepare("INSERT INTO remote_resume_receipts VALUES(?,?,?,?)")
          .run(
            owner.userId,
            owner.tenantId,
            command.id,
            this.vault.seal(
              { hash, receipt },
              this.purpose(owner, "receipt", command.id),
            ),
          );
        this.store.db
          .prepare(
            "UPDATE remote_resume_permissions SET payload=? WHERE user_id=? AND tenant_id=? AND id=?",
          )
          .run(
            this.vault.seal(
              { ...current, consumed: true },
              this.purpose(owner, "permission", identity.permissionId),
            ),
            owner.userId,
            owner.tenantId,
            identity.permissionId,
          );
        // Admission and all resume effects share this transaction. A failed
        // replay/consent check rolls back BOTH sides, including duplicate paths.
        admit(receipt, false);
        checkAdmission();
        // Any failure rolls back the task transition, receipt and permission use.
        runCheck();
        checkLease();
        this.current(owner, identity);
        if (
          resumed.input.deadline &&
          Date.parse(resumed.input.deadline) <= this.now()
        )
          throw new StoreError("EXPIRED");
        if (this.snapshot(owner, resumed) !== current.snapshot)
          throw new StoreError("CONFLICT");
        return { receipt, duplicate: false };
      })
      .immediate();
  }
  /** Local classification only, never an authority grant. Missing retained
   * permission fails closed even when deciding whether network verification is needed. */
  requiresPrivateAuthority(owner: Owner, taskId: string) {
    const rows = this.store.db
      .prepare(
        "SELECT id,payload FROM remote_resume_receipts WHERE user_id=? AND tenant_id=? ORDER BY rowid DESC",
      )
      .all(owner.userId, owner.tenantId) as { id: string; payload: Buffer }[];
    for (const row of rows) {
      const { receipt } = savedReceiptSchema.parse(
        this.vault.open(row.payload, this.purpose(owner, "receipt", row.id)),
      );
      if (receipt.taskId !== taskId) continue;
      const permission = this.permission(owner, receipt.permissionId);
      if (!permission) throw new StoreError("NOT_FOUND");
      return permission.approval.privatePeerBound === true;
    }
    return false;
  }
  /** A remotely resumed task retains its execution constraint across worker
   * claims, clarification waits and restart. Revoked/restored grants fail closed.
   * Local tasks with no resume receipt retain their existing execution policy. */
  checkExecutionModel(
    owner: Owner,
    taskId: string,
    model: PinnedModel,
    privateAuthority?: (permissionId: string) => void,
  ) {
    const rows = this.store.db
      .prepare(
        "SELECT id,payload FROM remote_resume_receipts WHERE user_id=? AND tenant_id=? ORDER BY rowid DESC",
      )
      .all(owner.userId, owner.tenantId) as { id: string; payload: Buffer }[];
    for (const row of rows) {
      const { receipt } = savedReceiptSchema.parse(
        this.vault.open(row.payload, this.purpose(owner, "receipt", row.id)),
      );
      if (receipt.taskId !== taskId) continue;
      const permission = this.permission(owner, receipt.permissionId);
      if (!permission) throw new StoreError("NOT_FOUND");
      this.current(owner, permission.approval.identity);
      if (permission.approval.privatePeerBound) {
        if (!privateAuthority) throw new StoreError("NOT_FOUND");
        synchronousCheck(() => privateAuthority(receipt.permissionId));
      }
      const task = this.store.get(owner, taskId);
      if (
        !permission.consumed ||
        permission.approval.taskId !== taskId ||
        permission.approval.modelDigest !== model.digest ||
        this.snapshot(owner, task) !== permission.snapshot ||
        this.vault.fingerprint(model.profile) !==
          this.vault.fingerprint(
            this.store.profile(owner, task.input.modelProfileId),
          )
      )
        throw new StoreError("CONFLICT");
      return;
    }
  }
  history(owner: Owner) {
    return (
      this.store.db
        .prepare(
          "SELECT id,device_id,task_id,payload FROM remote_resume_permissions WHERE user_id=? AND tenant_id=? ORDER BY id",
        )
        .all(owner.userId, owner.tenantId) as {
        id: string;
        device_id: string;
        task_id: string;
        payload: Buffer | null;
      }[]
    ).map((row) => ({
      id: row.id,
      deviceId: row.device_id,
      taskId: row.task_id,
      permission: row.payload
        ? permissionSchema.parse(
            this.vault.open(
              row.payload,
              this.purpose(owner, "permission", row.id),
            ),
          )
        : null,
      revoked: row.payload === null,
    }));
  }
  /** Owner-local metadata only. Revocation never erases the idempotency receipt. */
  receipts(owner: Owner) {
    return (
      this.store.db
        .prepare(
          "SELECT id,payload FROM remote_resume_receipts WHERE user_id=? AND tenant_id=? ORDER BY id",
        )
        .all(owner.userId, owner.tenantId) as { id: string; payload: Buffer }[]
    ).map(
      (r) =>
        savedReceiptSchema.parse(
          this.vault.open(r.payload, this.purpose(owner, "receipt", r.id)),
        ).receipt,
    );
  }
}
