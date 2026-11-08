import { readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  NativeRuntimeCostBudget,
  nativeRuntimeCostApproval,
} from "../../modules/task-sync/native-runtime-cost.js";
import { Vault } from "../../modules/storage/vault.js";
import {
  loadStorageKey,
  macKeychainEntry,
} from "../../modules/storage/keychain.js";
import { EnrollmentService } from "../../modules/task-sync/enrollment-service.js";
import { savedEnrollmentIdentity } from "../../modules/task-sync/enrollment-saved-identity.js";
import { existingEnrollmentCredential } from "../../modules/task-sync/enrollment-credential.js";
import { nativeEnrollmentSessionFactory } from "../../modules/task-sync/enrollment-native-session.js";
import { nativeCentralEnrollmentSessionFactory } from "../../modules/workflows/central-enrollment-session.js";
import { readCentralIdentity } from "../../modules/workflows/central-identity-review.js";
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
// Public source signer independently matched to the existing deployment receipt.
const signer =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAkBN/mwSFqVGMc7NfiY0pOUhk6FPZv1So5PGXo1w5WU8=\n-----END PUBLIC KEY-----\n";
const commonConfiguration = z.strictObject({
  version: z.literal(1),
  authorityId: z.uuid(),
  deviceId: z.uuid(),
  ownerWallet: z.string().regex(/^0x[a-f0-9]{40}$/),
  credentialDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceAccessApproved: z.literal(true),
  costBasis: z.enum(["verified-included-usage", "explicit-one-time-approval"]),
  runtimeApproval: nativeRuntimeCostApproval.optional(),
  evidenceId: z.string().min(1).max(128),
  approvedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});
const configuration = z
  .union([
    commonConfiguration.extend({
      purpose: z.literal("task-sync").optional(),
      identityDigest: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    commonConfiguration.extend({
      purpose: z.literal("central-workflows"),
      principal: z.string().regex(/^agent:[a-f0-9-]{36}$/),
      credentialId: z.string().regex(/^[a-f0-9]{64}$/),
      sourceWorkspace: z.uuid(),
    }),
  ])
  .refine(
    (c) =>
      c.costBasis === "verified-included-usage"
        ? c.runtimeApproval === undefined
        : c.runtimeApproval !== undefined &&
          c.runtimeApproval.approvedAt <= c.approvedAt &&
          c.runtimeApproval.expiresAt >= c.expiresAt,
    "Actual included coverage or exact explicit aggregate approval required",
  );
function readConfiguration(path: string) {
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 8192 ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw Error("Native enrollment configuration protection invalid");
  return readFileSync(path);
}
/** Optional native-only enrollment bootstrap. No configuration means no Keychain,
 * sockets or source requests. An operator must establish actual source/cost
 * evidence before writing the bounded configuration; this file creates no grant.
 * Explicit native consent remains required after configuration.
 */
export async function launchEnrollment(
  directory: string,
  unlock: (profile: string) => Promise<Vault> = async (profile) =>
    new Vault(await loadStorageKey(macKeychainEntry(profile), true)),
  now = Date.now,
) {
  const path = join(directory, "native-enrollment.json");
  let bytes: Buffer;
  try {
    bytes = readConfiguration(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const config = configuration.parse(JSON.parse(bytes.toString("utf8")));
  const fingerprint = hash(bytes);
  let credentialSnapshot: { path: string; digest: string } | undefined;
  const credentialBytes = (file: string) => {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536)
      throw Error("Credential file changed");
    return readFileSync(file);
  };
  const admitted = () => {
    try {
      const time = now();
      return (
        Number.isSafeInteger(time) &&
        time >= config.approvedAt &&
        time < config.expiresAt &&
        config.expiresAt - config.approvedAt <= 3600000 &&
        hash(readConfiguration(path)) === fingerprint &&
        (!credentialSnapshot ||
          hash(credentialBytes(credentialSnapshot.path)) ===
            credentialSnapshot.digest)
      );
    } catch {
      return false;
    }
  };
  if (!admitted()) throw Error("Native enrollment approval expired or changed");
  const vault = await unlock("personal");
  const costs = config.runtimeApproval
    ? new NativeRuntimeCostBudget(
        directory,
        vault,
        config.runtimeApproval,
        () => {
          if (!admitted())
            throw Error("Native enrollment source/cost admission changed");
        },
        now,
      )
    : undefined;
  let coordinator: Vault | undefined;
  try {
    lstatSync(join(directory, "marketplace/connection.enc"));
    coordinator = await unlock("marketplace-coordinator");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const credentialPath = coordinator
    ? join(directory, "marketplace/connection.enc")
    : join(directory, "workflow-device.enc");
  credentialSnapshot = {
    path: credentialPath,
    digest: hash(credentialBytes(credentialPath)),
  };
  const token = await existingEnrollmentCredential(
    directory,
    vault,
    coordinator,
  );
  if (hash(token) !== config.credentialDigest || !admitted())
    throw Error("Native enrollment credential binding changed");
  const scope = () => {
    let identity: {
      principal: string;
      publicKey: string;
      sourceWorkspace: string;
    };
    if (config.purpose === "central-workflows") {
      const saved = readCentralIdentity(
        join(directory, "central-workflows.db"),
        vault,
      );
      if (
        saved.status !== "existing" ||
        saved.principal !== config.principal ||
        saved.credentialId !== config.credentialId
      )
        throw Error(
          "Existing central-purpose enrollment identity differs from review",
        );
      identity = {
        principal: saved.principal,
        publicKey: saved.publicKey,
        sourceWorkspace: config.sourceWorkspace,
      };
    } else {
      identity = savedEnrollmentIdentity(
        join(directory, "task-sync.db"),
        vault,
      );
      if (hash(JSON.stringify(identity)) !== config.identityDigest)
        throw Error("Native enrollment identity binding changed");
    }
    return {
      ...identity,
      authorityId: config.authorityId,
      deviceId: config.deviceId,
      ownerWallet: config.ownerWallet,
    };
  };
  scope();
  const purpose = config.purpose ?? "task-sync";
  const factoryOptions = {
    path: join(
      directory,
      purpose === "central-workflows"
        ? "native-central-enrollment.db"
        : "native-enrollment.db",
    ),
    vault,
    pinnedSigner: signer,
    credential: () => token,
    admitted,
    reserveCost: () => costs?.reserve("enrollment"),
    now,
  };
  const factory =
    purpose === "central-workflows"
      ? nativeCentralEnrollmentSessionFactory({
          ...factoryOptions,
          centralStatePath: join(directory, "central-workflows.db"),
        })
      : nativeEnrollmentSessionFactory(factoryOptions);
  const service = new EnrollmentService(
    scope,
    admitted,
    factory,
    now,
    () => config.runtimeApproval ?? null,
    purpose,
  );
  try {
    const endpoints = await service.listen();
    return {
      service,
      environment: {
        BITTREES_ENROLLMENT_PURPOSE: purpose,
        BITTREES_ENROLLMENT_CONTROL_URL: endpoints.native.url,
        BITTREES_ENROLLMENT_CONTROL_TOKEN: endpoints.native.token,
        BITTREES_ENROLLMENT_HELPER_URL: endpoints.core.url,
        BITTREES_ENROLLMENT_HELPER_TOKEN: endpoints.core.token,
      },
    };
  } catch (error) {
    await service.close();
    throw error;
  }
}
