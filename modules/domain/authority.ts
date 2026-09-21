import type { Authority } from "../contracts/index.js";
export interface Scope {
  userId: string;
  subjectId: string;
  tenantId: string;
  sourceApp: string;
  expiresAt: number;
  revoked: boolean;
  delegationAllowed: boolean;
  actions: readonly string[];
  resourceIds: readonly string[];
}
export interface Action {
  app: string;
  resourceId: string;
  action: string;
}
/** Inputs must come from current verified source adapters, not caller-supplied claims. */
export function isAuthorized(
  actor: Authority,
  action: Action,
  scopes: {
    source: Scope;
    delegation: Scope;
    connector: Scope;
    policy: Scope;
  },
  now: number,
): boolean {
  return Object.values(scopes).every(
    (s) =>
      s.userId === actor.userId &&
      s.subjectId === actor.subjectId &&
      s.tenantId === actor.tenantId &&
      s.sourceApp === actor.sourceApp &&
      s.sourceApp === action.app &&
      !s.revoked &&
      s.delegationAllowed &&
      Number.isFinite(s.expiresAt) &&
      s.expiresAt > now &&
      s.actions.includes(action.action) &&
      s.resourceIds.includes(action.resourceId),
  );
}
