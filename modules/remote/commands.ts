import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import {
  remoteControlSchema,
  remoteReceiptSchema,
  parseRemoteControl,
} from "./status.js";
import { RemoteStatusError } from "./status-store.js";
const identity = z.strictObject({
  ownerId: z.uuid(),
  deviceId: z.uuid(),
  epoch: z.number().int().positive(),
  controlId: z.uuid(),
});
const request = remoteControlSchema;
const envelope = (r: any) =>
  remoteControlSchema.parse({
    id: r.id,
    deviceId: r.device_id,
    taskId: r.task_id,
    command: r.command,
    expectedRevision: Number(r.expected_revision),
    issuedAt: new Date(Number(r.issued_at)).toISOString(),
    expiresAt: new Date(Number(r.expires_at)).toISOString(),
  });
/** Internal queue only. Control-scoped transport authenticates callers; no local execution here. */
export class RemoteCommandStore {
  constructor(
    private pool: Pool,
    private retentionMs: number,
    private now = Date.now,
  ) {
    if (
      ![86400000, 7 * 86400000, 30 * 86400000, 90 * 86400000].includes(
        retentionMs,
      )
    )
      throw new RemoteStatusError("INVALID_INPUT");
  }
  private async transaction<T>(fn: (db: PoolClient) => Promise<T>) {
    let db: PoolClient | undefined;
    try {
      db = await this.pool.connect();
      await db.query("BEGIN");
      await db.query("SET LOCAL statement_timeout = '5s'");
      const value = await fn(db);
      await db.query("COMMIT");
      return value;
    } catch (e) {
      if (db) await db.query("ROLLBACK").catch(() => {});
      if (e instanceof RemoteStatusError) throw e;
      if (typeof e === "object" && e && "code" in e && e.code === "23505")
        throw new RemoteStatusError("CONFLICT");
      throw new RemoteStatusError("UNAVAILABLE");
    } finally {
      db?.release();
    }
  }
  private async device(
    db: PoolClient,
    ownerId: string,
    deviceId: string,
    epoch?: number,
    controlId?: string,
  ) {
    const d = (
      await db.query(
        "SELECT * FROM remote_devices WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        [deviceId, ownerId],
      )
    ).rows[0];
    if (
      !d ||
      d.revoked_at !== null ||
      Number(d.expires_at) <= this.now() ||
      !d.controls_enabled ||
      !d.control_id ||
      (epoch !== undefined && d.epoch !== epoch) ||
      (controlId !== undefined && d.control_id !== controlId)
    )
      throw new RemoteStatusError("DENIED");
    return d;
  }
  async submit(ownerId: string, raw: unknown) {
    const parsed = request.safeParse(raw);
    if (!z.uuid().safeParse(ownerId).success || !parsed.success)
      throw new RemoteStatusError("INVALID_INPUT");
    const r = parsed.data;
    const requestHash = createHash("sha256")
      .update(JSON.stringify(r))
      .digest("hex");
    return this.transaction(async (db) => {
      const d = await this.device(db, ownerId, r.deviceId);
      const existing = (
        await db.query("SELECT * FROM remote_commands WHERE id=$1", [r.id])
      ).rows[0];
      if (existing) {
        if (existing.device_id !== r.deviceId)
          throw new RemoteStatusError("DENIED");
        if (existing.request_hash !== requestHash)
          throw new RemoteStatusError("CONFLICT");
        return { command: envelope(existing), duplicate: true };
      }
      const now = this.now();
      try {
        parseRemoteControl(r, now);
      } catch {
        throw new RemoteStatusError("INVALID_INPUT");
      }
      const status = (
        await db.query(
          "SELECT status,revision FROM remote_status WHERE device_id=$1 AND id=$2 AND expires_at>$3",
          [r.deviceId, r.taskId, now],
        )
      ).rows[0];
      if (
        !status ||
        Number(status.revision) !== r.expectedRevision ||
        ["completed", "failed", "cancelled", "expired"].includes(
          status.status,
        ) ||
        (r.command === "pause" && status.status === "paused")
      )
        throw new RemoteStatusError("CONFLICT");
      const count = (
        await db.query(
          "SELECT count(*) FROM remote_commands WHERE device_id=$1 AND device_epoch=$2 AND control_id=$4 AND outcome IS NULL AND expires_at>$3",
          [r.deviceId, d.epoch, now, d.control_id],
        )
      ).rows[0].count;
      if (Number(count) >= 100) throw new RemoteStatusError("CONFLICT");
      const expiry = Math.min(
        Date.parse(r.expiresAt),
        now + 300000,
        Number(d.expires_at),
      );
      const row = (
        await db.query(
          "INSERT INTO remote_commands(id,device_id,device_epoch,task_id,command,expected_revision,issued_at,expires_at,purge_at,request_hash,control_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
          [
            r.id,
            r.deviceId,
            d.epoch,
            r.taskId,
            r.command,
            r.expectedRevision,
            now,
            expiry,
            now + this.retentionMs,
            requestHash,
            d.control_id,
          ],
        )
      ).rows[0];
      if (Number(d.expires_at) <= this.now())
        throw new RemoteStatusError("DENIED");
      return { command: envelope(row), duplicate: false };
    });
  }
  async poll(rawIdentity: unknown) {
    const parsed = identity.safeParse(rawIdentity);
    if (!parsed.success) throw new RemoteStatusError("INVALID_INPUT");
    const who = parsed.data;
    return this.transaction(async (db) => {
      const d = await this.device(
        db,
        who.ownerId,
        who.deviceId,
        who.epoch,
        who.controlId,
      );
      const rows = (
        await db.query(
          "SELECT * FROM remote_commands WHERE device_id=$1 AND device_epoch=$2 AND control_id=$4 AND outcome IS NULL AND expires_at>$3 ORDER BY issued_at,id LIMIT 20",
          [who.deviceId, who.epoch, this.now(), who.controlId],
        )
      ).rows;
      if (Number(d.expires_at) <= this.now())
        throw new RemoteStatusError("DENIED");
      return rows
        .filter((r) => Number(r.expires_at) > this.now())
        .map(envelope);
    });
  }
  async acknowledge(rawIdentity: unknown, rawReceipt: unknown) {
    const auth = identity.safeParse(rawIdentity),
      receipt = remoteReceiptSchema.safeParse(rawReceipt);
    if (!auth.success || !receipt.success)
      throw new RemoteStatusError("INVALID_INPUT");
    const who = auth.data,
      r = receipt.data;
    if (r.deviceId !== who.deviceId) throw new RemoteStatusError("DENIED");
    return this.transaction(async (db) => {
      const d = await this.device(
        db,
        who.ownerId,
        who.deviceId,
        who.epoch,
        who.controlId,
      );
      const row = (
        await db.query(
          "SELECT * FROM remote_commands WHERE id=$1 AND device_id=$2 AND device_epoch=$3 AND control_id=$4 FOR UPDATE",
          [r.id, who.deviceId, who.epoch, who.controlId],
        )
      ).rows[0];
      if (!row) throw new RemoteStatusError("DENIED");
      const completed = Date.parse(r.completedAt),
        now = this.now();
      if (row.outcome !== null) {
        if (row.outcome !== r.outcome || Number(row.completed_at) !== completed)
          throw new RemoteStatusError("CONFLICT");
        return { duplicate: true };
      }
      if (
        completed < Number(row.issued_at) ||
        completed > now + 30000 ||
        (r.outcome === "applied" && completed >= Number(row.expires_at))
      )
        throw new RemoteStatusError("INVALID_INPUT");
      await db.query(
        "UPDATE remote_commands SET outcome=$2,completed_at=$3 WHERE id=$1",
        [r.id, r.outcome, completed],
      );
      if (Number(d.expires_at) <= this.now())
        throw new RemoteStatusError("DENIED");
      return { duplicate: false };
    });
  }
  async inspect(ownerId: string, id: string) {
    if (!z.uuid().safeParse(ownerId).success || !z.uuid().safeParse(id).success)
      throw new RemoteStatusError("INVALID_INPUT");
    return this.transaction(async (db) => {
      const r = (
        await db.query(
          "SELECT c.*,d.epoch AS current_epoch,d.revoked_at,d.expires_at AS device_expiry,d.controls_enabled,d.control_id AS current_control_id FROM remote_commands c JOIN remote_devices d ON d.id=c.device_id WHERE c.id=$1 AND d.owner_id=$2 AND c.purge_at>$3",
          [id, ownerId, this.now()],
        )
      ).rows[0];
      if (!r) throw new RemoteStatusError("DENIED");
      const state =
        r.outcome !== null
          ? "acknowledged"
          : r.revoked_at !== null ||
              !r.controls_enabled ||
              r.device_epoch !== r.current_epoch ||
              r.control_id !== r.current_control_id
            ? "cancelled"
            : Math.min(Number(r.expires_at), Number(r.device_expiry)) <=
                this.now()
              ? "expired"
              : "pending";
      return {
        command: envelope(r),
        state,
        receipt:
          r.outcome === null
            ? null
            : remoteReceiptSchema.parse({
                id: r.id,
                deviceId: r.device_id,
                outcome: r.outcome,
                completedAt: new Date(Number(r.completed_at)).toISOString(),
              }),
      };
    });
  }
  async purgeExpired() {
    return this.transaction(
      async (db) =>
        (
          await db.query("DELETE FROM remote_commands WHERE purge_at<=$1", [
            this.now(),
          ])
        ).rowCount ?? 0,
    );
  }
}
