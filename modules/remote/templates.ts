import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { RemoteStatusError } from "./status-store.js";
import { remoteTemplateSchema } from "./status.js";
import {
  templateIdentitySchema,
  templateReceiptSchema,
} from "./template-contracts.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const statusIdentity = z.strictObject({
  ownerId: z.uuid(),
  deviceId: z.uuid(),
  epoch: z.number().int().positive().max(2147483647),
});
export const templatePublicationSchema = z.strictObject({
  permissionId: z.uuid(),
  templateId: z.uuid(),
  templateRevision: positive,
  approvedAt: positive,
  expiresAt: positive,
  maxRuns: z.number().int().min(1).max(20),
  credentialHash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
});
const submission = z.strictObject({
  permissionId: z.uuid(),
  command: remoteTemplateSchema,
  confirmed: z.literal(true),
});
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const parse = <T>(schema: z.ZodType<T>, raw: unknown): T => {
  const result = schema.safeParse(raw);
  if (!result.success) throw new RemoteStatusError("INVALID_INPUT");
  return result.data;
};
const metadata = (row: any) => ({
  permissionId: row.permission_id,
  deviceId: row.device_id,
  templateId: row.template_id,
  templateRevision: Number(row.template_revision),
  approvedAt: Number(row.approved_at),
  expiresAt: Number(row.expires_at),
  maxRuns: row.max_runs,
  submittedRuns: row.submitted_runs,
});
const command = (row: any, grant: any) =>
  remoteTemplateSchema.parse({
    id: row.id,
    deviceId: grant.device_id,
    templateId: grant.template_id,
    templateRevision: Number(grant.template_revision),
    issuedAt: new Date(Number(row.issued_at)).toISOString(),
    expiresAt: new Date(Number(row.expires_at)).toISOString(),
  });
/** Internal repository. Native publication identity and browser owner come from verified
 * authentication. Separately scoped credentials authenticate delivery; no local authority is inferred. */
export class RemoteTemplateStore {
  constructor(
    private pool: Pool,
    private retentionMs: number,
    private now = Date.now,
    private limits = {
      permissionsPerDevice: 1000,
      commandsPerDevice: 1000,
      pendingPerDevice: 20,
    },
  ) {
    if (![86400000, 7 * 86400000, 30 * 86400000].includes(retentionMs))
      throw new RemoteStatusError("INVALID_INPUT");
    if (
      [
        limits.permissionsPerDevice,
        limits.commandsPerDevice,
        limits.pendingPerDevice,
      ].some(
        (value) => !Number.isSafeInteger(value) || value < 1 || value > 100000,
      )
    )
      throw new RemoteStatusError("INVALID_INPUT");
    this.limits = { ...limits };
  }
  private async transaction<T>(work: (db: PoolClient) => Promise<T>) {
    let db: PoolClient | undefined;
    try {
      db = await this.pool.connect();
      await db.query("BEGIN");
      await db.query("SET LOCAL statement_timeout='5s'");
      const result = await work(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      if (db) await db.query("ROLLBACK").catch(() => {});
      if (error instanceof RemoteStatusError) throw error;
      if (
        typeof error === "object" &&
        error &&
        "code" in error &&
        error.code === "23505"
      )
        throw new RemoteStatusError("CONFLICT");
      throw new RemoteStatusError("UNAVAILABLE");
    } finally {
      db?.release();
    }
  }
  private fresh(device: any, grant?: any) {
    const now = this.now();
    if (
      !Number.isFinite(now) ||
      device.revoked_at !== null ||
      Number(device.expires_at) <= now ||
      (grant &&
        (grant.revoked_at !== null ||
          !grant.credential_hash ||
          grant.device_epoch !== device.epoch ||
          Number(grant.expires_at) <= now))
    )
      throw new RemoteStatusError("DENIED");
  }
  private async device(db: PoolClient, owner: string, id: string) {
    const row = (
      await db.query(
        "SELECT * FROM remote_devices WHERE owner_id=$1 AND id=$2 FOR UPDATE",
        [owner, id],
      )
    ).rows[0];
    if (!row) throw new RemoteStatusError("DENIED");
    return row;
  }
  private async grant(db: PoolClient, owner: string, permissionId: string) {
    const found = (
      await db.query(
        "SELECT device_id FROM remote_templates WHERE permission_id=$1",
        [permissionId],
      )
    ).rows[0];
    if (!found) throw new RemoteStatusError("DENIED");
    const device = await this.device(db, owner, found.device_id);
    const grant = (
      await db.query(
        "SELECT * FROM remote_templates WHERE permission_id=$1 FOR UPDATE",
        [permissionId],
      )
    ).rows[0];
    if (!grant) throw new RemoteStatusError("DENIED");
    return { device, grant };
  }
  private async identity(db: PoolClient, raw: unknown) {
    const identity = parse(templateIdentitySchema, raw);
    const { device, grant } = await this.grant(
      db,
      identity.remoteOwnerId,
      identity.permissionId,
    );
    this.fresh(device, grant);
    if (device.id !== identity.deviceId || device.epoch !== identity.epoch)
      throw new RemoteStatusError("DENIED");
    return { identity, device, grant };
  }
  async publish(rawIdentity: unknown, raw: unknown) {
    const identity = parse(statusIdentity, rawIdentity),
      input = parse(templatePublicationSchema, raw),
      publicationHash = hash(JSON.stringify(input));
    return this.transaction(async (db) => {
      const device = await this.device(db, identity.ownerId, identity.deviceId);
      this.fresh(device);
      if (device.epoch !== identity.epoch)
        throw new RemoteStatusError("DENIED");
      const previous = (
        await db.query(
          "SELECT * FROM remote_templates WHERE permission_id=$1",
          [input.permissionId],
        )
      ).rows[0];
      if (previous) {
        if (previous.device_id !== identity.deviceId)
          throw new RemoteStatusError("DENIED");
        this.fresh(device, previous);
        if (previous.publication_hash !== publicationHash)
          throw new RemoteStatusError("CONFLICT");
        return { template: metadata(previous), duplicate: true };
      }
      const now = this.now();
      if (
        input.approvedAt > now ||
        now - input.approvedAt > 300000 ||
        input.expiresAt <= now ||
        input.expiresAt <= input.approvedAt ||
        input.expiresAt - input.approvedAt > 86400000 ||
        input.expiresAt > Number(device.expires_at)
      )
        throw new RemoteStatusError("INVALID_INPUT");
      const count = Number(
        (
          await db.query(
            "SELECT count(*) FROM remote_templates WHERE device_id=$1",
            [device.id],
          )
        ).rows[0].count,
      );
      if (count >= this.limits.permissionsPerDevice)
        throw new RemoteStatusError("CAPACITY");
      await db.query(
        "UPDATE remote_templates SET revoked_at=$3,credential_hash=NULL WHERE device_id=$1 AND template_id=$2 AND revoked_at IS NULL",
        [device.id, input.templateId, now],
      );
      const row = (
        await db.query(
          "INSERT INTO remote_templates(permission_id,device_id,device_epoch,template_id,template_revision,approved_at,expires_at,max_runs,credential_hash,publication_hash,purge_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
          [
            input.permissionId,
            device.id,
            device.epoch,
            input.templateId,
            input.templateRevision,
            input.approvedAt,
            input.expiresAt,
            input.maxRuns,
            input.credentialHash,
            publicationHash,
            input.expiresAt + this.retentionMs,
          ],
        )
      ).rows[0];
      this.fresh(device, row);
      return { template: metadata(row), duplicate: false };
    });
  }
  async authenticate(credential: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(credential))
      throw new RemoteStatusError("DENIED");
    return this.transaction(async (db) => {
      const digest = hash(credential);
      const found = (
        await db.query(
          "SELECT t.permission_id,d.owner_id FROM remote_templates t JOIN remote_devices d ON d.id=t.device_id WHERE t.credential_hash=$1",
          [digest],
        )
      ).rows[0];
      if (!found) throw new RemoteStatusError("DENIED");
      const { device, grant } = await this.grant(
        db,
        found.owner_id,
        found.permission_id,
      );
      this.fresh(device, grant);
      if (grant.credential_hash !== digest)
        throw new RemoteStatusError("DENIED");
      return templateIdentitySchema.parse({
        scope: "templates:run",
        remoteOwnerId: device.owner_id,
        deviceId: device.id,
        epoch: device.epoch,
        permissionId: grant.permission_id,
      });
    });
  }
  async list(owner: string, deviceId: string, after?: string) {
    parse(z.uuid(), owner);
    parse(z.uuid(), deviceId);
    if (after !== undefined) parse(z.uuid(), after);
    return this.transaction(async (db) => {
      const device = await this.device(db, owner, deviceId);
      this.fresh(device);
      const rows = (
        await db.query(
          "SELECT * FROM remote_templates WHERE device_id=$1 AND device_epoch=$2 AND revoked_at IS NULL AND credential_hash IS NOT NULL AND expires_at>$3 AND ($4::uuid IS NULL OR permission_id>$4) ORDER BY permission_id LIMIT 101",
          [deviceId, device.epoch, this.now(), after ?? null],
        )
      ).rows;
      this.fresh(device);
      return {
        items: rows.slice(0, 100).map(metadata),
        nextCursor:
          rows.length > 100 ? (rows[99].permission_id as string) : null,
      };
    });
  }
  async revoke(owner: string, permissionId: string) {
    parse(z.uuid(), owner);
    parse(z.uuid(), permissionId);
    return this.transaction(async (db) => {
      await this.grant(db, owner, permissionId);
      await db.query(
        "UPDATE remote_templates SET revoked_at=COALESCE(revoked_at,$2),credential_hash=NULL WHERE permission_id=$1",
        [permissionId, this.now()],
      );
      return { revoked: true };
    });
  }
  async submit(owner: string, raw: unknown) {
    parse(z.uuid(), owner);
    const input = parse(submission, raw),
      requestHash = hash(JSON.stringify(input));
    return this.transaction(async (db) => {
      const { device, grant } = await this.grant(db, owner, input.permissionId);
      this.fresh(device, grant);
      const r = input.command;
      if (
        r.deviceId !== device.id ||
        r.templateId !== grant.template_id ||
        r.templateRevision !== Number(grant.template_revision)
      )
        throw new RemoteStatusError("CONFLICT");
      const old = (
        await db.query("SELECT * FROM remote_template_commands WHERE id=$1", [
          r.id,
        ])
      ).rows[0];
      if (old) {
        if (old.permission_id !== input.permissionId)
          throw new RemoteStatusError("DENIED");
        if (old.request_hash !== requestHash)
          throw new RemoteStatusError("CONFLICT");
        this.fresh(device, grant);
        return { command: command(old, grant), duplicate: true };
      }
      const now = this.now(),
        issued = Date.parse(r.issuedAt),
        expires = Date.parse(r.expiresAt);
      if (
        issued > now ||
        issued < Number(grant.approved_at) ||
        expires <= now ||
        expires <= issued ||
        expires - issued > 300000 ||
        expires > Number(grant.expires_at)
      )
        throw new RemoteStatusError("INVALID_INPUT");
      if (grant.submitted_runs >= grant.max_runs)
        throw new RemoteStatusError("CAPACITY");
      const count = (
        await db.query(
          "SELECT count(*) AS stored,count(*) FILTER(WHERE c.outcome IS NULL AND c.expires_at>$2 AND t.revoked_at IS NULL AND t.device_epoch=$3) AS pending FROM remote_template_commands c JOIN remote_templates t ON t.permission_id=c.permission_id WHERE t.device_id=$1",
          [device.id, now, device.epoch],
        )
      ).rows[0];
      if (
        Number(count.stored) >= this.limits.commandsPerDevice ||
        Number(count.pending) >= this.limits.pendingPerDevice
      )
        throw new RemoteStatusError("CAPACITY");
      const row = (
        await db.query(
          "INSERT INTO remote_template_commands(id,permission_id,request_hash,issued_at,expires_at,purge_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [
            r.id,
            grant.permission_id,
            requestHash,
            issued,
            expires,
            expires + this.retentionMs,
          ],
        )
      ).rows[0];
      await db.query(
        "UPDATE remote_templates SET submitted_runs=submitted_runs+1 WHERE permission_id=$1",
        [grant.permission_id],
      );
      this.fresh(device, grant);
      if (expires <= this.now()) throw new RemoteStatusError("DENIED");
      return { command: command(row, grant), duplicate: false };
    });
  }
  async poll(rawIdentity: unknown) {
    return this.transaction(async (db) => {
      const { identity, device, grant } = await this.identity(db, rawIdentity);
      const rows = (
        await db.query(
          "SELECT * FROM remote_template_commands WHERE permission_id=$1 AND outcome IS NULL AND expires_at>$2 ORDER BY issued_at,id LIMIT 20",
          [grant.permission_id, this.now()],
        )
      ).rows;
      this.fresh(device, grant);
      return { identity, commands: rows.map((row) => command(row, grant)) };
    });
  }
  async acknowledge(rawIdentity: unknown, raw: unknown) {
    const receipt = parse(templateReceiptSchema, raw);
    return this.transaction(async (db) => {
      const { device, grant } = await this.identity(db, rawIdentity);
      if (receipt.deviceId !== device.id) throw new RemoteStatusError("DENIED");
      const row = (
        await db.query(
          "SELECT * FROM remote_template_commands WHERE id=$1 AND permission_id=$2 FOR UPDATE",
          [receipt.id, grant.permission_id],
        )
      ).rows[0];
      if (!row) throw new RemoteStatusError("DENIED");
      const completed = Date.parse(receipt.completedAt),
        now = this.now();
      if (
        completed < Number(row.issued_at) ||
        completed > now + 30000 ||
        (receipt.outcome === "queued" && completed >= Number(row.expires_at)) ||
        (receipt.outcome === "expired" && completed < Number(row.expires_at))
      )
        throw new RemoteStatusError("INVALID_INPUT");
      if (row.outcome !== null) {
        if (
          row.outcome !== receipt.outcome ||
          row.task_id !== (receipt.taskId ?? null) ||
          Number(row.completed_at) !== completed
        )
          throw new RemoteStatusError("CONFLICT");
        this.fresh(device, grant);
        return { receipt, duplicate: true };
      }
      await db.query(
        "UPDATE remote_template_commands SET outcome=$2,task_id=$3,completed_at=$4 WHERE id=$1",
        [row.id, receipt.outcome, receipt.taskId ?? null, completed],
      );
      this.fresh(device, grant);
      return { receipt, duplicate: false };
    });
  }
  async inspect(owner: string, permissionId: string, id: string) {
    parse(z.uuid(), owner);
    parse(z.uuid(), permissionId);
    parse(z.uuid(), id);
    return this.transaction(async (db) => {
      const { device, grant } = await this.grant(db, owner, permissionId);
      const row = (
        await db.query(
          "SELECT * FROM remote_template_commands WHERE id=$1 AND permission_id=$2",
          [id, permissionId],
        )
      ).rows[0];
      if (!row) throw new RemoteStatusError("DENIED");
      if (row.outcome !== null)
        return {
          state: "received",
          receipt: templateReceiptSchema.parse({
            id,
            deviceId: device.id,
            outcome: row.outcome,
            ...(row.task_id ? { taskId: row.task_id } : {}),
            completedAt: new Date(Number(row.completed_at)).toISOString(),
          }),
        };
      let state = "pending";
      try {
        this.fresh(device, grant);
      } catch {
        state = "cancelled";
      }
      if (state === "pending" && Number(row.expires_at) <= this.now())
        state = "expired";
      return { state };
    });
  }
}
