import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { RemoteTemplateStore } from "./templates.js";
import {
  mcpDispatchSchema,
  mcpActorSchema,
} from "./mcp-delegation-contracts.js";
import { RemoteStatusError } from "./status-store.js";
import {
  mcpDelegationRequestSchema,
  mcpDelegationApprovalSchema,
  mcpDelegationRedeemSchema,
} from "./mcp-delegation-contracts.js";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const parse = <T>(schema: z.ZodType<T>, raw: unknown): T => {
  const result = schema.safeParse(raw);
  if (!result.success) throw new RemoteStatusError("INVALID_INPUT");
  return result.data;
};
const metadata = (row: any) => ({
  id: row.id,
  clientId: row.client_id,
  actor: row.actor,
  ownerId: row.owner_id,
  permissionId: row.permission_id,
  templateRevision:
    row.template_revision === null ? null : Number(row.template_revision),
  maxRuns: row.max_runs,
  submittedRuns: row.submitted_runs,
  expiresAt: row.expires_at === null ? null : Number(row.expires_at),
  requestExpiresAt: Number(row.request_expires_at),
  redeemed: row.redeemed_at !== null,
  revoked: row.revoked_at !== null,
});
/** Consent repository, mounted only when the confidential client is configured. Client calls require a separately
 * authenticated, fixed MCP service identity; owner calls require the verified AI
 * browser owner. Neither identity is taken from request fields. The client service
 * credential grants only client authentication, never template submission by itself. */
export class RemoteMcpDelegationStore {
  constructor(
    private pool: Pool,
    private now = Date.now,
  ) {}
  private async transaction<T>(work: (db: PoolClient) => Promise<T>) {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SET LOCAL statement_timeout='5s'");
      const result = await work(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      if (error instanceof RemoteStatusError) throw error;
      throw new RemoteStatusError("UNAVAILABLE");
    } finally {
      db.release();
    }
  }
  private client(clientId: string) {
    if (clientId !== "bittrees-mcp") throw new RemoteStatusError("DENIED");
  }
  private async parent(db: PoolClient, owner: string, permission: string) {
    const reference = (
      await db.query(
        "SELECT device_id FROM remote_templates WHERE permission_id=$1",
        [permission],
      )
    ).rows[0];
    if (!reference) throw new RemoteStatusError("DENIED");
    const device = (
      await db.query(
        "SELECT * FROM remote_devices WHERE id=$1 AND owner_id=$2 FOR UPDATE",
        [reference.device_id, owner],
      )
    ).rows[0];
    const grant = (
      await db.query(
        "SELECT * FROM remote_templates WHERE permission_id=$1 FOR UPDATE",
        [permission],
      )
    ).rows[0];
    this.freshParent(device, grant);
    return { device, grant };
  }
  private freshParent(device: any, grant: any) {
    const now = this.now();
    if (
      !device ||
      !grant ||
      device.revoked_at !== null ||
      grant.revoked_at !== null ||
      !grant.credential_hash ||
      Number(device.expires_at) <= now ||
      Number(grant.expires_at) <= now ||
      device.epoch !== grant.device_epoch
    )
      throw new RemoteStatusError("DENIED");
  }
  async begin(clientId: string, raw: unknown) {
    this.client(clientId);
    const input = parse(mcpDelegationRequestSchema, raw),
      fingerprint = hash(JSON.stringify(input));
    return this.transaction(async (db) => {
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('bittrees-ai:mcp-consent-capacity',0))",
      );
      const old = (
        await db.query(
          "SELECT * FROM remote_mcp_delegations WHERE id=$1 FOR UPDATE",
          [input.id],
        )
      ).rows[0];
      if (old) {
        if (
          old.request_hash !== fingerprint ||
          old.client_id !== clientId ||
          old.owner_id !== null ||
          old.revoked_at !== null ||
          Number(old.request_expires_at) <= this.now()
        )
          throw new RemoteStatusError("CONFLICT");
        return { id: old.id, requestExpiresAt: Number(old.request_expires_at) };
      }
      await db.query(
        "DELETE FROM remote_mcp_delegations WHERE owner_id IS NULL AND request_expires_at<=$1",
        [this.now()],
      );
      if (
        Number(
          (
            await db.query(
              "SELECT count(*) FROM remote_mcp_delegations WHERE owner_id IS NULL",
            )
          ).rows[0].count,
        ) >= 1000
      )
        throw new RemoteStatusError("CAPACITY");
      const expires = this.now() + 300000;
      await db.query(
        "INSERT INTO remote_mcp_delegations(id,client_id,actor,request_hash,challenge,approval_hash,request_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          input.id,
          clientId,
          input.actor,
          fingerprint,
          input.challenge,
          input.approvalHash,
          expires,
        ],
      );
      return { id: input.id, requestExpiresAt: expires };
    });
  }
  async review(ownerId: string, id: string, approvalCode: string) {
    parse(z.uuid(), ownerId);
    parse(z.uuid(), id);
    parse(z.string().regex(/^[A-Za-z0-9_-]{43}$/), approvalCode);
    return this.transaction(async (db) => {
      const row = (
        await db.query("SELECT * FROM remote_mcp_delegations WHERE id=$1", [id])
      ).rows[0];
      if (
        !row ||
        row.owner_id !== null ||
        row.revoked_at !== null ||
        row.approval_hash !== hash(approvalCode) ||
        Number(row.request_expires_at) <= this.now()
      )
        throw new RemoteStatusError("DENIED");
      return metadata(row);
    });
  }
  async approve(ownerId: string, raw: unknown) {
    parse(z.uuid(), ownerId);
    const input = parse(mcpDelegationApprovalSchema, raw);
    return this.transaction(async (db) => {
      const { device, grant } = await this.parent(
        db,
        ownerId,
        input.permissionId,
      );
      const row = (
        await db.query(
          "SELECT * FROM remote_mcp_delegations WHERE id=$1 FOR UPDATE",
          [input.id],
        )
      ).rows[0];
      if (
        !row ||
        row.owner_id !== null ||
        row.revoked_at !== null ||
        row.approval_hash !== hash(input.approvalCode) ||
        Number(row.request_expires_at) <= this.now()
      )
        throw new RemoteStatusError("DENIED");
      if (
        Number(grant.template_revision) !== input.expectedTemplateRevision ||
        input.expiresAt <= this.now() ||
        input.expiresAt > Number(grant.expires_at) ||
        input.expiresAt > Number(device.expires_at) ||
        input.maxRuns > grant.max_runs - grant.submitted_runs
      )
        throw new RemoteStatusError("CONFLICT");
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('bittrees-ai:mcp-owner-capacity:' || $1,0))",
        [ownerId],
      );
      if (
        Number(
          (
            await db.query(
              "SELECT count(*) FROM remote_mcp_delegations WHERE owner_id=$1",
              [ownerId],
            )
          ).rows[0].count,
        ) >= 100
      )
        throw new RemoteStatusError("CAPACITY");
      const saved = (
        await db.query(
          "UPDATE remote_mcp_delegations SET owner_id=$2,permission_id=$3,template_revision=$4,max_runs=$5,expires_at=$6 WHERE id=$1 RETURNING *",
          [
            input.id,
            ownerId,
            input.permissionId,
            input.expectedTemplateRevision,
            input.maxRuns,
            input.expiresAt,
          ],
        )
      ).rows[0];
      this.freshParent(device, grant);
      if (
        input.expiresAt <= this.now() ||
        Number(row.request_expires_at) <= this.now()
      )
        throw new RemoteStatusError("DENIED");
      return metadata(saved);
    });
  }
  async redeem(clientId: string, raw: unknown) {
    this.client(clientId);
    const input = parse(mcpDelegationRedeemSchema, raw);
    return this.transaction(async (db) => {
      const initial = (
        await db.query(
          "SELECT owner_id,permission_id FROM remote_mcp_delegations WHERE id=$1",
          [input.id],
        )
      ).rows[0];
      if (
        !initial ||
        initial.owner_id !== input.expectedOwnerId ||
        !initial.permission_id
      )
        throw new RemoteStatusError("DENIED");
      const { device, grant } = await this.parent(
        db,
        input.expectedOwnerId,
        initial.permission_id,
      );
      const row = (
        await db.query(
          "SELECT * FROM remote_mcp_delegations WHERE id=$1 FOR UPDATE",
          [input.id],
        )
      ).rows[0];
      const challenge = createHash("sha256")
        .update(input.verifier)
        .digest("base64url");
      if (
        !row ||
        row.client_id !== clientId ||
        row.owner_id !== input.expectedOwnerId ||
        row.permission_id !== initial.permission_id ||
        row.challenge !== challenge ||
        JSON.stringify(
          parse(mcpDelegationRequestSchema.shape.actor, row.actor),
        ) !== JSON.stringify(input.actor) ||
        row.redeemed_at !== null ||
        row.revoked_at !== null ||
        Number(row.request_expires_at) <= this.now() ||
        Number(row.expires_at) <= this.now() ||
        Number(row.template_revision) !== Number(grant.template_revision)
      )
        throw new RemoteStatusError("DENIED");
      const credential = randomBytes(32).toString("base64url");
      const saved = (
        await db.query(
          "UPDATE remote_mcp_delegations SET credential_hash=$2,redeemed_at=$3 WHERE id=$1 RETURNING *",
          [input.id, hash(credential), this.now()],
        )
      ).rows[0];
      this.freshParent(device, grant);
      if (
        Number(row.expires_at) <= this.now() ||
        Number(row.request_expires_at) <= this.now()
      )
        throw new RemoteStatusError("DENIED");
      return {
        grant: { ...metadata(saved), deviceId: device.id, templateId: grant.template_id },
        credential,
      };
    });
  }
  private async dispatchContext(
    db: PoolClient,
    clientId: string,
    credential: string,
    input: z.infer<typeof mcpDispatchSchema>,
  ) {
    const initial = (
      await db.query(
        "SELECT owner_id,permission_id FROM remote_mcp_delegations WHERE id=$1 AND client_id=$2 AND credential_hash=$3",
        [input.grantId, clientId, hash(credential)],
      )
    ).rows[0];
    if (!initial?.owner_id || initial.permission_id !== input.permissionId)
      throw new RemoteStatusError("DENIED");
    const parent = await this.parent(
      db,
      initial.owner_id,
      initial.permission_id,
    );
    const delegation = (
      await db.query(
        "SELECT * FROM remote_mcp_delegations WHERE id=$1 FOR UPDATE",
        [input.grantId],
      )
    ).rows[0];
    if (
      !delegation ||
      delegation.client_id !== clientId ||
      delegation.owner_id !== initial.owner_id ||
      delegation.permission_id !== initial.permission_id ||
      delegation.credential_hash !== hash(credential) ||
      delegation.revoked_at !== null ||
      delegation.redeemed_at === null ||
      Number(delegation.expires_at) <= this.now() ||
      Number(delegation.template_revision) !==
        Number(parent.grant.template_revision) ||
      JSON.stringify(parse(mcpActorSchema, delegation.actor)) !==
        JSON.stringify({
          tenant: input.tenant,
          subject: input.subject,
          actorId: input.actorId,
        })
    )
      throw new RemoteStatusError("DENIED");
    if (
      input.command.deviceId !== parent.device.id ||
      input.command.templateId !== parent.grant.template_id ||
      input.command.templateRevision !== Number(delegation.template_revision)
    )
      throw new RemoteStatusError("CONFLICT");
    return { ...parent, delegation };
  }
  /** Queue acceptance only. Template contents, inference and publication stay local
   * or source-owned; the confidential client cannot submit without this owner grant. */
  async dispatch(
    clientId: string,
    credential: string,
    raw: unknown,
    templates: RemoteTemplateStore,
  ) {
    this.client(clientId);
    parse(z.string().regex(/^[A-Za-z0-9_-]{43}$/), credential);
    const input = parse(mcpDispatchSchema, raw),
      requestHash = hash(JSON.stringify(input));
    return this.transaction(async (db) => {
      const { device, grant, delegation } = await this.dispatchContext(
        db,
        clientId,
        credential,
        input,
      );
      const prior = (
        await db.query(
          "SELECT * FROM remote_mcp_dispatches WHERE command_id=$1 OR (delegation_id=$2 AND run_id=$3)",
          [input.command.id, input.grantId, input.runId],
        )
      ).rows[0];
      if (prior) {
        if (
          prior.command_id !== input.command.id ||
          prior.delegation_id !== input.grantId ||
          prior.request_hash !== requestHash
        )
          throw new RemoteStatusError("CONFLICT");
      } else {
        if (delegation.submitted_runs >= delegation.max_runs)
          throw new RemoteStatusError("CAPACITY");
        if (Date.parse(input.command.expiresAt) > Number(delegation.expires_at))
          throw new RemoteStatusError("DENIED");
        const queued = await templates.submitInTransaction(
          db,
          delegation.owner_id,
          {
            permissionId: input.permissionId,
            command: input.command,
            confirmed: true,
          },
        );
        // Never claim a pre-existing browser/other-grant command as this run.
        if (queued.duplicate) throw new RemoteStatusError("CONFLICT");
        await db.query(
          "INSERT INTO remote_mcp_dispatches(command_id,delegation_id,run_id,automation_id,request_hash,accepted_at) VALUES($1,$2,$3,$4,$5,$6)",
          [
            input.command.id,
            input.grantId,
            input.runId,
            input.automationId,
            requestHash,
            this.now(),
          ],
        );
        await db.query(
          "UPDATE remote_mcp_delegations SET submitted_runs=submitted_runs+1 WHERE id=$1",
          [input.grantId],
        );
      }
      this.freshParent(device, grant);
      if (Number(delegation.expires_at) <= this.now())
        throw new RemoteStatusError("DENIED");
      return {
        id: input.command.id,
        grantId: input.grantId,
        permissionId: input.permissionId,
        state: "accepted" as const,
      };
    });
  }
  async inspectDispatch(clientId: string, credential: string, raw: unknown) {
    this.client(clientId);
    parse(z.string().regex(/^[A-Za-z0-9_-]{43}$/), credential);
    const input = parse(mcpDispatchSchema, raw),
      requestHash = hash(JSON.stringify(input));
    return this.transaction(async (db) => {
      const { device, grant, delegation } = await this.dispatchContext(
        db,
        clientId,
        credential,
        input,
      );
      const prior = (
        await db.query(
          "SELECT * FROM remote_mcp_dispatches WHERE command_id=$1 OR (delegation_id=$2 AND run_id=$3)",
          [input.command.id, input.grantId, input.runId],
        )
      ).rows[0];
      if (
        prior &&
        (prior.command_id !== input.command.id ||
          prior.delegation_id !== input.grantId ||
          prior.request_hash !== requestHash)
      )
        throw new RemoteStatusError("CONFLICT");
      this.freshParent(device, grant);
      if (Number(delegation.expires_at) <= this.now())
        throw new RemoteStatusError("DENIED");
      return {
        id: input.command.id,
        grantId: input.grantId,
        permissionId: input.permissionId,
        state: prior ? ("accepted" as const) : ("not_found" as const),
      };
    });
  }
  async disconnect(clientId: string, credential: string, raw: unknown) {
    this.client(clientId);
    parse(z.string().regex(/^[A-Za-z0-9_-]{43}$/), credential);
    const input = parse(
      z.strictObject({ id: z.uuid(), actor: mcpActorSchema }),
      raw,
    );
    return this.transaction(async (db) => {
      const row = (
        await db.query(
          "SELECT * FROM remote_mcp_delegations WHERE id=$1 FOR UPDATE",
          [input.id],
        )
      ).rows[0];
      if (!row) return { revoked: true };
      if (
        row.client_id !== clientId ||
        row.credential_hash !== hash(credential) ||
        JSON.stringify(parse(mcpActorSchema, row.actor)) !==
          JSON.stringify(input.actor)
      )
        throw new RemoteStatusError("DENIED");
      // Retain only the hash so a lost disconnect reply can be acknowledged again.
      // Every dispatch/redemption path independently rejects revoked records.
      await db.query(
        "UPDATE remote_mcp_delegations SET revoked_at=COALESCE(revoked_at,$2) WHERE id=$1",
        [input.id, this.now()],
      );
      return { revoked: true };
    });
  }
  async list(ownerId: string) {
    parse(z.uuid(), ownerId);
    return this.transaction(async (db) => ({
      items: (
        await db.query(
          "SELECT * FROM remote_mcp_delegations WHERE owner_id=$1 ORDER BY id LIMIT 100",
          [ownerId],
        )
      ).rows.map(metadata),
    }));
  }
  async forget(ownerId: string, id: string) {
    parse(z.uuid(), ownerId);
    parse(z.uuid(), id);
    return this.transaction(async (db) => {
      const row = (
        await db.query(
          "SELECT * FROM remote_mcp_delegations WHERE id=$1 AND owner_id=$2 FOR UPDATE",
          [id, ownerId],
        )
      ).rows[0];
      if (!row || row.revoked_at === null)
        throw new RemoteStatusError("DENIED");
      await db.query(
        "DELETE FROM remote_mcp_dispatches WHERE delegation_id=$1",
        [id],
      );
      await db.query("DELETE FROM remote_mcp_delegations WHERE id=$1", [id]);
      // Accepted commands retain the template queue's independent lifecycle.
      return { forgotten: true };
    });
  }
  async revoke(ownerId: string, id: string) {
    parse(z.uuid(), ownerId);
    parse(z.uuid(), id);
    return this.transaction(async (db) => {
      const row = (
        await db.query(
          "UPDATE remote_mcp_delegations SET revoked_at=COALESCE(revoked_at,$3) WHERE id=$1 AND owner_id=$2 RETURNING id",
          [id, ownerId, this.now()],
        )
      ).rows[0];
      if (!row) throw new RemoteStatusError("DENIED");
      return { revoked: true };
    });
  }
}
