import Database from "better-sqlite3";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { Vault } from "../storage/vault.js";
import { readNativeWorkflowIdentity } from "./native-identity-review.js";
import {
  initialPairingMessage,
  initialPairingPollMessage,
  initialPairingPoll,
  validateInitialPairingRequest,
  type InitialPairingConsent,
} from "./initial-pairing.js";

const startDomain = "Bittrees native initial owner pairing request v1\n",
  pollDomain = "Bittrees native initial owner pairing poll v1\n";
/** Dedicated native helper signer; only an existing encrypted task key. Never
 * initializes a key or needs a workspace/credential. Private material remains
 * inside this call and cannot be returned to a browser/model. */
export function signNativeInitialPairingMessage(
  path: string,
  vault: Vault,
  consent: () => InitialPairingConsent | null,
  text: string,
  now = Date.now,
) {
  const review = consent();
  if (
    !review ||
    review.expiresAt <= now() ||
    review.expiresAt > now() + 300000 ||
    Buffer.byteLength(text) > 16384
  )
    throw Error("Current native pairing consent required");
  const start = text.startsWith(startDomain),
    poll = text.startsWith(pollDomain);
  if (!start && !poll) throw Error("Initial pairing signature domain required");
  const raw: unknown = JSON.parse(
    text.slice((start ? startDomain : pollDomain).length),
  );
  const request = start
    ? validateInitialPairingRequest(raw, now())
    : initialPairingPoll.parse(raw);
  if (
    (start
      ? initialPairingMessage(request)
      : initialPairingPollMessage(request)) !== text ||
    request.principal !== review.principal ||
    request.keyFingerprint !== review.keyFingerprint ||
    request.issuedAt > now() ||
    now() - request.issuedAt > 15000 ||
    (start && "expiresAt" in request && request.expiresAt !== review.expiresAt)
  )
    throw Error("Exact native pairing request required");
  if (!isAbsolute(path)) throw Error("Absolute task state required");
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.())
    throw Error("Owned existing task state required");
  const publicIdentity = readNativeWorkflowIdentity(path, vault);
  if (
    publicIdentity.status !== "existing" ||
    publicIdentity.principal !== review.principal ||
    publicIdentity.credentialId !== review.keyFingerprint
  )
    throw Error("Native task identity changed");
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.transaction(() => {
      const row = db
        .prepare("SELECT value FROM state WHERE key='key'")
        .get() as { value: Buffer } | undefined;
      if (!row || !Buffer.isBuffer(row.value) || row.value.length > 16384)
        throw Error("Existing encrypted task key required");
      const key = z
        .strictObject({
          principal: z.string(),
          publicKey: z.string().max(1024),
          privateKey: z.string().max(4096),
        })
        .parse(vault.open(row.value, "task-sync:key"));
      const privateKey = createPrivateKey(key.privateKey);
      if (
        key.principal !== publicIdentity.principal ||
        key.publicKey !== publicIdentity.publicKey ||
        privateKey.asymmetricKeyType !== "ed25519" ||
        createPublicKey(privateKey)
          .export({ type: "spki", format: "pem" })
          .toString() !== publicIdentity.publicKey
      )
        throw Error("Native key continuity changed");
      const current = consent();
      if (
        !current ||
        current.id !== review.id ||
        current.principal !== review.principal ||
        current.keyFingerprint !== review.keyFingerprint ||
        current.expiresAt !== review.expiresAt ||
        now() >= review.expiresAt
      )
        throw Error("Native pairing consent revoked");
      return sign(null, Buffer.from(text), privateKey).toString("base64");
    })();
  } finally {
    db.close();
  }
}
