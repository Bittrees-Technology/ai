import {
  autoNoteApprovalDetailSchema,
  autoNoteExactReviewSchema,
  autoNoteReceiptSchema,
  type AutoNoteExactReview,
} from "./autonote-review-contracts.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AsyncEntry } from "@napi-rs/keyring";
import { z } from "zod";
import { ConnectorError, type ConnectorSecret } from "./crm.js";
import type { AutoNoteConnector } from "./autonote.js";
const origin = "https://autonote.bittrees.org";
const grantSchema = z.strictObject({
  approvalId: z.uuid(),
  grantId: z.uuid(),
  meetingId: z.uuid(),
  actions: z.tuple([z.literal("approve_meeting_notes")]),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.iso.datetime(),
});
const savedSchema = z.strictObject({
  owner: z.string().min(1).max(256),
  subjectId: z.uuid(),
  workspaceId: z.uuid(),
  grant: grantSchema,
});
export function autonoteApprovalKeychainEntry(
  profile: string,
): ConnectorSecret {
  if (process.platform !== "darwin" || !/^[A-Za-z0-9_-]{1,80}$/.test(profile))
    throw new Error(
      "AutoNote approval credentials require a valid macOS profile",
    );
  return new AsyncEntry("org.bittrees.ai.connector.autonote-approval", profile);
}
/** Separate source consent and secret; exact saves require fresh matching review. */
export class AutoNoteApprovalConnector {
  private busy = false;
  private pending?: {
    id: string;
    verifier: string;
    expires: number;
    parent: string;
    check: () => void;
  };
  constructor(
    private readonly owner: string,
    private readonly secret: ConnectorSecret,
    private readonly source: AutoNoteConnector,
    private readonly transport: typeof fetch = fetch,
    private readonly now = Date.now,
  ) {
    z.string().min(1).max(256).parse(owner);
  }
  private async saved() {
    const raw = await this.secret.getSecret();
    if (!raw) return null;
    try {
      if (raw.length > 32768) throw Error();
      const result = savedSchema.parse(
        JSON.parse(Buffer.from(raw).toString("utf8")),
      );
      if (result.owner !== this.owner) throw Error();
      return result;
    } catch {
      throw new ConnectorError("INVALID_CONNECTION");
    }
  }
  private async parent() {
    const parent = await this.source.status();
    if (!parent || parent.state !== "stored")
      throw new ConnectorError("CONNECTION_REQUIRED");
    return parent;
  }
  async status() {
    const saved = await this.saved();
    if (!saved) return null;
    const parent = await this.source.status();
    const { token: _secret, ...grant } = saved.grant;
    return {
      ...grant,
      subjectId: saved.subjectId,
      workspaceId: saved.workspaceId,
      state:
        Date.parse(grant.expiresAt) <= this.now()
          ? "expired"
          : !parent ||
              parent.state !== "stored" ||
              parent.grantId !== grant.grantId ||
              parent.meetingId !== grant.meetingId ||
              parent.subjectId !== saved.subjectId ||
              parent.workspaceId !== saved.workspaceId
            ? "unavailable"
            : "stored",
      manageUrl: origin + "/connect/ai",
    };
  }
  private async exclusive<T>(operation: () => Promise<T>) {
    if (this.busy) throw new ConnectorError("CONNECTION_BUSY");
    this.busy = true;
    try {
      return await operation();
    } finally {
      this.busy = false;
    }
  }
  async begin() {
    return this.exclusive(async () => {
      this.pending = undefined;
      if (await this.saved()) throw new ConnectorError("INVALID_CONNECTION");
      const parent = await this.parent();
      const review = await this.source.reviewStatus(parent.grantId);
      if (!review.enabled) throw new ConnectorError("SOURCE_DENIED");
      // reviewStatus itself advances the source boundary; capture after that explicit read.
      const current = this.source.captureReadBoundary();
      if (JSON.stringify(await this.parent()) !== JSON.stringify(parent))
        throw new ConnectorError("SOURCE_DENIED");
      current();
      const id = randomUUID(),
        verifier = randomBytes(32).toString("base64url"),
        expires = Math.min(
          this.now() + 10 * 60000,
          Date.parse(parent.expiresAt),
        );
      this.pending = {
        id,
        verifier,
        expires,
        parent: JSON.stringify(parent),
        check: current,
      };
      return {
        id,
        expiresAt: new Date(expires).toISOString(),
        consentUrl:
          origin +
          "/connect/ai?approval_challenge=" +
          createHash("sha256").update(verifier).digest("base64url") +
          "&approval_grant=" +
          parent.grantId,
      };
    });
  }
  private async post(
    path: "approval-exchange" | "approval-review" | "approval-save",
    body: unknown,
    token?: string,
  ) {
    try {
      const response = await this.transport(
        origin + "/api/integrations/ai/" + path,
        {
          method: "POST",
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: "Bearer " + token } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new ConnectorError(
          [401, 403, 404].includes(response.status)
            ? "SOURCE_DENIED"
            : "SOURCE_UNAVAILABLE",
        );
      }
      if (
        !/^application\/json\b/i.test(
          response.headers.get("content-type") ?? "",
        )
      ) {
        await response.body?.cancel();
        throw new ConnectorError("INVALID_SOURCE");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new ConnectorError("INVALID_SOURCE");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > (path === "approval-review" ? 2_000_000 : 8192))
            throw new ConnectorError("INVALID_SOURCE");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch (e) {
      if (e instanceof ConnectorError) throw e;
      throw new ConnectorError("SOURCE_UNAVAILABLE");
    }
  }
  async finish(id: string, code: string) {
    return this.exclusive(async () => {
      const pending = this.pending;
      this.pending = undefined; // Lost exchange response requires fresh consent, never blind replay.
      if (
        !pending ||
        pending.id !== id ||
        pending.expires <= this.now() ||
        !/^[a-f0-9]{64}$/.test(code)
      )
        throw new ConnectorError("INVALID_CONNECTION");
      pending.check();
      const parent = await this.parent();
      if (JSON.stringify(parent) !== pending.parent)
        throw new ConnectorError("SOURCE_DENIED");
      pending.check();
      const parsed = grantSchema.safeParse(
        await this.post("approval-exchange", {
          code,
          verifier: pending.verifier,
        }),
      );
      if (!parsed.success) throw new ConnectorError("INVALID_SOURCE");
      const grant = parsed.data;
      pending.check();
      if (
        grant.grantId !== parent.grantId ||
        grant.meetingId !== parent.meetingId ||
        Date.parse(grant.expiresAt) <= this.now() ||
        Date.parse(grant.expiresAt) >
          Math.min(this.now() + 60 * 60000, Date.parse(parent.expiresAt))
      )
        throw new ConnectorError("INVALID_SOURCE");
      const value = Buffer.from(
        JSON.stringify({
          owner: this.owner,
          subjectId: parent.subjectId,
          workspaceId: parent.workspaceId,
          grant,
        }),
      );
      await this.secret.setSecret(value);
      try {
        const verified = await this.secret.getSecret();
        pending.check();
        if (!verified || !value.equals(Buffer.from(verified)))
          throw new ConnectorError("INVALID_CONNECTION");
      } catch (e) {
        await this.secret.deleteCredential();
        throw e;
      }
      return this.status();
    });
  }
  private async withPermission<T>(
    grantId: string,
    approvalId: string | undefined,
    operation: (
      grant: z.infer<typeof grantSchema>,
      check: () => void,
    ) => Promise<T>,
  ) {
    return this.exclusive(async () => {
      const boundary = this.source.captureReadBoundary(),
        saved = await this.saved(),
        parent = await this.parent();
      if (
        !saved ||
        saved.grant.grantId !== grantId ||
        (approvalId && saved.grant.approvalId !== approvalId) ||
        parent.grantId !== grantId ||
        parent.meetingId !== saved.grant.meetingId ||
        parent.subjectId !== saved.subjectId ||
        parent.workspaceId !== saved.workspaceId
      )
        throw new ConnectorError("SOURCE_DENIED");
      const check = () => {
        boundary();
        if (
          Date.parse(saved.grant.expiresAt) <= this.now() ||
          Date.parse(parent.expiresAt) <= this.now()
        )
          throw new ConnectorError("CONNECTION_EXPIRED");
      };
      check();
      return operation(saved.grant, check);
    });
  }
  async inspect(grantId: string, reviewId: string) {
    z.uuid().parse(reviewId);
    return this.withPermission(grantId, undefined, async (grant, check) => {
      const parsed = autoNoteApprovalDetailSchema.safeParse(
        await this.post("approval-review", { reviewId }, grant.token),
      );
      check();
      if (
        !parsed.success ||
        parsed.data.id !== reviewId ||
        ("receipt" in parsed.data
          ? parsed.data.receipt.meetingId
          : parsed.data.meetingId) !== grant.meetingId
      )
        throw new ConnectorError("INVALID_SOURCE");
      return {
        approvalId: grant.approvalId,
        approvalExpiresAt: grant.expiresAt,
        detail: parsed.data,
        check,
      };
    });
  }
  async saveExact(
    grantId: string,
    approvalId: string,
    reviewed: AutoNoteExactReview,
    beforeDispatch: () => void,
  ) {
    const expected = autoNoteExactReviewSchema.parse(reviewed);
    return this.withPermission(grantId, approvalId, async (grant, check) => {
      const fresh = autoNoteExactReviewSchema.safeParse(
        await this.post(
          "approval-review",
          { reviewId: expected.id },
          grant.token,
        ),
      );
      check();
      if (
        !fresh.success ||
        expected.meetingId !== grant.meetingId ||
        JSON.stringify(fresh.data) !== JSON.stringify(expected) ||
        Date.parse(expected.expiresAt) <= this.now()
      )
        throw new ConnectorError("SOURCE_CONFLICT");
      // The caller durably records uncertainty before any save request can leave this process.
      beforeDispatch();
      const parsed = autoNoteReceiptSchema.safeParse(
        await this.post(
          "approval-save",
          {
            reviewId: expected.id,
            digest: expected.digest,
            confirmed: true,
          },
          grant.token,
        ),
      );
      // A successful save may itself change source state or race revocation. Preserve its receipt.
      if (
        !parsed.success ||
        parsed.data.meetingId !== expected.meetingId ||
        parsed.data.operationId !== expected.proposal.operationId ||
        parsed.data.version !== expected.proposal.version + 1
      )
        throw new ConnectorError("INVALID_SOURCE");
      return parsed.data;
    });
  }
  async cancel() {
    return this.exclusive(async () => {
      this.pending = undefined;
    });
  }
  /** Local removal only. Source revocation remains on the AutoNote permission page. */
  async forgetLocal() {
    return this.exclusive(async () => {
      this.pending = undefined;
      await this.secret.deleteCredential();
      if (await this.secret.getSecret())
        throw new ConnectorError("INVALID_CONNECTION");
    });
  }
}
