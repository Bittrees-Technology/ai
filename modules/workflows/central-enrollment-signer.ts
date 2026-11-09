import Database from "better-sqlite3";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
} from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { z } from "zod";
import { Vault } from "../storage/vault.js";
import { canonical } from "../contracts/canonical-json.js";
import { readCentralIdentity } from "./central-identity-review.js";
import {
  runtimeEnrollmentSchema,
  runtimeEnrollmentMessage,
  runtimeHandoffSchema,
  runtimeHandoffMessage,
  runtimeReconciliationRequest,
  runtimeReconciliationMessage,
} from "../task-sync/runtime-contract.js";

export const centralEnrollmentSigningScope = runtimeEnrollmentSchema
  .pick({
    principal: true,
    publicKey: true,
    authorityId: true,
    deviceId: true,
    sourceWorkspace: true,
  })
  .extend({
    purpose: z.literal("central-workflows"),
    epoch: z.uuid(),
    credentialId: z.string().regex(/^[a-f0-9]{64}$/),
    ownerWallet: z.string().regex(/^0x[a-f0-9]{40}$/),
    expiresAt: z.int().positive(),
    approvedChallenge: runtimeEnrollmentSchema.optional(),
  })
  .strict();
const hash = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");

/** Trusted native owner only. The callback supplies an approved native review
 * and, later, the exact challenge validated by the authenticated Roles session.
 * Core/model callers cannot supply a message, key, profile ID or challenge here.
 * Existing central state is opened read-only: no identity creation, task-sync
 * fallback, configuration/grants, credential export or network operation. */
export function centralEnrollmentSigner(
  path: string,
  vault: Vault,
  current: () => unknown,
  now = Date.now,
) {
  const initial = centralEnrollmentSigningScope.parse(current());
  const { approvedChallenge: _challenge, ...base } = initial;
  const scopeHash = hash(base);
  const scope = () => {
    const value = centralEnrollmentSigningScope.parse(current());
    const { approvedChallenge: _challenge, ...live } = value;
    const at = now();
    if (
      hash(live) !== scopeHash ||
      !Number.isSafeInteger(at) ||
      value.expiresAt <= at ||
      value.expiresAt > at + 300000
    )
      throw Error("Current exact central enrollment review required");
    return value;
  };
  const identity = () => {
    const review = scope(),
      saved = readCentralIdentity(path, vault);
    if (
      saved.status !== "existing" ||
      saved.principal !== review.principal ||
      saved.publicKey !== review.publicKey ||
      saved.credentialId !== review.credentialId
    )
      throw Error("Existing central enrollment identity differs from review");
    return saved;
  };
  const signed = (request: unknown, message: string) => {
    const saved = identity(),
      before = lstatSync(path);
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      return db.transaction(() => {
        const row = db
          .prepare(
            "SELECT CASE WHEN length(value)<=16384 THEN value ELSE NULL END AS value FROM state WHERE key='identity'",
          )
          .get() as { value: Buffer | null } | undefined;
        if (!row || !Buffer.isBuffer(row.value))
          throw Error("Existing central identity required");
        const value = z
          .strictObject({
            principal: z.string(),
            publicKey: z.string(),
            privateKey: z.string().max(4096),
            credentialId: z.string(),
          })
          .parse(vault.open(row.value, "central-workflows:identity"));
        const key = createPrivateKey(value.privateKey);
        if (
          value.principal !== saved.principal ||
          value.publicKey !== saved.publicKey ||
          value.credentialId !== saved.credentialId ||
          key.asymmetricKeyType !== "ed25519" ||
          createPublicKey(key).export({ type: "spki", format: "pem" }) !==
            saved.publicKey
        )
          throw Error("Central enrollment signing custody changed");
        scope();
        const after = lstatSync(path);
        if (
          after.ino !== before.ino ||
          after.dev !== before.dev ||
          after.isSymbolicLink() ||
          realpathSync(path) !== path
        )
          throw Error("Central enrollment state path changed");
        return {
          request,
          signature: sign(null, Buffer.from(message), key).toString("base64"),
        };
      })();
    } finally {
      db.close();
    }
  };
  identity();
  return {
    identity,
    start() {
      const review = scope();
      const request = runtimeHandoffSchema.parse({
        version: 1,
        kind: "enroll",
        audience: "https://mcp.bittrees.org",
        principal: review.principal,
        publicKey: review.publicKey,
        authorityId: review.authorityId,
        deviceId: review.deviceId,
        sourceWorkspace: review.sourceWorkspace,
        ownerWallet: review.ownerWallet,
        issuedAt: now(),
        nonce: randomUUID(),
      });
      return signed(request, runtimeHandoffMessage(request));
    },
    startFor(raw: unknown) {
      const review = scope(),
        request = runtimeHandoffSchema.parse(raw);
      if (
        request.kind !== "enroll" ||
        Math.abs(now() - request.issuedAt) > 15000 ||
        [
          "principal",
          "publicKey",
          "authorityId",
          "deviceId",
          "sourceWorkspace",
          "ownerWallet",
        ].some(
          (k) =>
            request[k as keyof typeof request] !==
            review[k as keyof typeof review],
        )
      )
        throw Error("Exact central enrollment handoff required");
      return signed(request, runtimeHandoffMessage(request));
    },
    reconcile(raw: unknown) {
      const request = runtimeReconciliationRequest.parse(raw);
      if (Math.abs(now() - request.issuedAt) > 15000)
        throw Error("Fresh native reconciliation proof required");
      return signed(request, runtimeReconciliationMessage(request));
    },
    approved() {
      const review = scope(),
        request = runtimeEnrollmentSchema.parse(review.approvedChallenge);
      if (
        Math.abs(now() - request.issuedAt) > 15000 ||
        [
          "principal",
          "publicKey",
          "authorityId",
          "deviceId",
          "sourceWorkspace",
        ].some(
          (k) =>
            request[k as keyof typeof request] !==
            review[k as keyof typeof review],
        )
      )
        throw Error(
          "Authenticated owner challenge differs from central review",
        );
      return signed(request, runtimeEnrollmentMessage(request));
    },
  };
}
