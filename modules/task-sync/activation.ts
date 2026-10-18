import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { canonical } from "../contracts/canonical-json.js";
import {
  activationReceiptSchema,
  activationReceiptMessage,
} from "./runtime-contract.js";
import {
  activeLease,
  validateChallenge,
  type SyncIdentity,
  type SyncTask,
} from "./proof-contract.js";
export type ActivationScope = Omit<
  SyncIdentity,
  "activatedAt" | "expiresAt"
> & { policyDigest: string; projectIds: string[] };
const envelope = z.strictObject({
  receipt: activationReceiptSchema,
  signature: z.string().max(200),
});
/** Receipt proves the original activation only; gateway reauthorizes current access before releasing any credential. */
export function verifyActivationReceipt(
  raw: unknown,
  expected: ActivationScope,
  rolesPublicKey: string,
  now = Date.now(),
) {
  const signed = envelope.parse(raw),
    r = signed.receipt,
    key = createPublicKey(rolesPublicKey);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !verify(
      null,
      Buffer.from(activationReceiptMessage(r)),
      key,
      Buffer.from(signed.signature, "base64"),
    )
  )
    throw Error("Roles activation signature rejected");
  for (const field of [
    "principal",
    "credentialId",
    "tenant",
    "workspace",
    "leaseId",
    "runtimeBindingDigest",
    "policyDigest",
    "sourceWorkspace",
  ] as const)
    if (r[field] !== expected[field])
      throw Error("Activation differs from reviewed scope");
  if (expected.subject !== r.principal)
    throw Error("Activation subject differs");
  const identity: SyncIdentity = {
    principal: r.principal,
    credentialId: r.credentialId,
    tenant: r.tenant,
    workspace: r.workspace,
    sourceWorkspace: expected.sourceWorkspace,
    subject: expected.subject,
    leaseId: r.leaseId,
    runtimeBindingDigest: r.runtimeBindingDigest,
    activatedAt: Date.parse(r.activatedAt),
    expiresAt: Date.parse(r.expiresAt),
  };
  activeLease(identity, now);
  return { signed, identity };
}
export async function exchangeActivation(
  raw: unknown,
  expected: ActivationScope,
  rolesPublicKey: string,
  task: SyncTask,
  signAndAttest: (
    challenge: ReturnType<typeof validateChallenge>,
    identity: SyncIdentity,
    signal: AbortSignal,
  ) => Promise<unknown>,
  request: typeof fetch = fetch,
  now = () => Date.now(),
) {
  const { signed, identity } = verifyActivationReceipt(
    raw,
    expected,
    rolesPublicKey,
    now(),
  );
  const signal = AbortSignal.timeout(
    Math.max(1, Math.min(20000, identity.expiresAt - now())),
  );
  let proof: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    activeLease(identity, now());
    const response = await request(
      "https://mcp.bittrees.org/v1/task-sync/connect",
      {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          leaseReceipt: signed,
          ...(proof ? { proof } : {}),
        }),
      },
    );
    const reader = response.body?.getReader();
    if (!reader) throw Error("Missing activation response");
    let length = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        length += r.value.length;
        if (length > 64000) throw Error("Activation response too large");
        chunks.push(r.value);
      }
    } finally {
      await reader.cancel();
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (response.status === 428 && attempt === 0) {
      const challenge = validateChallenge(
        body.challenge,
        identity,
        task,
        undefined,
        now(),
      );
      if (challenge.parameters.tool !== "projects.list")
        throw Error("Unexpected activation operation");
      proof = await signAndAttest(challenge, identity, signal);
      continue;
    }
    if (!response.ok) throw Error("Activation connection denied");
    const result = z
      .strictObject({
        identity: z.record(z.string(), z.unknown()),
        token: z.string().min(16).max(4096).regex(/^\S+$/),
        projectIds: z.array(z.string()).max(100),
        permissions: z.array(z.string()).max(3),
      })
      .parse(body);
    if (
      canonical(result.identity) !== canonical(identity) ||
      canonical([...result.projectIds].sort()) !==
        canonical([...expected.projectIds].sort()) ||
      canonical([...result.permissions].sort()) !==
        canonical(["catalog:read", "task-sync:read", "task-sync:write"])
    )
      throw Error("Gateway connection differs from activation");
    activeLease(identity, now());
    return { identity, token: result.token };
  }
  throw Error("Activation challenge limit reached");
}
