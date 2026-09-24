import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  RemotePrivateRelayAccess,
  type PrivateRelayTransaction,
} from "./private-relay-access.js";
import { privateEnvelopeSchema } from "./private-envelope.js";
import {
  privateRelayPolicySchema,
  privateRelaySubmitSchema,
  privateRelayRecipientSchema,
  privateRelayPageSchema,
  privateRelayAcknowledgeSchema,
  privateRelayDeleteSchema,
  privateRelayStorageReceiptSchema,
  privateRelayEnvelopeHash,
  parsePrivateRelaySubmission,
} from "./private-relay-contracts.js";
import { RemoteStatusError } from "./status-store.js";
const lookup = z.strictObject({ messageId: z.uuid() });
type Prepared = {
  input: z.infer<typeof privateRelaySubmitSchema>;
  hash: string;
  bytes: number;
};
/** Inactive ciphertext repository. Authentication and current grant locks share
 * each message transaction; no decryption, task dispatch, HTTP or background loop. */
export class RemotePrivateRelayStore {
  private policy: z.infer<typeof privateRelayPolicySchema>;
  private access: RemotePrivateRelayAccess;
  constructor(
    private pool: Pool,
    rawPolicy: unknown,
    private now = Date.now,
    private expectedPermissionId?: string,
  ) {
    if (
      expectedPermissionId !== undefined &&
      !z.uuid().safeParse(expectedPermissionId).success
    )
      throw new RemoteStatusError("INVALID_INPUT");
    this.policy = this.parse(privateRelayPolicySchema, rawPolicy);
    this.access = new RemotePrivateRelayAccess(
      pool,
      this.policy.origin,
      this.policy.chainId,
      now,
    );
  }
  private parse<T>(schema: z.ZodType<T>, raw: unknown): T {
    const p = schema.safeParse(raw);
    if (!p.success) throw new RemoteStatusError("INVALID_INPUT");
    return p.data;
  }
  private async prepare(raw: unknown): Promise<Prepared> {
    const input = this.parse(privateRelaySubmitSchema, raw);
    try {
      return {
        input,
        hash: await privateRelayEnvelopeHash(input.envelope),
        bytes: new TextEncoder().encode(JSON.stringify(input)).byteLength,
      };
    } catch {
      throw new RemoteStatusError("INVALID_INPUT");
    }
  }
  private receipt(row: any) {
    return privateRelayStorageReceiptSchema.parse({
      version: 1,
      messageId: row.message_id,
      envelopeHash: row.envelope_hash,
      revision: Number(row.revision),
      storedAt: Number(row.stored_at),
      state: row.state,
    });
  }
  private mutable(row: any, expected: number) {
    if (Number(row.revision) !== expected)
      throw new RemoteStatusError("CONFLICT");
    if (expected >= Number.MAX_SAFE_INTEGER)
      throw new RemoteStatusError("CAPACITY");
    if (this.now() < Number(row.stored_at))
      throw new RemoteStatusError("DENIED");
  }
  private purgeAt(row: any, time: number) {
    const value =
      Math.max(time, Number(row.expires_at)) +
      Number(row.metadata_retention_ms);
    if (!Number.isSafeInteger(value)) throw new RemoteStatusError("CAPACITY");
    return value;
  }
  private async row(db: PoolClient, owner: string, id: string) {
    const row = (
      await db.query(
        "SELECT * FROM remote_private_messages WHERE owner_id=$1 AND message_id=$2 FOR UPDATE",
        [owner, id],
      )
    ).rows[0];
    if (!row) throw new RemoteStatusError("DENIED");
    return row;
  }
  private checkPermission(c: PrivateRelayTransaction) {
    if (
      this.expectedPermissionId !== undefined &&
      c.identity.permissionId !== this.expectedPermissionId
    )
      throw new RemoteStatusError("DENIED");
    c.check();
  }
  private route(row: any, c: PrivateRelayTransaction, recipientOnly = false) {
    this.checkPermission(c);
    const i = c.identity;
    const isRecipient =
      row.recipient_id === i.endpointId &&
      row.recipient_permission_id === i.permissionId;
    const isSender =
      row.sender_id === i.endpointId &&
      row.sender_permission_id === i.permissionId;
    if (
      row.owner_id !== i.ownerId ||
      !(isRecipient || (!recipientOnly && isSender))
    )
      throw new RemoteStatusError("DENIED");
    c.check();
  }
  private async content(row: any) {
    if (row.envelope === null) {
      if (Number(row.content_bytes) !== 0)
        throw new RemoteStatusError("UNAVAILABLE");
      return null;
    }
    try {
      const envelope = privateEnvelopeSchema.parse(row.envelope),
        h = envelope.header;
      if (
        h.ownerId !== row.owner_id ||
        h.messageId !== row.message_id ||
        h.senderId !== row.sender_id ||
        h.recipientId !== row.recipient_id ||
        h.senderKeyEpoch !== Number(row.sender_key_epoch) ||
        h.recipientKeyEpoch !== Number(row.recipient_key_epoch) ||
        h.sequence !== Number(row.sequence) ||
        h.expiresAt !== Number(row.expires_at) ||
        (await privateRelayEnvelopeHash(envelope)) !== row.envelope_hash ||
        new TextEncoder().encode(JSON.stringify({ version: 1, envelope }))
          .byteLength !== Number(row.content_bytes)
      )
        throw Error();
      return envelope;
    } catch {
      throw new RemoteStatusError("UNAVAILABLE");
    }
  }
  private async submit(c: PrivateRelayTransaction, prepared: Prepared) {
    this.checkPermission(c);
    const target = await c.recipient(
      prepared.input.envelope.header.recipientId,
    );
    try {
      parsePrivateRelaySubmission(
        prepared.input,
        c.identity,
        target,
        this.now(),
      );
    } catch {
      throw new RemoteStatusError("INVALID_INPUT");
    }
    c.validUntil(prepared.input.envelope.header.expiresAt);
    const h = prepared.input.envelope.header,
      db = c.db,
      old = (
        await db.query(
          "SELECT * FROM remote_private_messages WHERE owner_id=$1 AND message_id=$2 FOR UPDATE",
          [c.identity.ownerId, h.messageId],
        )
      ).rows[0];
    if (old) {
      this.route(old, c);
      if (
        old.sender_permission_id !== c.identity.permissionId ||
        old.recipient_permission_id !== target.permissionId
      )
        throw new RemoteStatusError("DENIED");
      if (old.envelope_hash !== prepared.hash)
        throw new RemoteStatusError("CONFLICT");
      return { receipt: this.receipt(old), duplicate: true };
    }
    const counts = (
      await db.query(
        "SELECT count(*) AS count,COALESCE(sum(content_bytes),0) AS bytes FROM remote_private_messages WHERE owner_id=$1",
        [c.identity.ownerId],
      )
    ).rows[0];
    if (
      Number(counts.count) >= this.policy.maxMessagesPerOwner ||
      Number(counts.bytes) + prepared.bytes > this.policy.maxBytesPerOwner
    )
      throw new RemoteStatusError("CAPACITY");
    const storedAt = this.now(),
      purge =
        this.policy.unreceivedContent.mode === "bounded"
          ? storedAt + this.policy.unreceivedContent.retentionMs
          : null;
    if (
      h.expiresAt <= storedAt ||
      (purge !== null && !Number.isSafeInteger(purge))
    )
      throw new RemoteStatusError("DENIED");
    const row = (
      await db.query(
        "INSERT INTO remote_private_messages(owner_id,message_id,sender_id,recipient_id,sender_kind,sender_permission_id,recipient_permission_id,sender_key_epoch,recipient_key_epoch,sequence,envelope_hash,envelope,content_bytes,revision,state,stored_at,expires_at,received_policy,unreceived_purge_at,metadata_retention_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,'stored',$14,$15,$16,$17,$18) RETURNING *",
        [
          h.ownerId,
          h.messageId,
          h.senderId,
          h.recipientId,
          c.identity.endpointKind,
          c.identity.permissionId,
          target.permissionId,
          h.senderKeyEpoch,
          h.recipientKeyEpoch,
          h.sequence,
          prepared.hash,
          prepared.input.envelope,
          prepared.bytes,
          storedAt,
          h.expiresAt,
          this.policy.receivedContent,
          purge,
          this.policy.operationalMetadataMs,
        ],
      )
    ).rows[0];
    c.check();
    return { receipt: this.receipt(row), duplicate: false };
  }
  private async recipient(c: PrivateRelayTransaction, raw: unknown) {
    this.checkPermission(c);
    const input = this.parse(privateRelayRecipientSchema, raw);
    const target = await c.recipient(input.endpointId);
    c.check();
    return target;
  }
  private async inspect(c: PrivateRelayTransaction, raw: unknown) {
    const input = this.parse(lookup, raw),
      row = await this.row(c.db, c.identity.ownerId, input.messageId);
    this.route(row, c);
    return this.receipt(row);
  }
  private async poll(c: PrivateRelayTransaction, raw: unknown) {
    this.checkPermission(c);
    const input = this.parse(privateRelayPageSchema, raw),
      time = this.now();
    const rows = (
      await c.db.query(
        `SELECT m.* FROM remote_private_messages m JOIN remote_private_relay_grants g ON g.id=m.sender_permission_id AND g.owner_id=m.owner_id AND g.endpoint_id=m.sender_id
      WHERE m.owner_id=$1 AND m.recipient_id=$2 AND m.recipient_permission_id=$3 AND m.state='stored' AND m.expires_at>$4
      AND (m.unreceived_purge_at IS NULL OR m.unreceived_purge_at>$4) AND g.state='active' AND g.expires_at>$4
      AND ((g.endpoint_kind='mac' AND EXISTS(SELECT 1 FROM remote_devices d WHERE d.owner_id=g.owner_id AND d.id=g.endpoint_id AND d.epoch=g.credential_epoch AND d.revoked_at IS NULL AND d.expires_at>$4)) OR (g.endpoint_kind='browser' AND EXISTS(SELECT 1 FROM remote_browser_devices d WHERE d.owner_id=g.owner_id AND d.id=g.endpoint_id AND d.credential_epoch=g.credential_epoch AND d.revoked_at IS NULL AND d.expires_at>$4)))
      AND ($5::bigint IS NULL OR (m.stored_at,m.message_id)>($5,$6::uuid)) ORDER BY m.stored_at,m.message_id LIMIT $7`,
        [
          c.identity.ownerId,
          c.identity.endpointId,
          c.identity.permissionId,
          time,
          input.after?.storedAt ?? null,
          input.after?.messageId ?? null,
          input.limit + 1,
        ],
      )
    ).rows;
    const selected = rows.slice(0, input.limit),
      items = [];
    for (const row of selected) {
      this.route(row, c, true);
      c.validUntil(Number(row.expires_at));
      if (row.unreceived_purge_at !== null)
        c.validUntil(Number(row.unreceived_purge_at));
      const sender = await c.recipient(row.sender_id);
      if (sender.permissionId !== row.sender_permission_id)
        throw new RemoteStatusError("DENIED");
      const envelope = await this.content(row);
      if (!envelope) throw new RemoteStatusError("UNAVAILABLE");
      items.push({ receipt: this.receipt(row), envelope });
    }
    c.check();
    const last = selected.at(-1);
    return {
      items,
      nextCursor:
        rows.length > input.limit
          ? { storedAt: Number(last.stored_at), messageId: last.message_id }
          : null,
    };
  }
  private async acknowledge(c: PrivateRelayTransaction, raw: unknown) {
    const input = this.parse(privateRelayAcknowledgeSchema, raw),
      row = await this.row(c.db, c.identity.ownerId, input.messageId);
    this.route(row, c, true);
    if (input.envelopeHash !== row.envelope_hash)
      throw new RemoteStatusError("CONFLICT");
    if (
      row.received_at !== null &&
      input.expectedRevision === Number(row.ack_revision) - 1
    )
      return { receipt: this.receipt(row), duplicate: true };
    this.mutable(row, input.expectedRevision);
    if (row.state !== "stored") throw new RemoteStatusError("CONFLICT");
    const remove = row.received_policy === "delete-after-receipt",
      time = this.now();
    const updated = (
      await c.db.query(
        "UPDATE remote_private_messages SET state='received',received_at=$3::bigint,ack_revision=revision+1,revision=revision+1,unreceived_purge_at=NULL,envelope=CASE WHEN $4 THEN NULL ELSE envelope END,content_bytes=CASE WHEN $4 THEN 0 ELSE content_bytes END,deleted_at=CASE WHEN $4 THEN $3::bigint ELSE NULL END,metadata_purge_at=CASE WHEN $4 THEN $5::bigint ELSE NULL END WHERE owner_id=$1 AND message_id=$2 RETURNING *",
        [
          c.identity.ownerId,
          input.messageId,
          time,
          remove,
          remove ? this.purgeAt(row, time) : null,
        ],
      )
    ).rows[0];
    c.check();
    return { receipt: this.receipt(updated), duplicate: false };
  }
  private async remove(
    db: PoolClient,
    owner: string,
    raw: unknown,
    c?: PrivateRelayTransaction,
  ) {
    const input = this.parse(privateRelayDeleteSchema, raw),
      row = await this.row(db, owner, input.messageId);
    if (c) this.route(row, c);
    if (
      row.state === "deleted" &&
      Number(row.delete_base_revision) === input.expectedRevision
    )
      return { receipt: this.receipt(row), duplicate: true };
    this.mutable(row, input.expectedRevision);
    if (row.state === "deleted") throw new RemoteStatusError("CONFLICT");
    const time = this.now(),
      updated = (
        await db.query(
          "UPDATE remote_private_messages SET state='deleted',delete_base_revision=revision,revision=revision+1,envelope=NULL,content_bytes=0,deleted_at=$3,unreceived_purge_at=NULL,metadata_purge_at=$4 WHERE owner_id=$1 AND message_id=$2 RETURNING *",
          [owner, input.messageId, time, this.purgeAt(row, time)],
        )
      ).rows[0];
    return { receipt: this.receipt(updated), duplicate: false };
  }
  async submitBrowser(
    session: string,
    owner: string,
    credential: string,
    raw: unknown,
  ) {
    const prepared = await this.prepare(raw);
    return this.access.withBrowser(session, owner, credential, (c) =>
      this.submit(c, prepared),
    );
  }
  async submitMac(credential: string, raw: unknown) {
    const prepared = await this.prepare(raw);
    return this.access.withMac(credential, (c) => this.submit(c, prepared));
  }
  recipientBrowser(
    session: string,
    owner: string,
    credential: string,
    raw: unknown,
  ) {
    return this.access.withBrowser(session, owner, credential, (c) =>
      this.recipient(c, raw),
    );
  }
  recipientMac(credential: string, raw: unknown) {
    return this.access.withMac(credential, (c) => this.recipient(c, raw));
  }
  pollBrowser(
    session: string,
    owner: string,
    credential: string,
    raw: unknown,
  ) {
    return this.access.withBrowser(session, owner, credential, (c) =>
      this.poll(c, raw),
    );
  }
  pollMac(credential: string, raw: unknown) {
    return this.access.withMac(credential, (c) => this.poll(c, raw));
  }
  inspectBrowser(
    session: string,
    owner: string,
    credential: string,
    raw: unknown,
  ) {
    return this.access.withBrowser(session, owner, credential, (c) =>
      this.inspect(c, raw),
    );
  }
  inspectMac(credential: string, raw: unknown) {
    return this.access.withMac(credential, (c) => this.inspect(c, raw));
  }
  acknowledgeBrowser(
    session: string,
    owner: string,
    credential: string,
    raw: unknown,
  ) {
    return this.access.withBrowser(session, owner, credential, (c) =>
      this.acknowledge(c, raw),
    );
  }
  acknowledgeMac(credential: string, raw: unknown) {
    return this.access.withMac(credential, (c) => this.acknowledge(c, raw));
  }
  deleteBrowser(
    session: string,
    owner: string,
    credential: string,
    raw: unknown,
  ) {
    return this.access.withBrowser(session, owner, credential, (c) =>
      this.remove(c.db, owner, raw, c),
    );
  }
  deleteMac(credential: string, raw: unknown) {
    return this.access.withMac(credential, (c) =>
      this.remove(c.db, c.identity.ownerId, raw, c),
    );
  }
  deleteOwner(session: string, owner: string, raw: unknown) {
    return this.access.withOwner(session, owner, (db) =>
      this.remove(db, owner, raw),
    );
  }
  exportOwner(session: string, owner: string, raw: unknown) {
    return this.access.withOwner(session, owner, async (db, check) => {
      const input = this.parse(privateRelayPageSchema, raw),
        rows = (
          await db.query(
            "SELECT * FROM remote_private_messages WHERE owner_id=$1 AND ($2::bigint IS NULL OR (stored_at,message_id)>($2,$3::uuid)) ORDER BY stored_at,message_id LIMIT $4",
            [
              owner,
              input.after?.storedAt ?? null,
              input.after?.messageId ?? null,
              input.limit + 1,
            ],
          )
        ).rows,
        selected = rows.slice(0, input.limit),
        items = [];
      for (const row of selected) {
        const envelope = await this.content(row);
        items.push({
          receipt: this.receipt(row),
          senderId: row.sender_id,
          recipientId: row.recipient_id,
          envelope,
        });
      }
      check();
      const last = selected.at(-1);
      return {
        version: 1,
        restoreAuthority: false,
        items,
        nextCursor:
          rows.length > input.limit
            ? { storedAt: Number(last.stored_at), messageId: last.message_id }
            : null,
      };
    });
  }
  /** Internal bounded maintenance, never exposed as a user-selected cutoff or live scheduler. */
  async cleanup(batchSize: number) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000)
      throw new RemoteStatusError("INVALID_INPUT");
    const cutoff = this.now();
    if (!Number.isSafeInteger(cutoff) || cutoff <= 0)
      throw new RemoteStatusError("DENIED");
    let db: PoolClient | undefined,
      contentDeleted = 0,
      metadataDeleted = 0;
    try {
      db = await this.pool.connect();
      await db.query("BEGIN");
      await db.query("SET LOCAL statement_timeout='5s'");
      await db.query("SET LOCAL lock_timeout='1s'");
      const owners = (
        await db.query(
          "SELECT DISTINCT owner_id FROM remote_private_messages WHERE (state='stored' AND unreceived_purge_at<=$1) OR metadata_purge_at<=$1 ORDER BY owner_id LIMIT $2",
          [cutoff, batchSize],
        )
      ).rows;
      for (const owner of owners) {
        if (contentDeleted + metadataDeleted >= batchSize) break;
        const acquired = (
          await db.query(
            "SELECT pg_try_advisory_xact_lock(hashtextextended('bittrees-ai:private-relay:' || $1,0)) AS acquired",
            [owner.owner_id],
          )
        ).rows[0].acquired;
        if (!acquired) continue;
        const due = (
          await db.query(
            "SELECT * FROM remote_private_messages WHERE owner_id=$1 AND ((state='stored' AND unreceived_purge_at<=$2) OR metadata_purge_at<=$2) ORDER BY stored_at,message_id LIMIT $3 FOR UPDATE",
            [
              owner.owner_id,
              cutoff,
              batchSize - contentDeleted - metadataDeleted,
            ],
          )
        ).rows;
        for (const row of due) {
          if (
            row.metadata_purge_at !== null &&
            Number(row.metadata_purge_at) <= cutoff
          ) {
            await db.query(
              "DELETE FROM remote_private_messages WHERE owner_id=$1 AND message_id=$2",
              [owner.owner_id, row.message_id],
            );
            metadataDeleted++;
          } else {
            this.mutable(row, Number(row.revision));
            await db.query(
              "UPDATE remote_private_messages SET state='deleted',delete_base_revision=revision,revision=revision+1,envelope=NULL,content_bytes=0,deleted_at=$3,unreceived_purge_at=NULL,metadata_purge_at=$4 WHERE owner_id=$1 AND message_id=$2",
              [
                owner.owner_id,
                row.message_id,
                cutoff,
                this.purgeAt(row, cutoff),
              ],
            );
            contentDeleted++;
          }
        }
      }
      if (this.now() < cutoff) throw new RemoteStatusError("DENIED");
      await db.query("COMMIT");
      return { cutoff, contentDeleted, metadataDeleted };
    } catch (e) {
      if (db) await db.query("ROLLBACK").catch(() => {});
      if (e instanceof RemoteStatusError) throw e;
      throw new RemoteStatusError("UNAVAILABLE");
    } finally {
      db?.release();
    }
  }
}
