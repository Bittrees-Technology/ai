import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import { RemoteStatusError } from "./status-store.js";
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const verifierSchema = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const challengeFor = (v: string) =>
  createHash("sha256").update(v).digest("base64url");
const validId = (v: unknown) => z.uuid().safeParse(v).success;

/** Internal only. Approval owner must come from verified authentication and explicit consent.
 * No HTTP listener, session verification or source-app authority is supplied by this class.
 */
export class RemoteDeviceStore {
  constructor(
    private pool: Pool,
    private leaseMs: number,
    private now = Date.now,
  ) {
    if (
      !Number.isSafeInteger(leaseMs) ||
      leaseMs < 60000 ||
      leaseMs > 30 * 86400000
    )
      throw new RemoteStatusError("INVALID_INPUT");
  }
  private async transaction<T>(fn: (db: PoolClient) => Promise<T>) {
    let db: PoolClient | undefined;
    try {
      db = await this.pool.connect();
      await db.query("BEGIN");
      await db.query("SET LOCAL statement_timeout = '5s'");
      const result = await fn(db);
      await db.query("COMMIT");
      return result;
    } catch (e) {
      if (db) await db.query("ROLLBACK").catch(() => {});
      if (e instanceof RemoteStatusError) throw e;
      throw new RemoteStatusError("UNAVAILABLE");
    } finally {
      db?.release();
    }
  }
  async begin(challenge: string) {
    if (!opaque.safeParse(challenge).success)
      throw new RemoteStatusError("INVALID_INPUT");
    const id = randomUUID(),
      approvalCode = secret(),
      expiresAt = this.now() + 300000;
    await this.transaction((db) =>
      db.query(
        "INSERT INTO remote_pairings(id,approval_hash,challenge,expires_at) VALUES($1,$2,$3,$4)",
        [id, hash(approvalCode), challenge, expiresAt],
      ),
    );
    return { id, approvalCode, expiresAt };
  }
  async approve(ownerId: string, pairingId: string, approvalCode: string) {
    if (
      !validId(ownerId) ||
      !validId(pairingId) ||
      !opaque.safeParse(approvalCode).success
    )
      throw new RemoteStatusError("INVALID_INPUT");
    return this.transaction(async (db) => {
      const row = (
        await db.query("SELECT * FROM remote_pairings WHERE id=$1 FOR UPDATE", [
          pairingId,
        ])
      ).rows[0];
      if (
        !row ||
        row.owner_id !== null ||
        row.approval_hash !== hash(approvalCode) ||
        Number(row.expires_at) <= this.now()
      )
        throw new RemoteStatusError("DENIED");
      await db.query("UPDATE remote_pairings SET owner_id=$2 WHERE id=$1", [
        pairingId,
        ownerId,
      ]);
      if (Number(row.expires_at) <= this.now())
        throw new RemoteStatusError("DENIED");
    });
  }
  /** Expected owner must be confirmed locally; do not silently accept a remote account binding. */
  async redeem(pairingId: string, verifier: string, expectedOwnerId: string) {
    if (
      !validId(pairingId) ||
      !validId(expectedOwnerId) ||
      !verifierSchema.safeParse(verifier).success
    )
      throw new RemoteStatusError("INVALID_INPUT");
    return this.transaction(async (db) => {
      const row = (
        await db.query("SELECT * FROM remote_pairings WHERE id=$1 FOR UPDATE", [
          pairingId,
        ])
      ).rows[0];
      const now = this.now();
      if (
        !row ||
        row.owner_id !== expectedOwnerId ||
        row.challenge !== challengeFor(verifier) ||
        Number(row.expires_at) <= now
      )
        throw new RemoteStatusError("DENIED");
      const deviceId = randomUUID(),
        credential = secret(),
        expiresAt = now + this.leaseMs;
      await db.query(
        "INSERT INTO remote_devices(id,owner_id,epoch,expires_at,credential_hash) VALUES($1,$2,1,$3,$4)",
        [deviceId, expectedOwnerId, expiresAt, hash(credential)],
      );
      await db.query("DELETE FROM remote_pairings WHERE id=$1", [pairingId]);
      if (Number(row.expires_at) <= this.now())
        throw new RemoteStatusError("DENIED");
      return {
        deviceId,
        ownerId: expectedOwnerId,
        epoch: 1,
        credential,
        expiresAt,
        scope: "status:publish" as const,
      };
    });
  }
  /** Only status publication is granted. Never interpret this as an owner browser session. */
  async authenticate(credential: string) {
    if (!opaque.safeParse(credential).success)
      throw new RemoteStatusError("DENIED");
    return this.transaction(async (db) => {
      const row = (
        await db.query(
          "SELECT id,owner_id,epoch,expires_at,revoked_at FROM remote_devices WHERE credential_hash=$1 FOR SHARE",
          [hash(credential)],
        )
      ).rows[0];
      if (
        !row ||
        row.revoked_at !== null ||
        Number(row.expires_at) <= this.now()
      )
        throw new RemoteStatusError("DENIED");
      return {
        ownerId: row.owner_id as string,
        deviceId: row.id as string,
        epoch: row.epoch as number,
      };
    });
  }
  async cancel(ownerId: string, pairingId: string) {
    if (!validId(ownerId) || !validId(pairingId))
      throw new RemoteStatusError("INVALID_INPUT");
    return this.transaction(async (db) => {
      const result = await db.query(
        "DELETE FROM remote_pairings WHERE id=$1 AND owner_id=$2",
        [pairingId, ownerId],
      );
      if (!result.rowCount) throw new RemoteStatusError("DENIED");
    });
  }
  async purgeExpired() {
    return this.transaction(
      async (db) =>
        (
          await db.query("DELETE FROM remote_pairings WHERE expires_at<=$1", [
            this.now(),
          ])
        ).rowCount ?? 0,
    );
  }
}
