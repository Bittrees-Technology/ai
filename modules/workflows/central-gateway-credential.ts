import Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  lstatSync,
  openSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { Vault } from "../storage/vault.js";
import { canonical } from "../contracts/canonical-json.js";
import { readCentralIdentity } from "./central-identity-review.js";
import { centralEnrollmentRecordSchema } from "./central-enrollment-owner.js";
import { centralEnrollmentStatus } from "./central-enrollment-contract.js";

const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const enrollment = centralEnrollmentStatus.shape.enrollment.unwrap();
export type CompletedCentralEnrollment = z.infer<typeof enrollment>;
const record = z.strictObject({
  enrollment,
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  createdAt: z.int().positive(),
});
function protectedFile(path: string, optional = false, maximumBytes = 1048576) {
  try {
    const s = lstatSync(path);
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      realpathSync(path) !== path ||
      s.uid !== process.getuid?.() ||
      (s.mode & 0o077) !== 0 ||
      s.size > maximumBytes
    )
      throw Error("Protected native gateway state required");
    return s;
  } catch (e) {
    if (optional && (e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
/** Historical enrollment proof only, read inside native custody. Neither an
 * operator draft nor the core's status projection can substitute for this
 * authenticated encrypted ORIGINAL native handoff. No network or source grant. */
export function readCompletedCentralEnrollment(
  directory: string,
  vault: Vault,
) {
  if (!isAbsolute(directory) || realpathSync(directory) !== directory)
    throw Error("Canonical native directory required");
  const identity = readCentralIdentity(
    join(directory, "central-workflows.db"),
    vault,
  );
  if (identity.status !== "existing")
    throw Error("Existing central identity required");
  const path = join(directory, "native-central-enrollment.db"),
    before = protectedFile(path, false, 32 * 1024 ** 2)!;
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const id = hash(identity.principal + "\n" + identity.publicKey);
    const row = db
      .prepare(
        "SELECT CASE WHEN length(record)<=160000 THEN record ELSE NULL END AS record FROM central_native_handoffs WHERE id=?",
      )
      .get(id) as { record: Buffer | null } | undefined;
    if (!row || !Buffer.isBuffer(row.record))
      throw Error("Completed native central enrollment required");
    const saved = centralEnrollmentRecordSchema.parse(
      vault.open(row.record, "central-native-handoff:" + id),
    );
    const h = saved.handoff,
      r = saved.review;
    if (
      !h ||
      h.status !== "complete" ||
      !saved.candidate ||
      canonical(h.candidate) !== canonical(saved.candidate) ||
      h.candidate.kind !== "enroll" ||
      r.principal !== identity.principal ||
      r.publicKey !== identity.publicKey ||
      [
        "principal",
        "publicKey",
        "authorityId",
        "deviceId",
        "sourceWorkspace",
        "ownerWallet",
      ].some(
        (k) =>
          (h.candidate as Record<string, unknown>)[k] !==
          (r as Record<string, unknown>)[k],
      )
    )
      throw Error("Original central enrollment binding changed");
    const e = enrollment.parse(h.result);
    if (
      e.principal !== identity.principal ||
      e.publicKey !== identity.publicKey ||
      e.credentialId !== identity.credentialId ||
      e.binding.principal !== e.principal ||
      e.binding.credentialId !== e.credentialId ||
      e.binding.ownerWallet !== r.ownerWallet ||
      e.binding.authorityId !== r.authorityId ||
      e.binding.deviceId !== r.deviceId ||
      e.binding.sourceWorkspace !== r.sourceWorkspace ||
      e.binding.tenant !== "roles:" + e.binding.ownerProfileId ||
      e.binding.workspace !== "crm:" + r.sourceWorkspace ||
      hash(canonical(e.binding)) !== e.runtimeBindingDigest
    )
      throw Error("Completed enrollment receipt differs from central identity");
    const after = protectedFile(path, false, 32 * 1024 ** 2)!;
    if (before.ino !== after.ino || before.dev !== after.dev)
      throw Error("Native enrollment state changed");
    return e;
  } finally {
    db.close();
  }
}
function publicReceipt(saved: z.infer<typeof record>) {
  return {
    version: 1 as const,
    purpose: "central-gateway" as const,
    principal: saved.enrollment.principal,
    credentialId: saved.enrollment.credentialId,
    runtimeBindingDigest: saved.enrollment.runtimeBindingDigest,
    tenant: saved.enrollment.binding.tenant,
    workspace: saved.enrollment.binding.workspace,
    actorTokenHash: hash(saved.token),
    credentialReference: "native-central-gateway:" + hash(saved.token),
    createdAt: saved.createdAt,
    permissionsGranted: false as const,
    configuresWorker: false as const,
  };
}
function existingRecord(directory: string, vault: Vault) {
  const e = readCompletedCentralEnrollment(directory, vault),
    path = join(directory, "native-central-gateway.db");
  const before = protectedFile(path)!;
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        "SELECT CASE WHEN length(value)<=8192 THEN value ELSE NULL END AS value FROM state WHERE id='gateway'",
      )
      .get() as { value: Buffer | null } | undefined;
    if (!row || !Buffer.isBuffer(row.value))
      throw Error("Existing native gateway credential required");
    const saved = record.parse(
      vault.open(row.value, "central-gateway:credential"),
    );
    if (canonical(saved.enrollment) !== canonical(e))
      throw Error("Existing native gateway binding differs");
    const after = protectedFile(path)!;
    if (before.ino !== after.ino || before.dev !== after.dev)
      throw Error("Native gateway path changed");
    return saved;
  } finally {
    db.close();
  }
}
/** Public metadata only, usable by the native review and scoped server setup. */
export function readPreparedCentralGatewayReceipt(
  directory: string,
  vault: Vault,
) {
  return publicReceipt(existingRecord(directory, vault));
}
/** Native-only resolver. Configuration contains the public reference, never a
 * pasted coordinator/task-sync bearer. Existing action-time source and Roles
 * checks still run before dispatch; this reader grants no runtime authority. */
export function existingPreparedCentralGatewayCredential(
  directory: string,
  vault: Vault,
  expected: {
    principal: string;
    credentialId: string;
    tenant: string;
    workspace: string;
    reference: string;
  },
) {
  const saved = existingRecord(directory, vault),
    e = saved.enrollment;
  if (
    expected.reference !== "native-central-gateway:" + hash(saved.token) ||
    expected.principal !== e.principal ||
    expected.credentialId !== e.credentialId ||
    expected.tenant !== e.binding.tenant ||
    expected.workspace !== e.binding.workspace
  )
    throw Error(
      "Prepared gateway reference is outside the saved central scope",
    );
  return saved.token;
}
/** Generate ONCE inside native custody, after a separate explicit review. Only
 * the hash is returned for a scoped server actor; the bearer is never returned
 * to UI/core. It creates no source connection, policy, lease or worker config. */
export function prepareCentralGatewayCredential(
  directory: string,
  vault: Vault,
  expected: CompletedCentralEnrollment,
  admitted: () => void,
  now = Date.now,
) {
  admitted();
  const current = readCompletedCentralEnrollment(directory, vault);
  if (canonical(current) !== canonical(enrollment.parse(expected)))
    throw Error("Reviewed enrollment changed");
  const path = join(directory, "native-central-gateway.db");
  try {
    closeSync(
      openSync(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      ),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const before = protectedFile(path)!;
  protectedFile(path + "-wal", true);
  protectedFile(path + "-shm", true);
  const db = new Database(path, { fileMustExist: true });
  try {
    db.pragma("journal_mode=WAL");
    db.pragma("synchronous=FULL");
    db.exec(
      "CREATE TABLE IF NOT EXISTS state(id TEXT PRIMARY KEY,value BLOB NOT NULL)",
    );
    return db
      .transaction(() => {
        admitted();
        const row = db
          .prepare(
            "SELECT CASE WHEN length(value)<=8192 THEN value ELSE NULL END AS value FROM state WHERE id='gateway'",
          )
          .get() as { value: Buffer | null } | undefined;
        let saved: z.infer<typeof record>;
        if (row) {
          if (!Buffer.isBuffer(row.value))
            throw Error("Native gateway record invalid");
          saved = record.parse(
            vault.open(row.value, "central-gateway:credential"),
          );
          if (canonical(saved.enrollment) !== canonical(current))
            throw Error("Existing gateway binding cannot be replaced");
        } else {
          saved = record.parse({
            enrollment: current,
            token: randomBytes(32).toString("base64url"),
            createdAt: now(),
          });
          db.prepare("INSERT INTO state VALUES('gateway',?)").run(
            vault.seal(saved, "central-gateway:credential"),
          );
        }
        admitted();
        if (
          canonical(readCompletedCentralEnrollment(directory, vault)) !==
          canonical(current)
        )
          throw Error("Native enrollment changed during preparation");
        const after = protectedFile(path)!;
        if (before.ino !== after.ino || before.dev !== after.dev)
          throw Error("Gateway path changed");
        return publicReceipt(saved);
      })
      .immediate();
  } finally {
    db.close();
  }
}
export function centralGatewayReviewActions(
  read: () => Promise<CompletedCentralEnrollment>,
  prepare: (
    e: CompletedCentralEnrollment,
    admitted: () => void,
  ) => Promise<unknown>,
  now = Date.now,
  prepared: () => Promise<ReturnType<
    typeof readPreparedCentralGatewayReceipt
  > | null> = async () => null,
) {
  let proposal: {
    enrollment: CompletedCentralEnrollment;
    checkedAt: number;
    expiresAt: number;
    digest: string;
  } | null = null;
  let closed = false,
    busy = false;
  const active = (digest: string) => {
    if (
      closed ||
      !proposal ||
      proposal.digest !== digest ||
      now() < proposal.checkedAt ||
      now() >= proposal.expiresAt
    )
      throw Error("Current separate native gateway review required");
  };
  return {
    async propose() {
      if (closed || busy) throw Error("Native gateway preparation unavailable");
      busy = true;
      try {
        const e = enrollment.parse(await read()),
          existing = await prepared(),
          at = now();
        if (closed || !Number.isSafeInteger(at) || at <= 0)
          throw Error("Native gateway review closed");
        const review = {
          version: 1,
          purpose: "prepare-central-gateway-credential",
          enrollment: e,
          prepared: existing,
          checkedAt: at,
          expiresAt: at + 60000,
          additionalSpendingUSD: 0,
          permissionsGranted: false,
          configuresWorker: false,
        };
        const digest = hash(canonical(review));
        proposal = {
          enrollment: e,
          checkedAt: at,
          expiresAt: at + 60000,
          digest,
        };
        return { ...review, digest };
      } finally {
        busy = false;
      }
    },
    async approve(digest: string) {
      if (busy) throw Error("Native gateway preparation already active");
      active(digest);
      busy = true;
      try {
        const e = proposal!.enrollment;
        if (canonical(await read()) !== canonical(e))
          throw Error("Native enrollment changed after review");
        active(digest);
        return await prepare(e, () => active(digest));
      } finally {
        busy = false;
        proposal = null;
      }
    },
    revoke() {
      proposal = null;
    },
    close() {
      closed = true;
      proposal = null;
    },
  };
}
