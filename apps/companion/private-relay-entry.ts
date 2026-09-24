import { createHash } from "node:crypto";
import type { PrivateRelaySecretEntries } from "../../modules/remote/private-relay-custody.js";
import { macPrivateKeyEntries } from "./private-key-entry.js";
/** Reuse the trusted bundled add-only Keychain helper with a separate account
 * domain. Never pass an untrusted executable or profile. No calls until used. */
export function macPrivateRelayEntries(
  helper: string,
  profile: string,
): PrivateRelaySecretEntries {
  return {
    forSlot(owner, id) {
      const localOwner =
        "private-relay:" +
        createHash("sha256")
          .update(JSON.stringify([owner.tenantId, owner.userId]))
          .digest("hex");
      return macPrivateKeyEntries(helper, profile, localOwner, id);
    },
  };
}
