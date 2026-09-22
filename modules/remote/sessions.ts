import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getAddress, verifyMessage } from "ethers";
import { SiweMessage } from "siwe";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import { RemoteStatusError } from "./status-store.js";
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
/** Internal EOA SIWE verification and sessions. HTTP cookie/Origin/CSRF protections required separately. */
export class RemoteSessionStore {
  private origin: string;
  constructor(
    private pool: Pool,
    origin: string,
    private chainId: number,
    private sessionMs: number,
    private now = Date.now,
  ) {
    const parsed = new URL(origin);
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== origin ||
      !Number.isSafeInteger(chainId) ||
      chainId < 1 ||
      !Number.isSafeInteger(sessionMs) ||
      sessionMs < 60000 ||
      sessionMs > 86400000
    )
      throw new RemoteStatusError("INVALID_INPUT");
    this.origin = origin;
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
  async begin(address: string) {
    let normalized: string;
    try {
      normalized = getAddress(address);
    } catch {
      throw new RemoteStatusError("INVALID_INPUT");
    }
    const id = randomUUID(),
      browserToken = secret(),
      now = this.now(),
      expiresAt = now + 300000;
    const message = new SiweMessage({
      scheme: "https",
      domain: new URL(this.origin).host,
      address: normalized,
      statement:
        "Sign in to Bittrees AI. This does not grant access to other apps.",
      uri: this.origin,
      version: "1",
      chainId: this.chainId,
      nonce: randomBytes(16).toString("hex"),
      issuedAt: new Date(now).toISOString(),
      expirationTime: new Date(expiresAt).toISOString(),
      requestId: id,
    }).prepareMessage();
    await this.transaction((db) =>
      db.query(
        "INSERT INTO remote_login_challenges(id,browser_hash,message_hash,address,chain_id,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          hash(browserToken),
          hash(message),
          normalized.toLowerCase(),
          this.chainId,
          expiresAt,
        ],
      ),
    );
    return { id, browserToken, message, expiresAt };
  }
  async verify(raw: unknown) {
    const input = z
      .strictObject({
        id: z.uuid(),
        browserToken: tokenSchema,
        message: z.string().min(1).max(2048),
        signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
      })
      .safeParse(raw);
    if (!input.success) throw new RemoteStatusError("DENIED");
    const v = input.data;
    // Offline EOA recovery only: no RPC, EIP-1271 fallback or transaction around a network call.
    let recovered: string;
    try {
      recovered = verifyMessage(v.message, v.signature).toLowerCase();
    } catch {
      throw new RemoteStatusError("DENIED");
    }
    return this.transaction(async (db) => {
      const row = (
        await db.query(
          "SELECT * FROM remote_login_challenges WHERE id=$1 FOR UPDATE",
          [v.id],
        )
      ).rows[0];
      const now = this.now();
      if (
        !row ||
        row.browser_hash !== hash(v.browserToken) ||
        row.message_hash !== hash(v.message) ||
        row.address !== recovered ||
        Number(row.chain_id) !== this.chainId ||
        Number(row.expires_at) <= now
      )
        throw new RemoteStatusError("DENIED");
      // The exact server-generated message binds origin, chain, nonce, statement and lifetime.
      const parsed = new SiweMessage(v.message);
      if (
        parsed.uri !== this.origin ||
        parsed.domain !== new URL(this.origin).host ||
        parsed.scheme !== "https"
      )
        throw new RemoteStatusError("DENIED");
      const owner = (
        await db.query(
          "INSERT INTO remote_accounts(id,address,chain_id) VALUES($1,$2,$3) ON CONFLICT(address,chain_id) DO UPDATE SET address=excluded.address RETURNING id",
          [randomUUID(), recovered, this.chainId],
        )
      ).rows[0].id as string;
      const token = secret(),
        expiresAt = now + this.sessionMs;
      await db.query(
        "INSERT INTO remote_sessions(token_hash,owner_id,expires_at,origin,chain_id) VALUES($1,$2,$3,$4,$5)",
        [hash(token), owner, expiresAt, this.origin, this.chainId],
      );
      await db.query("DELETE FROM remote_login_challenges WHERE id=$1", [v.id]);
      if (Number(row.expires_at) <= this.now())
        throw new RemoteStatusError("DENIED");
      return { ownerId: owner, token, expiresAt };
    });
  }
  async authenticate(token: string) {
    if (!tokenSchema.safeParse(token).success)
      throw new RemoteStatusError("DENIED");
    return this.transaction(async (db) => {
      const row = (
        await db.query(
          "SELECT owner_id,expires_at FROM remote_sessions WHERE token_hash=$1 AND origin=$2 AND chain_id=$3 FOR SHARE",
          [hash(token), this.origin, this.chainId],
        )
      ).rows[0];
      if (!row || Number(row.expires_at) <= this.now())
        throw new RemoteStatusError("DENIED");
      return { ownerId: row.owner_id as string };
    });
  }
  async logout(token: string) {
    if (!tokenSchema.safeParse(token).success)
      throw new RemoteStatusError("DENIED");
    await this.transaction((db) =>
      db.query(
        "DELETE FROM remote_sessions WHERE token_hash=$1 AND origin=$2 AND chain_id=$3",
        [hash(token), this.origin, this.chainId],
      ),
    );
  }
  async purgeExpired() {
    return this.transaction(async (db) => {
      const now = this.now();
      await db.query(
        "DELETE FROM remote_login_challenges WHERE expires_at<=$1",
        [now],
      );
      await db.query("DELETE FROM remote_sessions WHERE expires_at<=$1", [now]);
    });
  }
}
