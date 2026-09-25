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
) => Promise<() => void>;

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
  async execute(
    ownerRaw: Owner,
    rawIdentity: unknown,
    raw: unknown,
    access?: ResumeAccess,
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
    if (
      initial.approval.taskId !== command.taskId ||
      initial.approval.taskRevision !== command.expectedRevision
    )
      throw new StoreError("CONFLICT");
    const previous = this.prior(owner, command, hash);
    if (previous) return previous;
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
    const check = await access(
      structuredClone(task),
      structuredClone(this.store.profile(owner, task.input.modelProfileId)),
    );
    if (typeof check !== "function") throw new StoreError("NOT_FOUND");
    const runCheck = () => {
      const result: unknown = check();
      // TypeScript's void callback type can accept an async function. Never let
      // an accidentally asynchronous guard finish after the transaction commits.
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => {});
        throw new StoreError("INVALID_INPUT");
      }
    };
    return this.store.db
      .transaction(() => {
        const current = this.current(owner, identity),
          previous = this.prior(owner, command, hash);
        if (previous) return previous;
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
