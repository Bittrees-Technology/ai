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
  /** Replace the bearer secret without extending the approved lease or scope.
   * Lost responses require fresh pairing; an old secret is never accepted again.
   */
  async rotate(credential: string) {
    if (!opaque.safeParse(credential).success)
      throw new RemoteStatusError("DENIED");
    return this.transaction(async (db) => {
      const row = (
        await db.query(
          "SELECT id,owner_id,epoch,expires_at,revoked_at FROM remote_devices WHERE credential_hash=$1 FOR UPDATE",
          [hash(credential)],
        )
      ).rows[0];
      if (
        !row ||
        row.revoked_at !== null ||
        Number(row.expires_at) <= this.now() ||
        row.epoch >= 2147483647
      )
        throw new RemoteStatusError("DENIED");
      const replacement = secret(),
        epoch = row.epoch + 1;
      await db.query(
        "UPDATE remote_devices SET credential_hash=$2,epoch=$3,controls_enabled=false,control_id=NULL,control_credential_hash=NULL,controls_approved_epoch=NULL,controls_approval_expires_at=NULL WHERE id=$1",
        [row.id, hash(replacement), epoch],
      );
      if (Number(row.expires_at) <= this.now())
        throw new RemoteStatusError("DENIED");
      return {
        deviceId: row.id as string,
        ownerId: row.owner_id as string,
        epoch,
        credential: replacement,
        expiresAt: Number(row.expires_at),
        scope: "status:publish" as const,
      };
    });
  }
  /** Browser owner approval is short-lived and still requires a separate native opt-in. */
  async approveControls(
    ownerId: string,
    deviceId: string,
    expectedEpoch: number,
  ) {
    if (
      !validId(ownerId) ||
      !validId(deviceId) ||
      !Number.isSafeInteger(expectedEpoch) ||
      expectedEpoch < 1
    )
      throw new RemoteStatusError("INVALID_INPUT");
    return this.transaction(async (db) => {
      const row = (
        await db.query(
          "SELECT * FROM remote_devices WHERE id=$1 AND owner_id=$2 FOR UPDATE",
          [deviceId, ownerId],
        )
      ).rows[0];
      if (
        !row ||
        row.revoked_at !== null ||
        Number(row.expires_at) <= this.now() ||
        row.epoch !== expectedEpoch ||
        row.controls_enabled
      )
        throw new RemoteStatusError("DENIED");
      const expiresAt = Math.min(Number(row.expires_at), this.now() + 300000);
      await db.query(
        "UPDATE remote_devices SET controls_approved_epoch=$2,controls_approval_expires_at=$3 WHERE id=$1",
        [deviceId, expectedEpoch, expiresAt],
      );
      if (expiresAt <= this.now()) throw new RemoteStatusError("DENIED");
      return { approved: true, expiresAt };
    });
  }
  /** Status credential can redeem reviewed consent once, never poll or acknowledge controls. */
  async enableControls(credential: string) {
    if (!opaque.safeParse(credential).success)
      throw new RemoteStatusError("DENIED");
    return this.transaction(async (db) => {
      const row = (
        await db.query(
          "SELECT * FROM remote_devices WHERE credential_hash=$1 FOR UPDATE",
          [hash(credential)],
        )
      ).rows[0];
      if (
        !row ||
        row.revoked_at !== null ||
        Number(row.expires_at) <= this.now() ||
        row.controls_enabled ||
        row.controls_approved_epoch !== row.epoch ||
        Number(row.controls_approval_expires_at) <= this.now()
      )
        throw new RemoteStatusError("DENIED");
      const controlId = randomUUID(),
        replacement = secret();
      await db.query(
        "UPDATE remote_devices SET controls_enabled=true,control_id=$2,control_credential_hash=$3,controls_approved_epoch=NULL,controls_approval_expires_at=NULL WHERE id=$1",
        [row.id, controlId, hash(replacement)],
      );
      if (
        Math.min(
          Number(row.expires_at),
          Number(row.controls_approval_expires_at),
        ) <= this.now()
      )
        throw new RemoteStatusError("DENIED");
      return {
        deviceId: row.id as string,
        ownerId: row.owner_id as string,
        epoch: row.epoch as number,
        controlId,
        credential: replacement,
        expiresAt: Number(row.expires_at),
        scope: "controls:pause-cancel" as const,
      };
    });
  }
  async authenticateControls(credential: string) {
    if (!opaque.safeParse(credential).success)
      throw new RemoteStatusError("DENIED");
    return this.transaction(async (db) => {
      const row = (
        await db.query(
          "SELECT * FROM remote_devices WHERE control_credential_hash=$1 FOR SHARE",
          [hash(credential)],
        )
      ).rows[0];
      if (
        !row ||
        !row.controls_enabled ||
        !row.control_id ||
        row.revoked_at !== null ||
        Number(row.expires_at) <= this.now()
      )
        throw new RemoteStatusError("DENIED");
      return {
        ownerId: row.owner_id as string,
        deviceId: row.id as string,
        epoch: row.epoch as number,
        controlId: row.control_id as string,
      };
    });
  }
  async disableControls(ownerId: string, deviceId: string) {
    if (!validId(ownerId) || !validId(deviceId))
      throw new RemoteStatusError("INVALID_INPUT");
    return this.transaction(async (db) => {
      const result = await db.query(
        "UPDATE remote_devices SET controls_enabled=false,control_id=NULL,control_credential_hash=NULL,controls_approved_epoch=NULL,controls_approval_expires_at=NULL WHERE id=$1 AND owner_id=$2",
        [deviceId, ownerId],
      );
      if (!result.rowCount) throw new RemoteStatusError("DENIED");
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
