import { privateRelayGrantSchema as grantSchema } from "./private-relay-enrollment.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  privateRelayIdentitySchema,
  type PrivateRelayIdentity,
} from "./private-relay-contracts.js";
import { RemoteStatusError } from "./status-store.js";
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const uuid = z.uuid();
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const relayHash = (s: string) => hash("bittrees-private-relay-v1:" + s);
const request = z.strictObject({
  operationId: uuid,
  expected: z.strictObject({ id: uuid, revision: positive }).nullable(),
  expiresAt: positive,
  confirmed: z.literal(true),
});
const endpointApproval = request.extend({
  deviceId: uuid,
  credentialEpoch: positive,
});
const revisionRequest = z.strictObject({
  id: uuid,
  expectedRevision: positive,
  confirmed: z.literal(true),
});
type Grant = z.infer<typeof grantSchema>;
type Kind = "browser" | "mac";
type Endpoint = {
  ownerId: string;
  endpointId: string;
  endpointKind: Kind;
  credentialEpoch: number;
  expiresAt: number;
};
type Gate = { validUntil: (deadline: number) => void; check: () => void };
/** Only constructed during a current locked server operation. It must never be
 * sent to clients or used after its callback, and confers no endpoint task scope. */
export interface PrivateRelayTransaction {
  db: PoolClient;
  identity: PrivateRelayIdentity;
  recipient: (endpointId: string) => Promise<PrivateRelayIdentity>;
  validUntil: (deadline: number) => void;
  check: () => void;
}
/** Inactive server permission foundation. No routes, listener, delivery or key
 * access. Native relay secrets are separate from status/control credentials. */
export class RemotePrivateRelayAccess {
  constructor(
    private pool: Pool,
    private origin: string,
    private chainId: number,
    private now = Date.now,
    private maxGrantsPerOwner = 1000,
  ) {
    const u = new URL(origin);
    if (
      u.protocol !== "https:" ||
      u.origin !== origin ||
      !Number.isSafeInteger(chainId) ||
      chainId < 1 ||
      !Number.isSafeInteger(maxGrantsPerOwner) ||
      maxGrantsPerOwner < 1 ||
      maxGrantsPerOwner > 100000
    )
      throw new RemoteStatusError("INVALID_INPUT");
  }
  private parse<T>(schema: z.ZodType<T>, raw: unknown): T {
    const p = schema.safeParse(raw);
    if (!p.success) throw new RemoteStatusError("INVALID_INPUT");
    return p.data;
  }
  private async tx<T>(
    fn: (db: PoolClient, gate: Gate) => Promise<T>,
  ): Promise<T> {
    let db: PoolClient | undefined,
      active = true;
    const start = this.now();
    let deadline = Number.MAX_SAFE_INTEGER;
    const check = () => {
      const end = this.now();
      if (
        !active ||
        !Number.isSafeInteger(start) ||
        start <= 0 ||
        !Number.isSafeInteger(end) ||
        end < start ||
        end >= deadline
      )
        throw new RemoteStatusError("DENIED");
    };
    const gate = {
      check,
      validUntil: (t: number) => {
        if (!Number.isSafeInteger(t) || t <= 0)
          throw new RemoteStatusError("DENIED");
        deadline = Math.min(deadline, t);
        check();
      },
    };
    try {
      check();
      db = await this.pool.connect();
      await db.query("BEGIN");
      await db.query("SET LOCAL statement_timeout = '5s'");
      await db.query("SET LOCAL lock_timeout = '2s'");
      const result = await fn(db, gate);
      check();
      await db.query("COMMIT");
      return result;
    } catch (e) {
      if (db) await db.query("ROLLBACK").catch(() => {});
      if (e instanceof RemoteStatusError) throw e;
      if (typeof e === "object" && e && "code" in e && e.code === "23505")
        throw new RemoteStatusError("CONFLICT");
      throw new RemoteStatusError("UNAVAILABLE");
    } finally {
      active = false;
      db?.release();
    }
  }
  private async ownerLock(db: PoolClient, owner: string) {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('bittrees-ai:private-relay:' || $1,0))",
      [owner],
    );
  }
  private async session(
    db: PoolClient,
    gate: Gate,
    session: string,
    owner: string,
  ) {
    if (!token.safeParse(session).success || !uuid.safeParse(owner).success)
      throw new RemoteStatusError("DENIED");
    const row = (
      await db.query(
        "SELECT owner_id,expires_at FROM remote_sessions WHERE token_hash=$1 AND origin=$2 AND chain_id=$3 FOR SHARE",
        [hash(session), this.origin, this.chainId],
      )
    ).rows[0];
    if (!row || row.owner_id !== owner) throw new RemoteStatusError("DENIED");
    gate.validUntil(Number(row.expires_at));
    await this.ownerLock(db, owner);
    gate.check();
  }
  private async endpoint(
    db: PoolClient,
    gate: Gate,
    kind: Kind,
    owner: string,
    id: string,
    epoch?: number,
  ): Promise<Endpoint> {
    const row = (
      await db.query(
        kind === "browser"
          ? "SELECT owner_id,id,credential_epoch AS epoch,expires_at,revoked_at FROM remote_browser_devices WHERE owner_id=$1 AND id=$2 FOR SHARE"
          : "SELECT owner_id,id,epoch,expires_at,revoked_at FROM remote_devices WHERE owner_id=$1 AND id=$2 FOR SHARE",
        [owner, id],
      )
    ).rows[0];
    if (
      !row ||
      row.revoked_at !== null ||
      (epoch !== undefined && Number(row.epoch) !== epoch)
    )
      throw new RemoteStatusError("DENIED");
    gate.validUntil(Number(row.expires_at));
    return {
      ownerId: owner,
      endpointId: id,
      endpointKind: kind,
      credentialEpoch: Number(row.epoch),
      expiresAt: Number(row.expires_at),
    };
  }
  private async browser(
    db: PoolClient,
    gate: Gate,
    session: string,
    owner: string,
    credential: string,
  ) {
    await this.session(db, gate, session, owner);
    if (!token.safeParse(credential).success)
      throw new RemoteStatusError("DENIED");
    const row = (
      await db.query(
        "SELECT id FROM remote_browser_devices WHERE owner_id=$1 AND credential_hash=$2",
        [owner, hash("bittrees-browser-device-v1:" + credential)],
      )
    ).rows[0];
    if (!row) throw new RemoteStatusError("DENIED");
    return this.endpoint(db, gate, "browser", owner, row.id);
  }
  private grant(row: any): Grant {
    return grantSchema.parse({
      id: row.id,
      ownerId: row.owner_id,
      endpointKind: row.endpoint_kind,
      endpointId: row.endpoint_id,
      credentialEpoch: Number(row.credential_epoch),
      operationId: row.operation_id,
      revision: Number(row.revision),
      state: row.state,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      approvalExpiresAt:
        row.approval_expires_at === null
          ? null
          : Number(row.approval_expires_at),
      revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    });
  }
  private async current(db: PoolClient, endpoint: Endpoint) {
    return (
      (
        await db.query(
          "SELECT * FROM remote_private_relay_grants WHERE owner_id=$1 AND endpoint_kind=$2 AND endpoint_id=$3 AND state<>'revoked' FOR UPDATE",
          [endpoint.ownerId, endpoint.endpointKind, endpoint.endpointId],
        )
      ).rows[0] ?? null
    );
  }
  private identity(
    grant: Grant,
    endpoint: Endpoint,
    gate: Gate,
  ): PrivateRelayIdentity {
    if (
      this.now() < grant.createdAt ||
      grant.state !== "active" ||
      grant.ownerId !== endpoint.ownerId ||
      grant.endpointId !== endpoint.endpointId ||
      grant.endpointKind !== endpoint.endpointKind ||
      grant.credentialEpoch !== endpoint.credentialEpoch
    )
      throw new RemoteStatusError("DENIED");
    gate.validUntil(grant.expiresAt);
    return privateRelayIdentitySchema.parse({
      version: 1,
      scope: "private:relay",
      ...endpoint,
      permissionId: grant.id,
      expiresAt: Math.min(endpoint.expiresAt, grant.expiresAt),
    });
  }
  private async create(
    db: PoolClient,
    gate: Gate,
    endpoint: Endpoint,
    input: z.infer<typeof request>,
  ) {
    const start = this.now(),
      old = await this.current(db, endpoint);
    if (
      (old === null) !== (input.expected === null) ||
      (old &&
        (old.id !== input.expected?.id ||
          Number(old.revision) !== input.expected?.revision))
    )
      throw new RemoteStatusError("CONFLICT");
    if (
      input.expiresAt <= start ||
      input.expiresAt > Math.min(endpoint.expiresAt, start + 30 * 86400000)
    )
      throw new RemoteStatusError("INVALID_INPUT");
    if (
      Number(
        (
          await db.query(
            "SELECT count(*) FROM remote_private_relay_grants WHERE owner_id=$1",
            [endpoint.ownerId],
          )
        ).rows[0].count,
      ) >= this.maxGrantsPerOwner
    )
      throw new RemoteStatusError("CAPACITY");
    if (old) {
      if (Number(old.revision) >= Number.MAX_SAFE_INTEGER)
        throw new RemoteStatusError("CAPACITY");
      await db.query(
        "UPDATE remote_private_relay_grants SET state='revoked',revoked_at=$2,approval_expires_at=NULL,credential_hash=NULL,revision=revision+1 WHERE id=$1",
        [old.id, start],
      );
    }
    const pending = endpoint.endpointKind === "mac";
    const row = (
      await db.query(
        "INSERT INTO remote_private_relay_grants(id,owner_id,endpoint_kind,endpoint_id,credential_epoch,operation_id,revision,state,created_at,expires_at,approval_expires_at) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10) RETURNING *",
        [
          randomUUID(),
          endpoint.ownerId,
          endpoint.endpointKind,
          endpoint.endpointId,
          endpoint.credentialEpoch,
          input.operationId,
          pending ? "pending" : "active",
          start,
          input.expiresAt,
          pending ? Math.min(start + 120000, input.expiresAt) : null,
        ],
      )
    ).rows[0];
    gate.validUntil(input.expiresAt);
    return this.grant(row);
  }
  async enableBrowser(
    session: string,
    owner: string,
    credential: string,
    raw: unknown,
  ) {
    const input = this.parse(endpointApproval, raw);
    return this.tx(async (db, gate) => {
      const endpoint = await this.browser(db, gate, session, owner, credential);
      if (
        endpoint.endpointId !== input.deviceId ||
        endpoint.credentialEpoch !== input.credentialEpoch
      )
        throw new RemoteStatusError("DENIED");
      return this.create(db, gate, endpoint, input);
    });
  }
  async approveMac(session: string, owner: string, raw: unknown) {
    const input = this.parse(endpointApproval, raw);
    return this.tx(async (db, gate) => {
      await this.session(db, gate, session, owner);
      return this.create(
        db,
        gate,
        await this.endpoint(
          db,
          gate,
          "mac",
          owner,
          input.deviceId,
          input.credentialEpoch,
        ),
        input,
      );
    });
  }
  private async statusEndpoint(
    db: PoolClient,
    gate: Gate,
    statusCredential: string,
  ) {
    if (!token.safeParse(statusCredential).success)
      throw new RemoteStatusError("DENIED");
    const identified = (
      await db.query(
        "SELECT id,owner_id FROM remote_devices WHERE credential_hash=$1",
        [hash(statusCredential)],
      )
    ).rows[0];
    if (!identified) throw new RemoteStatusError("DENIED");
    await this.ownerLock(db, identified.owner_id);
    const row = (
      await db.query(
        "SELECT id,owner_id,epoch FROM remote_devices WHERE credential_hash=$1 FOR SHARE",
        [hash(statusCredential)],
      )
    ).rows[0];
    if (
      !row ||
      row.id !== identified.id ||
      row.owner_id !== identified.owner_id
    )
      throw new RemoteStatusError("DENIED");
    return this.endpoint(
      db,
      gate,
      "mac",
      row.owner_id,
      row.id,
      Number(row.epoch),
    );
  }
  /** Metadata-only native review/reconciliation. A status credential never reveals
   * or reissues a relay secret, and does not authorize message transport. */
  async inspectMacApproval(statusCredential: string, raw: unknown) {
    const input = this.parse(z.strictObject({ id: uuid }), raw);
    return this.tx(async (db, gate) => {
      const endpoint = await this.statusEndpoint(db, gate, statusCredential);
      const row = (
        await db.query(
          "SELECT * FROM remote_private_relay_grants WHERE id=$1 AND owner_id=$2 AND endpoint_id=$3 AND endpoint_kind='mac' AND credential_epoch=$4 FOR SHARE",
          [
            input.id,
            endpoint.ownerId,
            endpoint.endpointId,
            endpoint.credentialEpoch,
          ],
        )
      ).rows[0];
      if (!row) throw new RemoteStatusError("DENIED");
      return this.grant(row);
    });
  }
  async acceptMac(statusCredential: string, raw: unknown) {
    const input = this.parse(revisionRequest, raw);
    return this.tx(async (db, gate) => {
      const endpoint = await this.statusEndpoint(db, gate, statusCredential),
        saved = await this.current(db, endpoint);
      if (
        !saved ||
        saved.id !== input.id ||
        Number(saved.revision) !== input.expectedRevision ||
        saved.state !== "pending" ||
        Number(saved.created_at) > this.now() ||
        Number(saved.credential_epoch) !== endpoint.credentialEpoch
      )
        throw new RemoteStatusError("DENIED");
      gate.validUntil(Number(saved.approval_expires_at));
      gate.validUntil(Number(saved.expires_at));
      if (Number(saved.revision) >= Number.MAX_SAFE_INTEGER)
        throw new RemoteStatusError("CAPACITY");
      const credential = randomBytes(32).toString("base64url"),
        updated = (
          await db.query(
            "UPDATE remote_private_relay_grants SET state='active',approval_expires_at=NULL,credential_hash=$2,revision=revision+1 WHERE id=$1 RETURNING *",
            [saved.id, relayHash(credential)],
          )
        ).rows[0];
      return {
        grant: this.grant(updated),
        credential,
        scope: "private:relay" as const,
      };
    });
  }
  inspectBrowser(session: string, owner: string, credential: string) {
    return this.tx(async (db, gate) => {
      const e = await this.browser(db, gate, session, owner, credential),
        row = await this.current(db, e);
      return row ? this.grant(row) : null;
    });
  }
  async inspectOwner(session: string, owner: string, raw: unknown) {
    const input = this.parse(z.strictObject({ id: uuid }), raw);
    return this.tx(async (db, gate) => {
      await this.session(db, gate, session, owner);
      const row = (
        await db.query(
          "SELECT * FROM remote_private_relay_grants WHERE id=$1 AND owner_id=$2 FOR SHARE",
          [input.id, owner],
        )
      ).rows[0];
      if (!row) throw new RemoteStatusError("DENIED");
      return this.grant(row);
    });
  }
  async inspectOwnerOperation(session: string, owner: string, raw: unknown) {
    const input = this.parse(z.strictObject({ operationId: uuid }), raw);
    return this.tx(async (db, gate) => {
      await this.session(db, gate, session, owner);
      const row = (
        await db.query(
          "SELECT * FROM remote_private_relay_grants WHERE owner_id=$1 AND operation_id=$2 FOR SHARE",
          [owner, input.operationId],
        )
      ).rows[0];
      if (!row) throw new RemoteStatusError("DENIED");
      return this.grant(row);
    });
  }
  async listOwner(session: string, owner: string, raw: unknown) {
    const input = this.parse(
      z.strictObject({
        after: uuid.nullable(),
        limit: z.number().int().min(1).max(50),
      }),
      raw,
    );
    return this.tx(async (db, gate) => {
      await this.session(db, gate, session, owner);
      const rows = (
        await db.query(
          "SELECT * FROM remote_private_relay_grants WHERE owner_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3 FOR SHARE",
          [owner, input.after, input.limit + 1],
        )
      ).rows;
      const more = rows.length > input.limit;
      const items = rows.slice(0, input.limit).map((row) => this.grant(row));
      return { items, nextCursor: more ? items.at(-1)!.id : null };
    });
  }
  private async revoke(
    db: PoolClient,
    owner: string,
    input: z.infer<typeof revisionRequest>,
  ) {
    const row = (
      await db.query(
        "SELECT * FROM remote_private_relay_grants WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        [input.id, owner],
      )
    ).rows[0];
    if (!row) throw new RemoteStatusError("DENIED");
    if (Number(row.revision) !== input.expectedRevision)
      throw new RemoteStatusError("CONFLICT");
    if (Number(row.created_at) > this.now())
      throw new RemoteStatusError("DENIED");
    if (row.state === "revoked") return this.grant(row);
    if (Number(row.revision) >= Number.MAX_SAFE_INTEGER)
      throw new RemoteStatusError("CAPACITY");
    return this.grant(
      (
        await db.query(
          "UPDATE remote_private_relay_grants SET state='revoked',credential_hash=NULL,approval_expires_at=NULL,revoked_at=$2,revision=revision+1 WHERE id=$1 RETURNING *",
          [input.id, this.now()],
        )
      ).rows[0],
    );
  }
  async revokeOwner(session: string, owner: string, raw: unknown) {
    const input = this.parse(revisionRequest, raw);
    return this.tx(async (db, gate) => {
      await this.session(db, gate, session, owner);
      return this.revoke(db, owner, input);
    });
  }
  private async native(db: PoolClient, gate: Gate, credential: string) {
    if (!token.safeParse(credential).success)
      throw new RemoteStatusError("DENIED");
    const found = (
      await db.query(
        "SELECT owner_id FROM remote_private_relay_grants WHERE credential_hash=$1",
        [relayHash(credential)],
      )
    ).rows[0];
    if (!found) throw new RemoteStatusError("DENIED");
    await this.ownerLock(db, found.owner_id);
    const row = (
      await db.query(
        "SELECT * FROM remote_private_relay_grants WHERE owner_id=$1 AND credential_hash=$2 FOR UPDATE",
        [found.owner_id, relayHash(credential)],
      )
    ).rows[0];
    if (!row || row.endpoint_kind !== "mac")
      throw new RemoteStatusError("DENIED");
    const grant = this.grant(row),
      endpoint = await this.endpoint(
        db,
        gate,
        "mac",
        grant.ownerId,
        grant.endpointId,
        grant.credentialEpoch,
      );
    return { grant, identity: this.identity(grant, endpoint, gate) };
  }
  async revokeMac(credential: string, raw: unknown) {
    const input = this.parse(revisionRequest, raw);
    return this.tx(async (db, gate) => {
      const native = await this.native(db, gate, credential);
      if (native.grant.id !== input.id) throw new RemoteStatusError("DENIED");
      return this.revoke(db, native.identity.ownerId, input);
    });
  }
  private context(
    db: PoolClient,
    gate: Gate,
    identity: PrivateRelayIdentity,
  ): PrivateRelayTransaction {
    return {
      db,
      identity: structuredClone(identity),
      check: gate.check,
      validUntil: gate.validUntil,
      recipient: async (id: string) => {
        gate.check();
        if (!uuid.safeParse(id).success || id === identity.endpointId)
          throw new RemoteStatusError("DENIED");
        const endpoint = await this.endpoint(
            db,
            gate,
            identity.endpointKind === "browser" ? "mac" : "browser",
            identity.ownerId,
            id,
          ),
          row = await this.current(db, endpoint);
        if (!row) throw new RemoteStatusError("DENIED");
        const result = this.identity(this.grant(row), endpoint, gate);
        gate.check();
        return result;
      },
    };
  }
  /** Owner-local relay history maintenance, independent of endpoint grants. */
  withOwner<T>(
    session: string,
    owner: string,
    fn: (db: PoolClient, check: () => void) => Promise<T>,
  ) {
    return this.tx(async (db, gate) => {
      await this.session(db, gate, session, owner);
      return fn(db, gate.check);
    });
  }
  withBrowser<T>(
    session: string,
    owner: string,
    credential: string,
    fn: (context: PrivateRelayTransaction) => Promise<T>,
  ) {
    return this.tx(async (db, gate) => {
      const endpoint = await this.browser(db, gate, session, owner, credential),
        row = await this.current(db, endpoint);
      if (!row) throw new RemoteStatusError("DENIED");
      return fn(
        this.context(db, gate, this.identity(this.grant(row), endpoint, gate)),
      );
    });
  }
  withMac<T>(
    credential: string,
    fn: (context: PrivateRelayTransaction) => Promise<T>,
  ) {
    return this.tx(async (db, gate) =>
      fn(
        this.context(
          db,
          gate,
          (await this.native(db, gate, credential)).identity,
        ),
      ),
    );
  }
}
