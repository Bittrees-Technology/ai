import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { RemoteStatusError } from "./status-store.js";
import {
  browserRegistrationSchema,
  browserDeviceInspectionSchema,
  browserDeviceIdentitySchema,
  browserDeviceRegisterSchema,
  browserDeviceRevokeSchema,
  browserDevicePageSchema,
} from "./browser-device-contracts.js";
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const credentialHash = (s: string) => hash("bittrees-browser-device-v1:" + s);
type Session = { ownerId: string; sessionExpiresAt: number };
/** Session and browser registration are checked under the same transaction locks.
 * None of these operations grants status publishing, task or source authority. */
export class RemoteBrowserDeviceStore {
  constructor(
    private pool: Pool,
    private origin: string,
    private chainId: number,
    private leaseMs: number,
    private now = Date.now,
    private limit = 100,
  ) {
    const u = new URL(origin);
    if (
      u.protocol !== "https:" ||
      u.origin !== origin ||
      !Number.isSafeInteger(chainId) ||
      chainId < 1 ||
      !Number.isSafeInteger(leaseMs) ||
      leaseMs < 60000 ||
      leaseMs > 30 * 86400000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100000
    )
      throw new RemoteStatusError("INVALID_INPUT");
  }
  private parse<T>(schema: z.ZodType<T>, raw: unknown): T {
    const v = schema.safeParse(raw);
    if (!v.success) throw new RemoteStatusError("INVALID_INPUT");
    return v.data;
  }
  private async transaction<T>(
    sessionToken: string,
    expectedOwner: string,
    fn: (
      db: PoolClient,
      auth: Session,
      validUntil: (time: number) => void,
    ) => Promise<T>,
  ) {
    if (
      !token.safeParse(sessionToken).success ||
      !z.uuid().safeParse(expectedOwner).success
    )
      throw new RemoteStatusError("DENIED");
    let db: PoolClient | undefined;
    try {
      db = await this.pool.connect();
      await db.query("BEGIN");
      await db.query("SET LOCAL statement_timeout = '5s'");
      const row = (
        await db.query(
          "SELECT owner_id,expires_at FROM remote_sessions WHERE token_hash=$1 AND origin=$2 AND chain_id=$3 FOR SHARE",
          [hash(sessionToken), this.origin, this.chainId],
        )
      ).rows[0];
      const start = this.now();
      if (
        !Number.isSafeInteger(start) ||
        start <= 0 ||
        !row ||
        row.owner_id !== expectedOwner ||
        Number(row.expires_at) <= start
      )
        throw new RemoteStatusError("DENIED");
      const auth = {
        ownerId: row.owner_id as string,
        sessionExpiresAt: Number(row.expires_at),
      };
      let deadline = auth.sessionExpiresAt;
      const result = await fn(db, auth, (time) => {
        deadline = Math.min(deadline, time);
      });
      const end = this.now();
      if (!Number.isSafeInteger(end) || end < start || deadline <= end)
        throw new RemoteStatusError("DENIED");
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
  private registration(row: any) {
    return browserRegistrationSchema.parse({
      binding: {
        ownerId: row.owner_id,
        deviceId: row.id,
        credentialEpoch: Number(row.credential_epoch),
        expiresAt: Number(row.expires_at),
      },
      createdAt: Number(row.created_at),
      revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    });
  }
  private async current(
    db: PoolClient,
    ownerId: string,
    credential: string | null,
    update = false,
  ) {
    if (credential === null) return null;
    if (!token.safeParse(credential).success)
      throw new RemoteStatusError("DENIED");
    return (
      (
        await db.query(
          "SELECT * FROM remote_browser_devices WHERE owner_id=$1 AND credential_hash=$2 FOR " +
            (update ? "UPDATE" : "SHARE"),
          [ownerId, credentialHash(credential)],
        )
      ).rows[0] ?? null
    );
  }
  inspect(session: string, owner: string, credential: string | null) {
    return this.transaction(session, owner, async (db, auth) => {
      const row = await this.current(db, owner, credential);
      return browserDeviceInspectionSchema.parse({
        version: 1,
        ...auth,
        registration: row ? this.registration(row) : null,
      });
    });
  }
  identify(session: string, owner: string, credential: string | null) {
    return this.transaction(session, owner, async (db, auth, validUntil) => {
      const row = await this.current(db, owner, credential);
      if (
        !row ||
        row.revoked_at !== null ||
        Number(row.expires_at) <= this.now()
      )
        throw new RemoteStatusError("DENIED");
      validUntil(Number(row.expires_at));
      return browserDeviceIdentitySchema.parse({
        version: 1,
        binding: this.registration(row).binding,
        sessionExpiresAt: auth.sessionExpiresAt,
      });
    });
  }
  async register(
    session: string,
    owner: string,
    credential: string | null,
    raw: unknown,
  ) {
    const input = this.parse(browserDeviceRegisterSchema, raw);
    return this.transaction(session, owner, async (db, auth, validUntil) => {
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('bittrees-ai:browser-devices:' || $1,0))",
        [owner],
      );
      const old = await this.current(db, owner, credential, true);
      if (
        (old === null) !== (input.expected === null) ||
        (old &&
          (old.id !== input.expected?.deviceId ||
            Number(old.credential_epoch) !== input.expected?.credentialEpoch))
      )
        throw new RemoteStatusError("CONFLICT");
      if (
        (
          await db.query(
            "SELECT 1 FROM remote_browser_devices WHERE owner_id=$1 AND operation_id=$2",
            [owner, input.operationId],
          )
        ).rowCount
      )
        throw new RemoteStatusError("CONFLICT");
      const count = Number(
        (
          await db.query(
            "SELECT count(*) FROM remote_browser_devices WHERE owner_id=$1",
            [owner],
          )
        ).rows[0].count,
      );
      if (count >= this.limit) throw new RemoteStatusError("CAPACITY");
      const issuedCredential = randomBytes(32).toString("base64url"),
        id = randomUUID(),
        now = this.now(),
        expiresAt = now + this.leaseMs;
      if (old && old.revoked_at === null) {
        if (Number(old.credential_epoch) >= Number.MAX_SAFE_INTEGER)
          throw new RemoteStatusError("CAPACITY");
        await db.query(
          "UPDATE remote_browser_devices SET credential_epoch=credential_epoch+1,revoked_at=$2 WHERE id=$1",
          [old.id, now],
        );
      }
      await db.query(
        "INSERT INTO remote_browser_devices(id,owner_id,operation_id,credential_hash,credential_epoch,created_at,expires_at) VALUES($1,$2,$3,$4,1,$5,$6)",
        [
          id,
          owner,
          input.operationId,
          credentialHash(issuedCredential),
          now,
          expiresAt,
        ],
      );
      validUntil(expiresAt);
      return {
        credential: issuedCredential,
        identity: browserDeviceIdentitySchema.parse({
          version: 1,
          binding: {
            ownerId: owner,
            deviceId: id,
            credentialEpoch: 1,
            expiresAt,
          },
          sessionExpiresAt: auth.sessionExpiresAt,
        }),
      };
    });
  }
  async revoke(session: string, owner: string, raw: unknown) {
    const input = this.parse(browserDeviceRevokeSchema, raw);
    return this.transaction(session, owner, async (db) => {
      const row = (
        await db.query(
          "SELECT * FROM remote_browser_devices WHERE id=$1 AND owner_id=$2 FOR UPDATE",
          [input.deviceId, owner],
        )
      ).rows[0];
      if (!row || Number(row.credential_epoch) !== input.credentialEpoch)
        throw new RemoteStatusError("DENIED");
      if (row.revoked_at === null) {
        if (input.credentialEpoch >= Number.MAX_SAFE_INTEGER)
          throw new RemoteStatusError("CAPACITY");
        await db.query(
          "UPDATE remote_browser_devices SET credential_epoch=credential_epoch+1,revoked_at=$2 WHERE id=$1",
          [input.deviceId, this.now()],
        );
      }
      return { revoked: true as const, deviceId: input.deviceId };
    });
  }
  async list(session: string, owner: string, raw: unknown) {
    const input = this.parse(
      z.strictObject({ after: z.uuid().optional() }),
      raw,
    );
    return this.transaction(session, owner, async (db) => {
      if (
        input.after &&
        !(
          await db.query(
            "SELECT 1 FROM remote_browser_devices WHERE owner_id=$1 AND id=$2",
            [owner, input.after],
          )
        ).rowCount
      )
        throw new RemoteStatusError("DENIED");
      const rows = (
        await db.query(
          "SELECT * FROM remote_browser_devices WHERE owner_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 51",
          [owner, input.after ?? null],
        )
      ).rows;
      return browserDevicePageSchema.parse({
        version: 1,
        ownerId: owner,
        items: rows.slice(0, 50).map((r) => this.registration(r)),
        nextCursor: rows.length > 50 ? rows[49].id : null,
      });
    });
  }
}
