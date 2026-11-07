import Database from "better-sqlite3";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { Vault } from "../storage/vault.js";

const identity = z.strictObject({
  principal: z.string().regex(/^agent:[a-f0-9-]{36}$/),
  publicKey: z.string().max(512),
  privateKey: z.string().max(4096),
  credentialId: z.string().regex(/^[a-f0-9]{64}$/),
});
/** Existing central-purpose identity only. Never invokes worker.identity(),
 * creates a database/key, reads task-sync state, or requires a Roles profile. */
export function readCentralIdentity(path: string, vault: Vault) {
  if (!isAbsolute(path)) throw Error("Absolute central state path required");
  let before;
  try {
    before = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { status: "missing" as const };
    throw error;
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.uid !== process.getuid?.() ||
    realpathSync(path) !== path
  )
    throw Error("Owned canonical central state required");
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.transaction(() => {
      const row = db
        .prepare(
          "SELECT CASE WHEN length(value)<=16384 THEN value ELSE NULL END AS value FROM state WHERE key='identity'",
        )
        .get() as { value: Buffer | null } | undefined;
      if (!row) return { status: "missing" as const };
      if (!Buffer.isBuffer(row.value))
        throw Error("Invalid encrypted central identity");
      const saved = identity.parse(
        vault.open(row.value, "central-workflows:identity"),
      );
      z.uuid().parse(saved.principal.slice(6));
      const pub = createPublicKey(saved.publicKey),
        priv = createPrivateKey(saved.privateKey);
      if (
        pub.asymmetricKeyType !== "ed25519" ||
        priv.asymmetricKeyType !== "ed25519" ||
        pub.export({ type: "spki", format: "pem" }) !== saved.publicKey ||
        createPublicKey(priv).export({ type: "spki", format: "pem" }) !==
          saved.publicKey ||
        createHash("sha256").update(saved.publicKey).digest("hex") !==
          saved.credentialId
      )
        throw Error("Existing central identity is inconsistent");
      const after = lstatSync(path);
      if (
        after.ino !== before.ino ||
        after.dev !== before.dev ||
        realpathSync(path) !== path
      )
        throw Error("Central state path changed");
      return {
        status: "existing" as const,
        principal: saved.principal,
        publicKey: saved.publicKey,
        credentialId: saved.credentialId,
      };
    })();
  } finally {
    db.close();
  }
}

export function centralIdentityReviewActions(
  read: () => Promise<ReturnType<typeof readCentralIdentity>>,
  now = Date.now,
) {
  let closed = false,
    busy = false;
  return {
    async propose() {
      if (closed || busy) throw Error("Central identity review unavailable");
      busy = true;
      try {
        const saved = await read();
        if (closed) throw Error("Central identity review closed");
        const at = now();
        if (!Number.isSafeInteger(at) || at <= 0)
          throw Error("Invalid review time");
        return {
          version: 1,
          purpose: "central-workflows",
          target: "Bittrees Workflows on this Mac",
          status: saved.status,
          principal: saved.status === "existing" ? saved.principal : null,
          publicKey: saved.status === "existing" ? saved.publicKey : null,
          credentialId: saved.status === "existing" ? saved.credentialId : null,
          rolesEnrollment: "unverified",
          permissionsGranted: false,
          checkedAt: at,
          expiresAt: at + 60000,
        };
      } finally {
        busy = false;
      }
    },
    approve(_digest: string) {
      throw Error("Central identity review is read-only");
    },
    revoke() {},
    close() {
      closed = true;
    },
  };
}
