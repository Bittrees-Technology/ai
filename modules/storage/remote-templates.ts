import { z } from "zod";
import { StoreError, type Store, type Owner } from "./store.js";
import type { Vault } from "./vault.js";
import { remoteTemplateSchema } from "../remote/status.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const templateIdentitySchema = z.strictObject({
  scope: z.literal("templates:run"),
  remoteOwnerId: z.uuid(),
  deviceId: z.uuid(),
  epoch: z.number().int().positive().max(2147483647),
  permissionId: z.uuid(),
});
export const templateApprovalSchema = z.strictObject({
  identity: templateIdentitySchema,
  templateId: z.uuid(),
  templateRevision: positive,
  maxRuns: z.number().int().min(1).max(20),
  expiresAt: positive,
  confirmed: z.literal(true),
});
export const templateReceiptSchema = z
  .strictObject({
    id: z.uuid(),
    deviceId: z.uuid(),
    outcome: z.enum(["queued", "expired", "denied", "capacity"]),
    taskId: z.uuid().optional(),
    completedAt: z.iso.datetime(),
  })
  .refine((value) => (value.outcome === "queued") === !!value.taskId);
type Approval = z.infer<typeof templateApprovalSchema>;
type Permission = {
  approval: Approval;
  remaining: number;
  hash: string;
  approvedAt: number;
};
/** Internal boundary. Identity must come from separately authenticated template delivery.
 * No existing pause/cancel credential or HTTP input supplies this authority. */
export class RemoteTemplates {
  constructor(
    private store: Store,
    private vault: Vault,
    private now: () => number,
  ) {}
  private purpose(owner: Owner, kind: string, id: string) {
    return JSON.stringify([
      "remote-template",
      owner.tenantId,
      owner.userId,
      kind,
      id,
    ]);
  }
  private permission(owner: Owner, id: string): Permission | null {
    const row = this.store.db
      .prepare(
        "SELECT payload FROM remote_template_permissions WHERE user_id=? AND tenant_id=? AND id=?",
      )
      .get(owner.userId, owner.tenantId, id) as
      { payload: Buffer | null } | undefined;
    return row?.payload
      ? this.vault.open<Permission>(
          row.payload,
          this.purpose(owner, "permission", id),
        )
      : null;
  }
  approve(owner: Owner, raw: unknown) {
    const approval = templateApprovalSchema.parse(raw);
    return this.store.db
      .transaction(() => {
        const now = this.now();
        if (
          !Number.isFinite(now) ||
          approval.expiresAt <= now ||
          approval.expiresAt - now > 86400000
        )
          throw new StoreError("EXPIRED");
        const template = this.store.template(owner, approval.templateId);
        if (template.revision !== approval.templateRevision)
          throw new StoreError("CONFLICT");
        this.store.profile(owner, template.definition.modelProfileId);
        const hash = this.vault.fingerprint(approval),
          id = approval.identity.permissionId;
        const previous = this.store.db
          .prepare(
            "SELECT id FROM remote_template_permissions WHERE user_id=? AND tenant_id=? AND id=?",
          )
          .get(owner.userId, owner.tenantId, id);
        if (previous) {
          const value = this.permission(owner, id);
          if (!value || value.hash !== hash) throw new StoreError("CONFLICT");
          return {
            approval: value.approval,
            remaining: value.remaining,
            approvedAt: value.approvedAt,
          };
        }
        this.revoke(owner, approval.identity.deviceId, approval.templateId);
        const value: Permission = {
          approval,
          remaining: approval.maxRuns,
          hash,
          approvedAt: now,
        };
        this.store.db
          .prepare(
            "INSERT INTO remote_template_permissions VALUES(?,?,?,?,?,?)",
          )
          .run(
            id,
            owner.userId,
            owner.tenantId,
            approval.identity.deviceId,
            approval.templateId,
            this.vault.seal(value, this.purpose(owner, "permission", id)),
          );
        if (approval.expiresAt <= this.now()) throw new StoreError("EXPIRED");
        return {
          approval,
          remaining: value.remaining,
          approvedAt: value.approvedAt,
        };
      })
      .immediate();
  }
  revoke(owner: Owner, deviceId: string, templateId?: string) {
    z.uuid().parse(deviceId);
    if (templateId !== undefined) z.uuid().parse(templateId);
    return this.store.db
      .transaction(() => {
        this.store.db
          .prepare(
            `UPDATE remote_template_permissions SET payload=NULL WHERE user_id=? AND tenant_id=? AND device_id=?${templateId === undefined ? "" : " AND template_id=?"}`,
          )
          .run(
            owner.userId,
            owner.tenantId,
            deviceId,
            ...(templateId === undefined ? [] : [templateId]),
          );
        return this.invalidateRuns(owner);
      })
      .immediate();
  }
  revokeTemplate(owner: Owner, templateId: string) {
    this.store.db
      .prepare(
        "UPDATE remote_template_permissions SET payload=NULL WHERE user_id=? AND tenant_id=? AND template_id=?",
      )
      .run(owner.userId, owner.tenantId, templateId);
    return this.invalidateRuns(owner);
  }
  /** Used before claiming, on heartbeat and before persisting model output. */
  runAllowed(owner: Owner, taskId: string) {
    const row = this.store.db
      .prepare("SELECT permission_id FROM remote_template_runs WHERE task_id=?")
      .get(taskId) as { permission_id: string } | undefined;
    if (!row) return true;
    const value = this.permission(owner, row.permission_id);
    const now = this.now();
    return !!value && Number.isFinite(now) && value.approval.expiresAt > now;
  }
  invalidateRuns(owner: Owner) {
    const rows = this.store.db
      .prepare(
        "SELECT t.id,t.revision FROM tasks t JOIN remote_template_runs r ON r.task_id=t.id WHERE t.user_id=? AND t.tenant_id=? AND t.status NOT IN ('completed','failed','cancelled','expired')",
      )
      .all(owner.userId, owner.tenantId) as { id: string; revision: number }[];
    const cancelled: string[] = [];
    for (const row of rows)
      if (!this.runAllowed(owner, row.id)) {
        this.store.command(owner, row.id, {
          command: "cancel",
          expectedRevision: row.revision,
        });
        cancelled.push(row.id);
      }
    return cancelled;
  }
  execute(owner: Owner, rawIdentity: unknown, raw: unknown) {
    const identity = templateIdentitySchema.parse(rawIdentity),
      command = remoteTemplateSchema.parse(raw);
    if (identity.deviceId !== command.deviceId)
      throw new StoreError("INVALID_INPUT");
    return this.store.db
      .transaction(() => {
        const now = this.now(),
          value = this.permission(owner, identity.permissionId);
        if (
          !Number.isFinite(now) ||
          !value ||
          this.vault.fingerprint(value.approval.identity) !==
            this.vault.fingerprint(identity) ||
          value.approval.expiresAt <= now ||
          value.approval.templateId !== command.templateId ||
          value.approval.templateRevision !== command.templateRevision
        )
          throw new StoreError("NOT_FOUND");
        const purpose = this.purpose(owner, "receipt", command.id),
          hash = this.vault.fingerprint({ identity, command });
        const previous = this.store.db
          .prepare(
            "SELECT payload FROM remote_template_receipts WHERE user_id=? AND tenant_id=? AND id=?",
          )
          .get(owner.userId, owner.tenantId, command.id) as
          { payload: Buffer } | undefined;
        if (previous) {
          const result = this.vault.open<{ hash: string; receipt: unknown }>(
            previous.payload,
            purpose,
          );
          if (result.hash !== hash) throw new StoreError("CONFLICT");
          return {
            receipt: templateReceiptSchema.parse(result.receipt),
            duplicate: true,
          };
        }
        const issued = Date.parse(command.issuedAt),
          expires = Date.parse(command.expiresAt);
        if (
          issued > now ||
          issued < value.approvedAt ||
          expires <= issued ||
          expires - issued > 300000 ||
          expires > value.approval.expiresAt
        )
          throw new StoreError("INVALID_INPUT");
        let outcome: z.infer<typeof templateReceiptSchema>["outcome"] =
            "expired",
          taskId: string | undefined;
        if (expires > now) {
          const template = this.store.template(owner, command.templateId);
          if (
            template.revision !== command.templateRevision ||
            value.remaining < 1
          )
            outcome = "denied";
          else {
            this.invalidateRuns(owner);
            const pending = this.store.db
              .prepare(
                "SELECT COUNT(*) AS count FROM remote_template_runs r JOIN tasks t ON t.id=r.task_id WHERE t.user_id=? AND t.tenant_id=? AND t.status NOT IN ('completed','failed','cancelled','expired')",
              )
              .get(owner.userId, owner.tenantId) as { count: number };
            if (pending.count >= 20) outcome = "capacity";
            else {
              this.store.profile(owner, template.definition.modelProfileId);
              const { kind, prompt, modelProfileId } = template.definition;
              const task = this.store.create(
                owner,
                {
                  conversationId: command.id,
                  kind,
                  prompt,
                  modelProfileId,
                  tags: [template.id, String(template.revision)],
                  deadline: command.expiresAt,
                },
                `remote-template:${command.id}`,
              );
              taskId = task.id;
              outcome = "queued";
              this.store.db
                .prepare("INSERT INTO remote_template_runs VALUES(?,?)")
                .run(task.id, identity.permissionId);
              value.remaining--;
              this.store.db
                .prepare(
                  "UPDATE remote_template_permissions SET payload=? WHERE user_id=? AND tenant_id=? AND id=?",
                )
                .run(
                  this.vault.seal(
                    value,
                    this.purpose(owner, "permission", identity.permissionId),
                  ),
                  owner.userId,
                  owner.tenantId,
                  identity.permissionId,
                );
            }
          }
        }
        const receipt = templateReceiptSchema.parse({
          id: command.id,
          deviceId: command.deviceId,
          outcome,
          ...(taskId ? { taskId } : {}),
          completedAt: new Date(this.now()).toISOString(),
        });
        this.store.db
          .prepare("INSERT INTO remote_template_receipts VALUES(?,?,?,?)")
          .run(
            owner.userId,
            owner.tenantId,
            command.id,
            this.vault.seal({ identity, command, hash, receipt }, purpose),
          );
        const end = this.now();
        if (
          !Number.isFinite(end) ||
          value.approval.expiresAt <= end ||
          (outcome === "queued" && expires <= end)
        )
          throw new StoreError("EXPIRED");
        return { receipt, duplicate: false };
      })
      .immediate();
  }
  export(owner: Owner) {
    const receipts = (
      this.store.db
        .prepare(
          "SELECT id,payload FROM remote_template_receipts WHERE user_id=? AND tenant_id=? ORDER BY id",
        )
        .all(owner.userId, owner.tenantId) as { id: string; payload: Buffer }[]
    ).map((row) => {
      const { identity, command, receipt } = this.vault.open<{
        identity: unknown;
        command: unknown;
        receipt: unknown;
      }>(row.payload, this.purpose(owner, "receipt", row.id));
      return { identity, command, receipt };
    });
    const permissions = (
      this.store.db
        .prepare(
          "SELECT id FROM remote_template_permissions WHERE user_id=? AND tenant_id=? AND payload IS NOT NULL ORDER BY id",
        )
        .all(owner.userId, owner.tenantId) as { id: string }[]
    ).map((row) => {
      const value = this.permission(owner, row.id)!;
      return {
        approval: value.approval,
        remaining: value.remaining,
        approvedAt: value.approvedAt,
      };
    });
    return { permissions, receipts };
  }
}
