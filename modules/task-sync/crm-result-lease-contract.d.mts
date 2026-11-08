export type CrmResultLeaseProof = {
  version: 1;
  issuer: "https://workflow.bittrees.org";
  audience: "https://crm.bittrees.org";
  kind: "crm-result-lease";
  state: "running" | "completed";
  assignmentDigest: string;
  connectionId: string;
  runId: string;
  leaseId: string;
  crmOperationId: string;
  operation: "write" | "receipt" | "complete" | "completion";
  authorityOperationId: string;
  resultDigest: string;
  principal: string;
  credentialId: string;
  runtimeLeaseId: string;
  runtimeBindingDigest: string;
  tenant: string;
  workspace: string;
  authorityRequestId: string;
  issuedAt: number;
  expiresAt: number;
};
export declare function crmResultLeaseMessage(proof: unknown): string;
export declare function verifyCrmResultLease(
  envelope: unknown,
  expected: Omit<
    CrmResultLeaseProof,
    "version" | "issuer" | "audience" | "kind" | "issuedAt" | "expiresAt"
  >,
  publicKey: string,
  now?: number,
): CrmResultLeaseProof;
