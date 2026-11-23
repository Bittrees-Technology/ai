import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  INITIAL_PAIRING_START,
  INITIAL_PAIRING_POLL,
  INITIAL_PAIRING_MAX_CALLS,
  INITIAL_PAIRING_MAX_DURATION_MS,
  pairingDigest,
  pairingIdentity,
  type InitialPairingConsent,
} from "./initial-pairing.js";
import type { NativeInitialPairingSession } from "./initial-pairing-native-session.js";
import { requireSynchronousPairingAdmission } from "./initial-pairing-admission.js";

type Session = Pick<
  NativeInitialPairingSession,
  "start" | "poll" | "close" | "reviewBinding"
>;
export interface NativeInitialPairingReview {
  version: 1;
  reviewId: string;
  target: "Bittrees local AI on this Mac";
  purpose: "metadata-only-owner-pairing";
  principal: string;
  keyFingerprint: string;
  rolesKeyFingerprint: string;
  startEndpoint: typeof INITIAL_PAIRING_START;
  pollEndpoint: typeof INITIAL_PAIRING_POLL;
  ownerResolution: "Roles authenticated active person with current applicable role";
  sourceAdmission: "required before start and every request";
  permissionsGranted: false;
  runtimeEnrolled: false;
  walletOrSafeApproval: false;
  maximumCalls: typeof INITIAL_PAIRING_MAX_CALLS;
  maximumDurationSeconds: number;
  additionalSpendingUSD: 0;
  expiresAt: number;
}
const digest = (review: NativeInitialPairingReview) =>
  createHash("sha256")
    .update(
      "Bittrees native initial pairing scope review v1\n" +
        pairingDigest(review),
    )
    .digest("hex");
function fingerprint(pem: string) {
  const key = createPublicKey(pem);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    key.export({ type: "spki", format: "pem" }).toString() !== pem
  )
    throw Error("Canonical native/source public key required");
  return createHash("sha256").update(pem).digest("hex");
}
/** Inactive trusted-native review lifecycle. No UI/HTTP/model/MCP registration,
 * identity inspection, key creation, transport or session construction in prepare.
 * Only the native owner confirmation handler may call approve. */
export class NativeInitialPairingReviewActions {
  private readonly identity;
  private readonly localFingerprint: string;
  private readonly rolesFingerprint: string;
  private review: NativeInitialPairingReview | undefined;
  private used = false;
  private closed = false;
  private active: InitialPairingConsent | null = null;
  private session: Session | undefined;
  constructor(
    private readonly options: {
      identity: { principal: string; publicKey: string };
      rolesPublicKey: string;
      admitSource: (review: Readonly<NativeInitialPairingReview>) => void;
      createSession: (
        currentConsent: () => InitialPairingConsent | null,
      ) => Session;
      now?: () => number;
    },
  ) {
    this.identity = pairingIdentity.parse(options.identity);
    this.localFingerprint = fingerprint(this.identity.publicKey);
    this.rolesFingerprint = fingerprint(options.rolesPublicKey);
  }
  private now() {
    const now = (this.options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0)
      throw Error("Invalid native review clock");
    return now;
  }
  prepare() {
    if (this.closed || this.used)
      throw Error("Native pairing review closed or consumed");
    const expiresAt = this.now() + INITIAL_PAIRING_MAX_DURATION_MS;
    if (!Number.isSafeInteger(expiresAt))
      throw Error("Invalid native review expiry");
    this.review = Object.freeze({
      version: 1,
      reviewId: randomUUID(),
      target: "Bittrees local AI on this Mac",
      purpose: "metadata-only-owner-pairing",
      principal: this.identity.principal,
      keyFingerprint: this.localFingerprint,
      rolesKeyFingerprint: this.rolesFingerprint,
      startEndpoint: INITIAL_PAIRING_START,
      pollEndpoint: INITIAL_PAIRING_POLL,
      ownerResolution:
        "Roles authenticated active person with current applicable role",
      sourceAdmission: "required before start and every request",
      permissionsGranted: false,
      runtimeEnrolled: false,
      walletOrSafeApproval: false,
      maximumCalls: INITIAL_PAIRING_MAX_CALLS,
      maximumDurationSeconds: INITIAL_PAIRING_MAX_DURATION_MS / 1000,
      additionalSpendingUSD: 0,
      expiresAt,
    });
    return { review: { ...this.review }, digest: digest(this.review) };
  }
  private current = (): InitialPairingConsent | null => {
    if (this.closed || !this.active || !this.validExpiry(this.active.expiresAt))
      return null;
    return { ...this.active };
  };
  private validExpiry(expiresAt: number) {
    const now = this.now();
    return (
      expiresAt > now && expiresAt <= now + INITIAL_PAIRING_MAX_DURATION_MS
    );
  }
  async approve(input: unknown) {
    const confirmation = z
      .strictObject({
        reviewId: z.uuid(),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(input);
    const review = this.review;
    if (
      this.closed ||
      this.used ||
      !review ||
      !this.validExpiry(review.expiresAt) ||
      confirmation.reviewId !== review.reviewId ||
      confirmation.digest !== digest(review)
    )
      throw Error(
        "Current exact single-use native pairing confirmation required",
      );
    // Consume before admission/session construction. An uncertain action cannot
    // gain another attempt from replaying a native confirmation.
    this.used = true;
    try {
      requireSynchronousPairingAdmission(() =>
        this.options.admitSource({ ...review }),
      );
      if (this.closed || !this.validExpiry(review.expiresAt))
        throw Error("Native review cancelled or expired");
      this.active = {
        id: review.reviewId,
        principal: review.principal,
        keyFingerprint: review.keyFingerprint,
        expiresAt: review.expiresAt,
      };
      this.session = this.options.createSession(this.current);
      const binding = this.session.reviewBinding();
      if (
        binding.principal !== review.principal ||
        binding.keyFingerprint !== review.keyFingerprint ||
        binding.rolesKeyFingerprint !== review.rolesKeyFingerprint ||
        binding.maximumCalls !== review.maximumCalls ||
        binding.maximumDurationSeconds !== review.maximumDurationSeconds ||
        binding.additionalSpendingUSD !== review.additionalSpendingUSD
      )
        throw Error("Native pairing session does not match reviewed scope");
      if (!this.current()) throw Error("Native review cancelled or expired");
      const result = await this.session.start();
      if (!this.current()) throw Error("Native review cancelled or expired");
      return result;
    } catch (error) {
      this.active = null;
      await this.session?.close();
      throw error;
    }
  }
  async poll() {
    if (!this.current() || !this.session || !this.review)
      throw Error("Current native pairing confirmation required");
    requireSynchronousPairingAdmission(() =>
      this.options.admitSource({ ...this.review! }),
    );
    if (!this.current()) throw Error("Native review cancelled or expired");
    const result = await this.session.poll();
    if (!this.current()) throw Error("Native review cancelled or expired");
    return result;
  }
  async close() {
    this.closed = true;
    this.active = null;
    this.review = undefined;
    await this.session?.close();
  }
}
