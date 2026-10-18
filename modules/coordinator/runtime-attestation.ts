import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { canonical } from "../contracts/canonical-json.js";
import { digest, requestSchema } from "../task-sync/proof-contract.js";
import {
  runtimeEnrollmentSchema,
  leaseActivationSchema,
  runtimeAttestationSchema,
  runtimeEnrollmentMessage,
  leaseActivationMessage,
  runtimeAttestationMessage,
} from "../task-sync/runtime-contract.js";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
/** Registration evidence only, never hardware or build attestation. No execution grant is issued here. */
export async function attestRuntime(
  pool: Pool,
  token: string,
  raw: unknown,
  privateKey = process.env.AI_RUNTIME_ATTESTATION_PRIVATE_KEY,
) {
  const body = z
    .strictObject({
      purpose: z.enum(["enroll", "activate", "decision"]),
      request: z.unknown(),
      signature: z.string().max(200),
    })
    .parse(raw);
  if (!/^[a-f0-9]{64}$/.test(token) || !privateKey)
    throw Error("RUNTIME_ATTESTATION_UNAVAILABLE");
  const signer = createPrivateKey(privateKey);
  if (signer.asymmetricKeyType !== "ed25519")
    throw Error("RUNTIME_ATTESTATION_UNAVAILABLE");
  const r =
    body.purpose === "enroll"
      ? runtimeEnrollmentSchema.parse(body.request)
      : body.purpose === "activate"
        ? leaseActivationSchema.parse(body.request)
        : requestSchema.parse(body.request);
  if (Math.abs(Date.now() - r.issuedAt) > 15000)
    throw Error("STALE_DEVICE_PROOF");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const g = (
      await client.query(
        "SELECT id,device_id,wallet_address,paused_at,revoked_at,signed_at,approval_expires_at FROM workflow_authorities WHERE control_hash=$1 FOR SHARE",
        [hash(token)],
      )
    ).rows[0];
    if (
      !g ||
      !g.wallet_address ||
      !g.signed_at ||
      g.paused_at ||
      g.revoked_at ||
      (g.approval_expires_at && Date.parse(g.approval_expires_at) <= Date.now())
    )
      throw Error("DEVICE_AUTHORITY_INACTIVE");
    let binding: any;
    if (body.purpose === "enroll") {
      const e = runtimeEnrollmentSchema.parse(r);
      if (e.authorityId !== g.id || e.deviceId !== g.device_id)
        throw Error("DEVICE_BINDING_MISMATCH");
      const k = createPublicKey(e.publicKey);
      if (
        k.asymmetricKeyType !== "ed25519" ||
        !verify(
          null,
          Buffer.from(runtimeEnrollmentMessage(e)),
          k,
          Buffer.from(body.signature, "base64"),
        )
      )
        throw Error("DEVICE_PROOF_REJECTED");
      const publicKey = k.export({ format: "pem", type: "spki" }).toString(),
        credentialId = hash(publicKey);
      const rows = await client.query(
        "INSERT INTO workflow_runtime_keys(principal,authority_id,device_id,public_key,credential_id,source_workspace,owner_wallet) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(principal) DO UPDATE SET principal=excluded.principal WHERE workflow_runtime_keys.authority_id=excluded.authority_id AND workflow_runtime_keys.device_id=excluded.device_id AND workflow_runtime_keys.credential_id=excluded.credential_id AND workflow_runtime_keys.source_workspace=excluded.source_workspace AND workflow_runtime_keys.owner_wallet=excluded.owner_wallet RETURNING *",
        [
          e.principal,
          g.id,
          g.device_id,
          publicKey,
          credentialId,
          e.sourceWorkspace,
          g.wallet_address,
        ],
      );
      binding = rows.rows[0];
      if (!binding) throw Error("IMMUTABLE_DEVICE_BINDING");
    } else {
      binding = (
        await client.query(
          "SELECT * FROM workflow_runtime_keys WHERE principal=$1 AND authority_id=$2 FOR SHARE",
          [r.principal, g.id],
        )
      ).rows[0];
      if (
        !binding ||
        binding.device_id !== g.device_id ||
        binding.owner_wallet !== g.wallet_address ||
        binding.credential_id !== ("credentialId" in r ? r.credentialId : null)
      )
        throw Error("DEVICE_BINDING_MISMATCH");
      const message =
        body.purpose === "activate"
          ? leaseActivationMessage(r)
          : "Bittrees MCP authority request v1\n" + canonical(r);
      if (
        !verify(
          null,
          Buffer.from(message),
          createPublicKey(binding.public_key),
          Buffer.from(body.signature, "base64"),
        )
      )
        throw Error("DEVICE_PROOF_REJECTED");
    }
    const issuedAt = Date.now();
    if (issuedAt - r.issuedAt > 15000) throw Error("STALE_DEVICE_PROOF");
    const request = runtimeAttestationSchema.parse({
      version: 1,
      issuer: "https://ai.bittrees.org",
      audience: "https://roles.bittrees.org",
      purpose: body.purpose,
      requestDigest: digest(r),
      authorityId: g.id,
      deviceId: g.device_id,
      ownerWallet: g.wallet_address,
      principal: r.principal,
      credentialId: binding.credential_id,
      sourceWorkspace: binding.source_workspace,
      issuedAt,
      expiresAt: issuedAt + 15000,
      nonce: randomUUID(),
    });
    const signature = sign(
      null,
      Buffer.from(runtimeAttestationMessage(request)),
      signer,
    ).toString("base64");
    await client.query("COMMIT");
    return { request, signature };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
