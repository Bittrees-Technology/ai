import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { canonical } from "../contracts/canonical-json.js";
const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const base = {
  connectionId: z.uuid(),
  workflowId: z.string().min(1).max(128),
  operationId: z.uuid(),
};
const evidence = z.strictObject({
  model: z.string().min(1).max(160),
  modelDigest: z.string().min(1).max(160),
  inputHash: hex,
  output: z.string().min(1).max(16000),
});
const operation = z.discriminatedUnion("name", [
  z.strictObject({
    name: z.literal("workflow_claim"),
    arguments: z.strictObject(base),
  }),
  z.strictObject({
    name: z.literal("workflow_renew"),
    arguments: z.strictObject({ ...base, jobId: z.uuid(), leaseId: z.uuid() }),
  }),
  z.strictObject({
    name: z.literal("workflow_complete"),
    arguments: z.strictObject({
      ...base,
      jobId: z.uuid(),
      leaseId: z.uuid(),
      evidence,
    }),
  }),
]);
const proofRequest = z.strictObject({
  version: z.literal(1),
  source: z.literal("mcp.bittrees.org"),
  audience: z.literal("https://roles.bittrees.org/api/authority/mcp-decision"),
  requestId: z.uuid(),
  operationId: z.uuid(),
  parametersDigest: hex,
  issuedAt: z.number().int().nonnegative(),
  principal: z.string().regex(/^agent:[a-f0-9-]{36}$/),
  credentialId: hex,
  delegationId: z.uuid(),
  tenant: z.string().min(1).max(128),
  workspace: z.string().min(1).max(128),
  project: z.literal("workflow"),
  resource: z.string().min(1).max(137),
  action: z.enum(["workflow:claim", "workflow:renew", "workflow:complete"]),
  stage: z.literal("execute"),
});
export const centralNativeInputSchema = z.strictObject({
  rpc: z.strictObject({
    jsonrpc: z.literal("2.0"),
    id: z.uuid(),
    method: z.literal("tools/call"),
    params: operation,
  }),
  proof: z.strictObject({
    request: proofRequest,
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  }),
});
export const centralNativeScopeSchema = z.strictObject({
  epoch: z.uuid(),
  approvedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  principal: z.string().regex(/^agent:[a-f0-9-]{36}$/),
  publicKey: z.string().min(32).max(512),
  credentialId: hex,
  delegationId: z.uuid(),
  tenant: z.string().min(1).max(128),
  workspace: z.string().min(1).max(128),
  workflowId: base.workflowId,
  connectionId: z.uuid(),
});
export type CentralNativeScope = z.infer<typeof centralNativeScopeSchema>;
/** Native-only request preparation. A scope is an explicit local transport review,
 * never a Roles decision or source grant. The gateway must still obtain current
 * Roles/source authorization for every action. No requests or credentials are
 * created here. The owner supplies durable call-budget reservation separately.
 */
export class CentralTransportPlan {
  private readonly scope: CentralNativeScope;
  private readonly scopeDigest: string;
  constructor(
    private current: () => CentralNativeScope | null,
    private now = Date.now,
  ) {
    this.scope = centralNativeScopeSchema.parse(current());
    this.scopeDigest = hash(this.scope);
    const key = createPublicKey(this.scope.publicKey);
    if (
      key.asymmetricKeyType !== "ed25519" ||
      key.export({ type: "spki", format: "pem" }) !== this.scope.publicKey ||
      createHash("sha256").update(this.scope.publicKey).digest("hex") !==
        this.scope.credentialId
    )
      throw Error("Central native identity binding invalid");
    this.assertCurrent();
  }
  assertCurrent() {
    const time = this.now(),
      scope = centralNativeScopeSchema.parse(this.current());
    if (
      !Number.isSafeInteger(time) ||
      time < scope.approvedAt ||
      time >= scope.expiresAt ||
      scope.expiresAt - scope.approvedAt > 3600000 ||
      hash(scope) !== this.scopeDigest
    )
      throw Error(
        "Central native transport review expired, revoked or changed",
      );
  }
  prepare(raw: unknown) {
    this.assertCurrent();
    const input = centralNativeInputSchema.parse(raw),
      p = input.proof.request,
      a = input.rpc.params.arguments;
    const tool = input.rpc.params.name,
      action = "workflow:" + tool.slice("workflow_".length);
    const s = this.scope;
    if (
      p.principal !== s.principal ||
      p.credentialId !== s.credentialId ||
      p.delegationId !== s.delegationId ||
      p.tenant !== s.tenant ||
      p.workspace !== s.workspace ||
      p.resource !== "workflow:" + s.workflowId ||
      p.action !== action ||
      a.workflowId !== s.workflowId ||
      a.connectionId !== s.connectionId ||
      p.operationId !== a.operationId ||
      p.parametersDigest !== hash({ tool, arguments: a }) ||
      p.issuedAt > this.now() + 5000 ||
      this.now() - p.issuedAt > 15000 ||
      !verify(
        null,
        Buffer.from("Bittrees MCP authority request v1\n" + canonical(p)),
        s.publicKey,
        Buffer.from(input.proof.signature, "base64"),
      )
    )
      throw Error(
        "Central native request does not match reviewed signed scope",
      );
    const body = JSON.stringify(input.rpc);
    if (Buffer.byteLength(body) > 64000)
      throw Error("Central native request too large");
    return {
      epoch: s.epoch,
      requestId: p.requestId,
      operationId: a.operationId,
      url: "https://mcp.bittrees.org/mcp?mode=selected&projects=workflow" as const,
      method: "POST" as const,
      redirect: "error" as const,
      timeoutMs: Math.min(20000, s.expiresAt - this.now()),
      maximumResponseBytes: 64000 as const,
      body,
      proof: Buffer.from(JSON.stringify(input.proof)).toString("base64url"),
    };
  }
}
