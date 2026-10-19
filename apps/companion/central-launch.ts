import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Vault } from "../../modules/storage/vault.js";
import {
  loadStorageKey,
  macKeychainEntry,
} from "../../modules/storage/keychain.js";
import {
  savedCentralState,
  existingCentralCredential,
} from "../../modules/workflows/central-saved-state.js";
import { centralNativeReviewSchema } from "../../modules/workflows/central-native-owner.js";
import { CentralNativeService } from "../../modules/workflows/central-native-service.js";
import { nativeCentralSessionFactory } from "../../modules/workflows/central-native-session.js";
const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const configuration = z.strictObject({
  version: z.literal(1),
  review: centralNativeReviewSchema,
  stateDigest: hex,
  credentialDigest: hex,
  evidenceDigest: hex,
  sourceAccessApproved: z.literal(true),
});
const evidence = z.strictObject({
  version: z.literal(1),
  id: z.string().min(1).max(128),
  observedAt: z.number().int().nonnegative(),
  validUntil: z.number().int().nonnegative(),
  account: z.string().min(1).max(128),
  project: z.string().min(1).max(128),
  plan: z.string().min(1).max(128),
  services: z.tuple([
    z.literal("mcp.bittrees.org"),
    z.literal("roles.bittrees.org"),
    z.literal("workflow.bittrees.org"),
  ]),
  resourceClass: z.string().min(1).max(256),
  overageControls: z.string().min(1).max(256),
  costBasis: z.enum(["verified-included-usage", "explicit-one-time-approval"]),
  aggregateAttemptCeilingMicroUSD: z.number().int().min(0).max(1000000),
  reference: z.string().min(1).max(1024),
});
function protectedBytes(path: string) {
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    realpathSync(path) !== path ||
    before.size > 16384 ||
    (before.mode & 0o077) !== 0 ||
    before.uid !== process.getuid?.()
  )
    throw Error("Protected native central configuration required");
  const bytes = readFileSync(path),
    after = lstatSync(path);
  if (
    after.ino !== before.ino ||
    after.dev !== before.dev ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs ||
    bytes.length !== before.size
  )
    throw Error("Native central configuration changed during read");
  return bytes;
}
/** Optional trusted-native bootstrap. Missing configuration means no Keychain,
 * socket or source request. Operator must independently verify current account,
 * plan, downstream resource bounds and source scope before writing the protected
 * evidence/configuration. A file/hash grants no Roles/source authority. Exact
 * action-time native approval remains required before any session/request.
 */
export async function launchCentral(
  directory: string,
  unlock: () => Promise<Vault> = async () =>
    new Vault(await loadStorageKey(macKeychainEntry("personal"), true)),
  now = Date.now,
) {
  const path = join(directory, "native-central.json"),
    proofPath = join(directory, "native-central-evidence.json"),
    statePath = join(directory, "central-workflows.db");
  let bytes: Buffer;
  try {
    bytes = protectedBytes(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const config = configuration.parse(JSON.parse(bytes.toString("utf8"))),
    fingerprint = hash(bytes),
    proofBytes = protectedBytes(proofPath),
    proof = evidence.parse(JSON.parse(proofBytes.toString("utf8")));
  const admitted = () => {
    try {
      const time = now(),
        budget = config.review.budget;
      return (
        Number.isSafeInteger(time) &&
        time >= budget.approvedAt &&
        time < budget.expiresAt &&
        budget.expiresAt - budget.approvedAt <= 3600000 &&
        proof.observedAt <= budget.approvedAt &&
        proof.observedAt <= time &&
        proof.validUntil >= budget.expiresAt &&
        proof.validUntil - proof.observedAt <= 3600000 &&
        proof.id === budget.evidenceId &&
        proof.costBasis === budget.costBasis &&
        proof.aggregateAttemptCeilingMicroUSD ===
          budget.attemptCeilingMicroUSD &&
        hash(proofBytes) === config.evidenceDigest &&
        hash(protectedBytes(proofPath)) === config.evidenceDigest &&
        hash(protectedBytes(path)) === fingerprint
      );
    } catch {
      return false;
    }
  };
  if (!admitted())
    throw Error("Current native central source/cost evidence required");
  const vault = await unlock();
  const state = () => {
    const value = savedCentralState(statePath, vault);
    if (hash(JSON.stringify(value)) !== config.stateDigest)
      throw Error("Saved central scope changed");
    return value;
  };
  const credential = () => {
    if (!admitted()) throw Error("Native central admission changed");
    state();
    const token = existingCentralCredential(statePath, vault);
    if (hash(token) !== config.credentialDigest)
      throw Error("Native central credential changed");
    return token;
  };
  const current = () => {
    if (!admitted()) throw Error("Native central admission unavailable");
    const snapshot = state(),
      scope = config.review.scope;
    if (snapshot.mcpCredentialDigest !== config.credentialDigest)
      throw Error("Saved central credential binding changed");
    for (const key of [
      "principal",
      "publicKey",
      "credentialId",
      "tenant",
      "workspace",
      "connectionId",
      "workflowId",
      "delegationId",
    ] as const)
      if (snapshot[key] !== scope[key])
        throw Error("Native central review does not match saved scope");
    return config.review;
  };
  current();
  const service = new CentralNativeService(
    current,
    admitted,
    nativeCentralSessionFactory({
      path: join(directory, "native-central-budget.db"),
      vault,
      credential,
      admitted,
      now,
    }),
    now,
  );
  try {
    const endpoints = await service.listen();
    return {
      service,
      environment: {
        BITTREES_CENTRAL_CONTROL_URL: endpoints.native.url,
        BITTREES_CENTRAL_CONTROL_TOKEN: endpoints.native.token,
        BITTREES_CENTRAL_HELPER_URL: endpoints.core.url,
        BITTREES_CENTRAL_HELPER_TOKEN: endpoints.core.token,
      },
    };
  } catch (error) {
    await service.close();
    throw error;
  }
}
