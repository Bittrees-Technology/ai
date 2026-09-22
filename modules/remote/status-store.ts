import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import { statusBatchSchema } from "./status.js";
import { remoteStatusSchema } from "../contracts/index.js";
const identity = z.strictObject({
  ownerId: z.uuid(),
  deviceId: z.uuid(),
  epoch: z.number().int().positive(),
});
export class RemoteStatusError extends Error {
  constructor(
    public code: "DENIED" | "CONFLICT" | "INVALID_INPUT" | "UNAVAILABLE",
  ) {
    super(code);
  }
}
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
/** Internal repository only: caller identity must come from verified relay authentication. */
export class RemoteStatusStore {
  constructor(
    private pool: Pool,
    private retentionMs: number,
    private now = Date.now,
  ) {
    if (![86400000, 7 * 86400000, 30 * 86400000].includes(retentionMs))
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
      throw new RemoteStatusError("UNAVAILABLE");
    } finally {
      db?.release();
    }
  }
  async publish(rawIdentity: unknown, rawBatch: unknown) {
    const who = identity.safeParse(rawIdentity),
      batch = statusBatchSchema.safeParse(rawBatch);
    if (!who.success || !batch.success)
      throw new RemoteStatusError("INVALID_INPUT");
    const auth = who.data,
      b = batch.data;
    if (b.items.some((i) => i.deviceId !== auth.deviceId))
      throw new RemoteStatusError("DENIED");
    const hash = digest(b);
    return this.transaction(async (db) => {
      const device = (
        await db.query(
          "SELECT * FROM remote_devices WHERE id=$1 AND owner_id=$2 FOR UPDATE",
          [auth.deviceId, auth.ownerId],
        )
      ).rows[0];
      const now = this.now();
      if (
        !device ||
        device.revoked_at !== null ||
        Number(device.expires_at) <= now ||
        device.epoch !== auth.epoch
      )
        throw new RemoteStatusError("DENIED");
      if (
        b.sequence === Number(device.last_sequence) &&
        hash === device.last_batch_hash
      )
        return { sequence: b.sequence, duplicate: true };
      if (b.sequence !== Number(device.last_sequence) + 1)
        throw new RemoteStatusError("CONFLICT");
      for (const item of b.items) {
        const updated = Date.parse(item.updatedAt),
          itemHash = digest(item);
        if (updated > now + 30000) throw new RemoteStatusError("INVALID_INPUT");
        const existing = (
          await db.query(
            "SELECT revision,projection_hash FROM remote_status WHERE device_id=$1 AND id=$2",
            [auth.deviceId, item.id],
          )
        ).rows[0];
        if (
          existing &&
          (Number(existing.revision) > item.revision ||
            (Number(existing.revision) === item.revision &&
              existing.projection_hash !== itemHash))
        )
          throw new RemoteStatusError("CONFLICT");
        // Repeated unchanged observations do not extend retention.
        if (existing && Number(existing.revision) === item.revision) continue;
        await db.query(
          "INSERT INTO remote_status(device_id,id,status,revision,updated_at,error_code,projection_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(device_id,id) DO UPDATE SET status=excluded.status,revision=excluded.revision,updated_at=excluded.updated_at,error_code=excluded.error_code,projection_hash=excluded.projection_hash,expires_at=excluded.expires_at",
          [
            auth.deviceId,
            item.id,
            item.status,
            item.revision,
            updated,
            item.errorCode ?? null,
            itemHash,
            now + this.retentionMs,
          ],
        );
      }
      if (Number(device.expires_at) <= this.now())
        throw new RemoteStatusError("DENIED");
      await db.query(
        "UPDATE remote_devices SET last_sequence=$2,last_batch_hash=$3 WHERE id=$1",
        [auth.deviceId, b.sequence, hash],
      );
      return { sequence: b.sequence, duplicate: false };
    });
  }
  /** Compatibility helper: first page only. Use listPage to traverse a device queue. */
  async list(ownerId: string, deviceId: string) {
    return (await this.listPage(ownerId, deviceId)).items;
  }
  /** Cursor is a position, never authority. Reauthorize every page. Live view, not a snapshot. */
  async listPage(ownerId: string, deviceId: string, rawOptions: unknown = {}) {
    const options = z
      .strictObject({
        after: z.uuid().optional(),
        limit: z.number().int().min(1).max(100).default(100),
      })
      .safeParse(rawOptions);
    if (!options.success) throw new RemoteStatusError("INVALID_INPUT");
    if (
      !z.uuid().safeParse(ownerId).success ||
      !z.uuid().safeParse(deviceId).success
    )
      throw new RemoteStatusError("INVALID_INPUT");
    return this.transaction(async (db) => {
      const device = (
        await db.query(
          "SELECT revoked_at,expires_at FROM remote_devices WHERE id=$1 AND owner_id=$2 FOR SHARE",
          [deviceId, ownerId],
        )
      ).rows[0];
      const now = this.now();
      if (
        !device ||
        device.revoked_at !== null ||
        Number(device.expires_at) <= now
      )
        throw new RemoteStatusError("DENIED");
      const rows = (
        await db.query(
          "SELECT id,status,revision,updated_at,error_code FROM remote_status WHERE device_id=$1 AND expires_at>$2 AND ($3::uuid IS NULL OR id>$3::uuid) ORDER BY id LIMIT $4",
          [deviceId, now, options.data.after ?? null, options.data.limit + 1],
        )
      ).rows;
      if (Number(device.expires_at) <= this.now())
        throw new RemoteStatusError("DENIED");
      const hasMore = rows.length > options.data.limit;
      const items = rows.slice(0, options.data.limit).map((r) =>
        remoteStatusSchema.parse({
          id: r.id,
          deviceId,
          status: r.status,
          revision: Number(r.revision),
          updatedAt: new Date(Number(r.updated_at)).toISOString(),
          ...(r.error_code ? { errorCode: r.error_code } : {}),
        }),
      );
      return { items, nextCursor: hasMore ? items.at(-1)!.id : null };
    });
  }
  async revoke(ownerId: string, deviceId: string) {
    if (
      !z.uuid().safeParse(ownerId).success ||
      !z.uuid().safeParse(deviceId).success
    )
      throw new RemoteStatusError("INVALID_INPUT");
    return this.transaction(async (db) => {
      const row = await db.query(
        "UPDATE remote_devices SET revoked_at=coalesce(revoked_at,$3) WHERE id=$1 AND owner_id=$2 RETURNING id",
        [deviceId, ownerId, this.now()],
      );
      if (!row.rowCount) throw new RemoteStatusError("DENIED");
      await db.query("DELETE FROM remote_status WHERE device_id=$1", [
        deviceId,
      ]);
    });
  }
  async purgeExpired() {
    return this.transaction(async (db) => {
      const r = await db.query(
        "DELETE FROM remote_status WHERE expires_at<=$1",
        [this.now()],
      );
      return r.rowCount ?? 0;
    });
  }
}
