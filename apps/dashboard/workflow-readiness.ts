export type WorkflowReadiness = {
  version: 1;
  nativeTransportAvailable: boolean;
  sourceStatusVerified: false;
};
/** No remote fallback: the local capability check must precede source status. */
export async function readWorkflowPermissions(
  api: (path: string) => Promise<any>,
) {
  const readiness = await api("/v1/workflows/readiness");
  if (
    readiness?.version !== 1 ||
    typeof readiness.nativeTransportAvailable !== "boolean" ||
    readiness.sourceStatusVerified !== false
  )
    throw Error("Workflow readiness is unavailable");
  const result = {
    readiness: readiness as WorkflowReadiness,
    data: null as any,
    sourceUnavailable: false,
  };
  if (!readiness.nativeTransportAvailable) return result;
  try {
    result.data = await api("/v1/workflows");
  } catch {
    result.sourceUnavailable = true;
  }
  return result;
}
export function ownerReviewReady(
  readiness: WorkflowReadiness | null,
  data: any,
  now = Date.now(),
) {
  const grant = data?.grant;
  if (grant?.approval_expires_at != null) {
    const expiry = Date.parse(grant.approval_expires_at);
    if (!Number.isFinite(expiry) || expiry <= now) return false;
  }
  return (
    readiness?.nativeTransportAvailable === true &&
    !!grant?.signed_at &&
    typeof grant.wallet_address === "string" &&
    /^0x[a-fA-F0-9]{40}$/.test(grant.wallet_address) &&
    !grant.paused_at &&
    !grant.revoked_at
  );
}
