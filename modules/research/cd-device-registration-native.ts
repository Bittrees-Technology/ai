import Database from "better-sqlite3";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
} from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { z } from "zod";
import { canonical } from "../contracts/canonical-json.js";
import type { Vault } from "../storage/vault.js";

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const principal = z
  .string()
  .regex(/^(agent|service):[a-f0-9-]{36}$/)
  .refine((value) => z.uuid().safeParse(value.split(":")[1]).success);
export const cdDeviceRegistrationRequest = z.strictObject({
  version: z.literal(1),
  audience: z.literal(
    "https://roles.bittrees.org/api/profile/mcp/devices/register",
  ),
  purpose: z.literal("crypto-directory:read-access"),
  requestId: z.uuid(),
  deviceId: z.uuid(),
  ownerProfile: z.uuid(),
  principal,
  credentialId: hex,
  label: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[^\x00-\x1f\x7f]+$/),
  sessionBinding: hex,
  issuedAt: z.int(),
  expiresAt: z.int(),
});
const packet = z.strictObject({
  request: cdDeviceRegistrationRequest,
  challenge: z.string().min(1).max(5000),
  registered: z.literal(false),
  permissionsGranted: z.literal(false),
});
const identity = z.strictObject({
  purpose: z.literal("crypto-directory:read-access"),
  credentialKind: z.literal("non-lease"),
  principal,
  publicKey: z.string().max(1024),
  privateKey: z.string().max(4096),
});
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export const cdNativeRegistrationMessage = (request: unknown) =>
  "Bittrees CryptoDirectory device registration v1\n" + canonical(request);
type OwnerBinding = {
  ownerProfile: string;
  sessionBinding: string;
  principal: string;
  credentialId: string;
  enrolled: true;
  credentialKind: "non-lease";
  preparedPacketDigest: string;
  preparedEndpoint: "https://roles.bittrees.org/api/profile/mcp/devices/prepare";
  authenticatedAt: number;
  sessionExpiresAt: number;
};
type Review = {
  id: string;
  requestDigest: string;
  packetDigest: string;
  expiresAt: number;
  label: string;
  principal: string;
  credentialId: string;
  deviceId: string;
  ownerProfile: string;
  purpose: "crypto-directory:read-access";
  audience: "https://roles.bittrees.org/api/profile/mcp/devices/register";
};

/** Dormant native owner surface. It never creates a key, enrolls, calls Roles,
 * or accepts arbitrary signing text. Only trusted native code may approve. */
export function cdDeviceRegistrationNative(options: {
  enabled?: boolean;
  path: string;
  vault: Vault;
  /** Trusted canonical native Roles session and fixed prepare transport only.
   * Never derive these fields from model/browser request selectors. */
  currentOwner: () => OwnerBinding | null;
  now?: () => number;
}) {
  const { path, vault, currentOwner, now = Date.now } = options;
  const optedIn = options.enabled === true;
  let pending:
    | { packet: z.infer<typeof packet>; review: Review; approved: boolean }
    | undefined;
  const enabled = () => {
    if (!optedIn) throw Error("Native CD registration disabled");
  };
  const read = () => {
    if (
      !isAbsolute(path) ||
      basename(path) !== "cryptodirectory-device.db" ||
      realpathSync(path) !== path
    )
      throw Error("Dedicated existing CD-purpose state required");
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    )
      throw Error("Owned private CD-purpose state required");
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare("SELECT value FROM cd_device_identity WHERE id=1")
        .get() as { value: Buffer } | undefined;
      if (!row || !Buffer.isBuffer(row.value) || row.value.length > 16384)
        throw Error("Existing encrypted CD identity required");
      const saved = identity.parse(
        vault.open(row.value, "crypto-directory-device:identity"),
      );
      const pub = createPublicKey(saved.publicKey),
        privateKey = createPrivateKey(saved.privateKey);
      if (
        pub.asymmetricKeyType !== "ed25519" ||
        privateKey.asymmetricKeyType !== "ed25519" ||
        pub.export({ type: "spki", format: "pem" }).toString() !==
          saved.publicKey ||
        createPublicKey(privateKey)
          .export({ type: "spki", format: "pem" })
          .toString() !== saved.publicKey
      )
        throw Error("CD key continuity changed");
      const after = lstatSync(path);
      if (
        after.ino !== stat.ino ||
        after.dev !== stat.dev ||
        realpathSync(path) !== path
      )
        throw Error("CD-purpose state changed during read");
      return {
        principal: saved.principal,
        credentialId: sha(saved.publicKey),
        privateKey,
      };
    } finally {
      db.close();
    }
  };
  const validate = (
    request: z.infer<typeof cdDeviceRegistrationRequest>,
    packetDigest: string,
  ) => {
    const at = now();
    if (
      request.issuedAt > at ||
      request.expiresAt <= at ||
      request.expiresAt <= request.issuedAt ||
      request.expiresAt > request.issuedAt + 60000
    )
      throw Error("CD registration challenge expired or changed");
    const owner = currentOwner();
    if (
      !owner ||
      owner.enrolled !== true ||
      owner.preparedEndpoint !==
        "https://roles.bittrees.org/api/profile/mcp/devices/prepare" ||
      owner.preparedPacketDigest !== packetDigest ||
      !Number.isSafeInteger(owner.authenticatedAt) ||
      !Number.isSafeInteger(owner.sessionExpiresAt) ||
      owner.authenticatedAt > at ||
      owner.authenticatedAt < at - 600000 ||
      owner.sessionExpiresAt <= at ||
      owner.credentialKind !== "non-lease" ||
      owner.ownerProfile !== request.ownerProfile ||
      owner.sessionBinding !== request.sessionBinding ||
      owner.principal !== request.principal ||
      owner.credentialId !== request.credentialId
    )
      throw Error("Current CD owner and enrolled credential required");
  };
  return {
    review(raw: unknown): Readonly<Review> {
      enabled();
      pending = undefined;
      const parsed = packet.parse(raw);
      validate(parsed.request, sha(canonical(parsed)));
      const key = read();
      if (
        key.principal !== parsed.request.principal ||
        key.credentialId !== parsed.request.credentialId
      )
        throw Error("CD registration credential mismatch");
      const review = Object.freeze({
        id: randomUUID(),
        requestDigest: sha(canonical(parsed.request)),
        packetDigest: sha(canonical(parsed)),
        expiresAt: parsed.request.expiresAt,
        label: parsed.request.label,
        deviceId: parsed.request.deviceId,
        ownerProfile: parsed.request.ownerProfile,
        purpose: parsed.request.purpose,
        audience: parsed.request.audience,
        principal: key.principal,
        credentialId: key.credentialId,
      });
      pending = { packet: structuredClone(parsed), review, approved: false };
      return review;
    },
    approve(raw: unknown) {
      enabled();
      const choice = z
        .strictObject({
          id: z.uuid(),
          requestDigest: hex,
          packetDigest: hex,
          confirmed: z.literal(true),
        })
        .parse(raw);
      if (
        !pending ||
        choice.id !== pending.review.id ||
        choice.requestDigest !== pending.review.requestDigest ||
        choice.packetDigest !== pending.review.packetDigest
      )
        throw Error("Exact native CD review confirmation required");
      validate(pending.packet.request, pending.review.packetDigest);
      pending.approved = true;
    },
    sign() {
      enabled();
      const selected = pending;
      pending = undefined;
      if (!selected?.approved)
        throw Error("Native CD owner confirmation required");
      const request = selected.packet.request;
      validate(request, selected.review.packetDigest);
      const key = read();
      if (
        key.principal !== request.principal ||
        key.credentialId !== request.credentialId
      )
        throw Error("CD registration key changed");
      validate(request, selected.review.packetDigest);
      return {
        challenge: selected.packet.challenge,
        signature: sign(
          null,
          Buffer.from(cdNativeRegistrationMessage(request)),
          key.privateKey,
        ).toString("base64"),
      };
    },
    revoke() {
      pending = undefined;
    },
  };
}
