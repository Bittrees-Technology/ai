import { createHash } from 'node:crypto';
import { canonical } from './signed-action.mjs';

// Review documents only. These helpers never sign, authorize, compile module
// calldata, establish ownership, or treat a caller's document as chain evidence.
export const AGENT_WALLET_POLICY_SCHEMA = 'bittrees.agent.wallet-policy.v1';
export const AGENT_WALLET_DEFAULT_DURATION = Object.freeze({ kind: 'until-revoked' });
const invalid = () => { throw new Error('Invalid agent wallet permission review.'); };
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype
  && Object.keys(v).sort().join('|') === [...keys].sort().join('|');
const address = v => typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v) && !/^0x0{40}$/.test(v);
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const uint = (v, positive = false) => typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v)
  && BigInt(v) < 2n ** 256n && (!positive || BigInt(v) > 0n);
const unique = (items, key = v => canonical(v)) => new Set(items.map(key)).size === items.length;
const list = (items, max) => Array.isArray(items) && items.length <= max;

function validateSignIn(rule) {
  if (!exact(rule, ['domain', 'uri']) || typeof rule.domain !== 'string' || typeof rule.uri !== 'string') invalid();
  let url;
  try { url = new URL(rule.uri); } catch { invalid(); }
  // Exact HTTPS origin and URI, no wildcard, credentials, fragments or ports.
  if (url.protocol !== 'https:' || url.host !== rule.domain || url.port || url.username || url.password || url.hash
    || url.href !== rule.uri || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+bittrees\.org$/.test(rule.domain)) invalid();
}

function validateCall(rule, policy) {
  if (!exact(rule, ['ruleId', 'target', 'calldata', 'maxNativeValue', 'maxNativePerPeriod', 'assetLimits', 'maxCallsPerPeriod', 'gasLimit', 'maxFeePerGas'])
    || typeof rule.ruleId !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(rule.ruleId)
    || !address(rule.target) || rule.target === policy.safe || rule.target === policy.signer
    || typeof rule.calldata !== 'string' || !/^0x(?:[0-9a-f]{2}){4,4096}$/.test(rule.calldata)
    || !uint(rule.maxNativeValue) || !uint(rule.maxNativePerPeriod)
    || BigInt(rule.maxNativeValue) > BigInt(rule.maxNativePerPeriod) || BigInt(rule.maxNativePerPeriod) > BigInt(policy.nativeBudgetPerPeriod)
    || !uint(rule.gasLimit, true) || !uint(rule.maxFeePerGas, true)
    || !integer(rule.maxCallsPerPeriod, 1, 1000000)
    || !list(rule.assetLimits, 20) || !unique(rule.assetLimits, v => v.token)) invalid();
  for (const limit of rule.assetLimits) {
    const budget = policy.assetBudgets.find(b => b.token === limit.token);
    if (!exact(limit, ['token', 'maxPerTransaction', 'maxPerPeriod']) || !address(limit.token) || !budget
      || !uint(limit.maxPerTransaction, true) || !uint(limit.maxPerPeriod, true)
      || BigInt(limit.maxPerTransaction) > BigInt(limit.maxPerPeriod) || BigInt(limit.maxPerPeriod) > BigInt(budget.maxPerPeriod)) invalid();
  }
}

export function validateAgentWalletPolicy(policy) {
  if (!exact(policy, ['schema', 'agentId', 'revision', 'chainId', 'safe', 'signer', 'duration', 'signIns', 'calls', 'periodSeconds', 'nativeBudgetPerPeriod', 'assetBudgets', 'administration', 'delegatecall', 'unknownCalls'])
    || policy.schema !== AGENT_WALLET_POLICY_SCHEMA || typeof policy.agentId !== 'string'
    // agentId is the enrolled Roles MCP agent principal, not a public Agent
    // profile ID. Ownership and any association must be independently verified.
    || !/^agent:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(policy.agentId)
    || !integer(policy.revision, 1, Number.MAX_SAFE_INTEGER) || policy.chainId !== 1
    || !address(policy.safe) || !address(policy.signer) || policy.safe === policy.signer
    || policy.administration !== 'safe-threshold' || policy.delegatecall !== 'deny' || policy.unknownCalls !== 'deny'
    || !integer(policy.periodSeconds, 60, 31536000) || !uint(policy.nativeBudgetPerPeriod)
    || !list(policy.assetBudgets, 20) || !unique(policy.assetBudgets, v => v.token)
    || !list(policy.signIns, 20) || !unique(policy.signIns)
    || !list(policy.calls, 50) || !unique(policy.calls, v => `${v.target}:${v.calldata}`) || !unique(policy.calls, v => v.ruleId)
    || policy.signIns.length + policy.calls.length === 0) invalid();
  if (!(exact(policy.duration, ['kind']) && policy.duration.kind === 'until-revoked')
    && !(exact(policy.duration, ['kind', 'expiresAt']) && policy.duration.kind === 'expires'
      && integer(policy.duration.expiresAt, 1, Number.MAX_SAFE_INTEGER))) invalid();
  for (const budget of policy.assetBudgets) {
    if (!exact(budget, ['token', 'maxPerPeriod']) || !address(budget.token) || !uint(budget.maxPerPeriod, true)) invalid();
  }
  policy.signIns.forEach(validateSignIn);
  policy.calls.forEach(rule => validateCall(rule, policy));
  if (Buffer.byteLength(canonical(policy)) > 65536) invalid();
  return structuredClone(policy);
}

export function agentWalletPolicyDigest(policy) {
  const checked = validateAgentWalletPolicy(policy);
  return createHash('sha256').update('Bittrees agent wallet permission review v1\n' + canonical(checked)).digest('hex');
}

export function prepareAgentWalletPolicyChange(current, proposed, { now = Date.now() } = {}) {
  const next = validateAgentWalletPolicy(proposed);
  const previous = current === null ? null : validateAgentWalletPolicy(current);
  if (!integer(now, 0, Number.MAX_SAFE_INTEGER) || (next.duration.kind === 'expires' && next.duration.expiresAt <= now)) invalid();
  if (previous ? next.revision !== previous.revision + 1 || ['agentId', 'chainId', 'safe', 'signer', 'periodSeconds'].some(k => next[k] !== previous[k]) : next.revision !== 1) invalid();
  // Stable rule counter identities; removing/re-adding rules must retain the
  // historical counters in the source store. A revision never resets usage.
  for (const rule of next.calls) {
    const old = previous?.calls.find(r => r.ruleId === rule.ruleId || (r.target === rule.target && r.calldata === rule.calldata));
    if (old && (old.ruleId !== rule.ruleId || old.target !== rule.target || old.calldata !== rule.calldata)) invalid();
  }
  const changedFields = ['duration', 'signIns', 'calls', 'nativeBudgetPerPeriod', 'assetBudgets'].filter(k => !previous || canonical(previous[k]) !== canonical(next[k]));
  if (!changedFields.length) invalid();
  return {
    schema: 'bittrees.agent.wallet-policy-change.v1',
    expectedRevision: previous?.revision ?? 0,
    expectedPolicyDigest: previous ? agentWalletPolicyDigest(previous) : null,
    proposedPolicyDigest: agentWalletPolicyDigest(next),
    changedFields,
    current: previous,
    proposed: next,
    status: 'awaiting-wallet-review',
    requiresSafeApproval: true,
    requiresConfirmedOnchainEnforcement: next.calls.length > 0 || Boolean(previous?.calls.length),
    requiresActivationReview: !previous || previous.duration.kind === 'expires' && previous.duration.expiresAt <= now || changedFields.includes('duration'),
    resumesAuthority: false,
    counterMigration: 'preserve-usage-and-tombstones; unix-epoch-period-windows; no-revision-reset',
    activationHolds: ['canonical-contract-and-implementation-provenance', 'semantic-effect-and-budget-enforcement', 'current-source-and-safe-approval', 'confirmed-wallet-policy-readback'],
    grantsAuthority: false,
  };
}

// Presentation only: never use this output as permission to execute. The
// caller must obtain observed state from its reviewed authoritative chain port.
export function agentWalletLifecycleView({ desired, observed, pendingChange = false }) {
  if (!['active', 'suspended', 'revoked'].includes(desired)
    || !['unverified', 'active', 'suspended', 'revoked'].includes(observed) || typeof pendingChange !== 'boolean') invalid();
  if (observed === 'revoked') return { status: 'revoked', label: 'Revoked', grantsAuthority: false };
  if (desired === 'revoked') return { status: 'revocation-pending', label: 'Revocation pending — wallet access is not confirmed stopped', grantsAuthority: false };
  if (desired === 'suspended' && observed !== 'suspended') return { status: 'suspension-pending', label: 'Suspension pending — wallet access is not confirmed stopped', grantsAuthority: false };
  if (observed === 'suspended') return { status: 'suspended', label: desired === 'active' ? 'Suspended — resume requires approval' : 'Suspended', grantsAuthority: false };
  if (observed === 'unverified') return { status: 'unverified', label: 'Wallet permission not verified', grantsAuthority: false };
  return { status: pendingChange ? 'update-pending' : 'active', label: pendingChange ? 'Update pending — existing wallet limits remain in force' : 'Wallet policy confirmed; current execution checks still apply', grantsAuthority: false };
}
