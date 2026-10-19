import Database from "better-sqlite3";
import { createPublicKey, createPrivateKey } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { Vault } from "../storage/vault.js";

/** Read existing local identity only. Never creates keys, reviews or databases,
 * contacts Keychain, or returns the private signing key. Saved review metadata
 * is not current Roles/source authorization and must not be used as such.
 */
export function savedEnrollmentIdentity(path: string, vault: Vault) {
  if (!isAbsolute(path)) throw Error("Absolute task state path required");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw Error("Regular task state required");
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.transaction(() => {
      const read = (key: string) => {
        const row = db
          .prepare("SELECT value FROM state WHERE key=?")
          .get(key) as { value: Buffer } | undefined;
        if (!row) throw Error("Existing task identity and review required");
        return vault.open<unknown>(row.value, "task-sync:" + key);
      };
      const identity = z
        .strictObject({
          principal: z.string().regex(/^agent:[a-f0-9-]{36}$/),
          publicKey: z.string().max(1024),
          privateKey: z.string().max(4096),
        })
        .parse(read("key"));
      z.uuid().parse(identity.principal.slice(6));
      const review = z
        .object({ sourceWorkspace: z.uuid() })
        .parse(read("review"));
      const key = createPublicKey(identity.publicKey);
      const privateKey = createPrivateKey(identity.privateKey);
      if (
        key.asymmetricKeyType !== "ed25519" ||
        privateKey.asymmetricKeyType !== "ed25519" ||
        key.export({ type: "spki", format: "pem" }).toString() !==
          identity.publicKey ||
        createPublicKey(privateKey)
          .export({ type: "spki", format: "pem" })
          .toString() !== identity.publicKey
      )
        throw Error("Saved task signing identity is inconsistent");
      return Object.freeze({
        principal: identity.principal,
        publicKey: identity.publicKey,
        sourceWorkspace: review.sourceWorkspace,
      });
    })();
  } finally {
    db.close();
  }
}
