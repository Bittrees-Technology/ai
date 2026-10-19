import { createPublicKey } from "node:crypto";
import { isAbsolute } from "node:path";
import { Vault } from "../storage/vault.js";
import { EnrollmentHTTPS } from "./enrollment-https.js";
import { EnrollmentSession } from "./enrollment-session.js";
import {
  EnrollmentTransportPlan,
  type EnrollmentReview,
} from "./enrollment-transport-plan.js";

/** Trusted native construction only. No environment discovery, Keychain prompts,
 * identity creation or network on construction. The launcher must independently
 * establish the signer pin, existing vault/credential and source/cost admission.
 */
export function nativeEnrollmentSessionFactory(options: {
  path: string;
  vault: Vault;
  pinnedSigner: string;
  credential: () => string;
  admitted: () => boolean;
  now?: () => number;
}) {
  if (!isAbsolute(options.path))
    throw Error("Absolute enrollment storage path required");
  const signer = createPublicKey(options.pinnedSigner);
  if (
    signer.asymmetricKeyType !== "ed25519" ||
    signer.export({ type: "spki", format: "pem" }).toString() !==
      options.pinnedSigner
  )
    throw Error("Canonical pinned Ed25519 signer required");
  const { path, vault, pinnedSigner, credential, admitted } = options;
  const now = options.now ?? Date.now;
  return (current: () => EnrollmentReview | null) => {
    const planner = new EnrollmentTransportPlan(current, now);
    const admit = (epoch?: string) => {
      if (!admitted())
        throw Error("Enrollment source/cost admission unavailable");
      const review = planner.assertCurrent();
      if (epoch !== undefined && review.epoch !== epoch)
        throw Error("Enrollment review changed");
      return review;
    };
    const initial = admit();
    // Freeze the exact approved review for the lifetime of this encrypted session.
    const snapshot = Object.freeze({ ...initial });
    const active = () => {
      try {
        const review = admit(snapshot.epoch);
        for (const key of Object.keys(snapshot) as (keyof EnrollmentReview)[])
          if (review[key] !== snapshot[key]) return null;
        return snapshot;
      } catch {
        return null;
      }
    };
    const transport = new EnrollmentHTTPS((epoch) => {
      if (!active() || epoch !== snapshot.epoch)
        throw Error("Enrollment admission changed");
    }, credential);
    return new EnrollmentSession(
      path,
      vault,
      active,
      transport.dispatch,
      pinnedSigner,
      now,
    );
  };
}
