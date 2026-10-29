import Database from "better-sqlite3";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
} from "node:crypto";
import { lstatSync, openSync, closeSync } from "node:fs";
import { isAbsolute, dirname } from "node:path";
import { z } from "zod";
import type { Vault } from "../storage/vault.js";

const keySchema = z.strictObject({
  principal: z.string().regex(/^agent:[a-f0-9-]{36}$/),
  publicKey: z.string().max(1024),
  privateKey: z.string().max(4096),
});

/** Native owner inspection only. Existing key continuity is verified, never
 * initialized, rotated, enrolled or inferred from another local identity. */
export function readNativeWorkflowIdentity(path: string, vault: Vault) {
  if (!isAbsolute(path)) throw Error("Absolute task state path required");
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { status: "missing" as const };
    throw error;
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.()
  )
    throw Error("Owned regular task state required");
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.transaction(() => {
      const row = db
        .prepare("SELECT value FROM state WHERE key='key'")
        .get() as { value: Buffer } | undefined;
      if (!row) return { status: "missing" as const };
      if (!Buffer.isBuffer(row.value) || row.value.length > 16384)
        throw Error("Invalid encrypted workflow key");
      const key = keySchema.parse(vault.open(row.value, "task-sync:key"));
      z.uuid().parse(key.principal.slice(6));
      const pub = createPublicKey(key.publicKey),
        priv = createPrivateKey(key.privateKey);
      if (
        pub.asymmetricKeyType !== "ed25519" ||
        priv.asymmetricKeyType !== "ed25519" ||
        pub.export({ type: "spki", format: "pem" }).toString() !==
          key.publicKey ||
        createPublicKey(priv)
          .export({ type: "spki", format: "pem" })
          .toString() !== key.publicKey
      )
        throw Error("Existing workflow key is inconsistent");
      // Saved workspace is context only; it is not current source authorization.
      const review = db
        .prepare("SELECT value FROM state WHERE key='review'")
        .get() as { value: Buffer } | undefined;
      if (
        review &&
        (!Buffer.isBuffer(review.value) || review.value.length > 65536)
      )
        throw Error("Invalid saved workflow review");
      const workspace = review
        ? z
            .object({ sourceWorkspace: z.uuid() })
            .parse(vault.open(review.value, "task-sync:review")).sourceWorkspace
        : null;
      return {
        status: "existing" as const,
        principal: key.principal,
        publicKey: key.publicKey,
        credentialId: createHash("sha256").update(key.publicKey).digest("hex"),
        sourceWorkspace: workspace,
      };
    })();
  } finally {
    db.close();
  }
}

export const nativeIdentityReviewSchema = z.strictObject({
  version: z.literal(1),
  target: z.literal("Bittrees local AI on this Mac"),
  status: z.enum(["existing", "missing"]),
  principal: z.string().nullable(),
  publicKey: z.string().nullable(),
  credentialId: z.string().nullable(),
  sourceWorkspace: z.string().nullable(),
  rolesEnrollment: z.literal("unverified"),
  controllerAssociation: z.literal("unverified"),
  grantsAuthority: z.literal(false),
  checkedAt: z.number().int(),
  expiresAt: z.number().int(),
  reviewDigest: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Explicit native-only initialization. Never replaces a key or another state
 * table; private key material is encrypted before any database write. */
export function initializeNativeWorkflowIdentity(
  path: string,
  vault: Vault,
  admitted: () => boolean,
) {
  if (!isAbsolute(path) || !admitted())
    throw Error("Current native initialization approval required");
  const parent = lstatSync(dirname(path));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    parent.mode & 0o022
  )
    throw Error("Protected local state directory required");
  let created = false;
  try {
    const fd = openSync(path, "wx", 0o600);
    closeSync(fd);
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.()
  )
    throw Error("Owned regular task state required");
  const db = new Database(path, { fileMustExist: true });
  try {
    db.transaction(() => {
      if (!admitted()) throw Error("Native initialization approval expired");
      if (created)
        db.exec("CREATE TABLE state(key TEXT PRIMARY KEY,value BLOB NOT NULL)");
      if (db.prepare("SELECT 1 FROM state WHERE key='key'").get())
        throw Error("Existing identity changed; review again");
      const pair = generateKeyPairSync("ed25519", {
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      const key = { ...pair, principal: "agent:" + randomUUID() };
      const encrypted = vault.seal(key, "task-sync:key");
      if (!admitted()) throw Error("Native initialization approval expired");
      db.prepare("INSERT INTO state(key,value) VALUES('key',?)").run(encrypted);
      if (!admitted()) throw Error("Native initialization approval expired");
    }).immediate();
  } finally {
    db.close();
  }
}

/** Only the separate native capability may call this. No model/core route. */
export function nativeIdentityReviewActions(
  read: () => Promise<ReturnType<typeof readNativeWorkflowIdentity>>,
  now = Date.now,
  initialize?: (admitted: () => boolean) => Promise<void>,
) {
  let busy = false,
    closed = false,
    generation = 0;
  let pending: {
    digest: string;
    expiresAt: number;
    generation: number;
  } | null = null;
  return {
    async propose() {
      if (busy || closed) throw Error("Native identity review unavailable");
      busy = true;
      const epoch = generation;
      try {
        const identity = await read();
        if (closed || epoch !== generation)
          throw Error("Native identity review cancelled");
        const at = now();
        const expiresAt = at + 60000;
        const reviewDigest = createHash("sha256")
          .update(
            JSON.stringify({
              purpose: "native-local-workflow-identity-initialization-v1",
              nonce: randomUUID(),
              identity,
              at,
              expiresAt,
            }),
          )
          .digest("hex");
        pending =
          identity.status === "missing" && initialize
            ? { digest: reviewDigest, expiresAt, generation }
            : null;
        return nativeIdentityReviewSchema.parse({
          version: 1,
          target: "Bittrees local AI on this Mac",
          status: identity.status,
          principal: identity.status === "existing" ? identity.principal : null,
          publicKey: identity.status === "existing" ? identity.publicKey : null,
          credentialId:
            identity.status === "existing" ? identity.credentialId : null,
          sourceWorkspace:
            identity.status === "existing" ? identity.sourceWorkspace : null,
          rolesEnrollment: "unverified",
          controllerAssociation: "unverified",
          grantsAuthority: false,
          checkedAt: at,
          expiresAt,
          reviewDigest,
        });
      } finally {
        busy = false;
      }
    },
    async approve(digest: string) {
      const p = pending;
      pending = null;
      const admitted = () =>
        Boolean(
          p && !closed && p.generation === generation && now() < p.expiresAt,
        );
      if (busy || !initialize || !p || digest !== p.digest || !admitted())
        throw Error("Current native initialization review required");
      busy = true;
      try {
        await initialize(admitted);
        if (!admitted())
          throw Error("Native initialization result requires reconciliation");
      } finally {
        busy = false;
      }
    },
    revoke() {
      generation++;
      pending = null;
    },
    close() {
      closed = true;
      generation++;
      pending = null;
    },
  };
}
