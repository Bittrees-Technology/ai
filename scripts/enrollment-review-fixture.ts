import { generateKeyPairSync, randomUUID } from "node:crypto";
import { EnrollmentConsent } from "../modules/task-sync/enrollment-consent.js";
const scope = {
  principal: "agent:" + randomUUID(),
  publicKey: generateKeyPairSync("ed25519")
    .publicKey.export({ format: "pem", type: "spki" })
    .toString(),
  authorityId: randomUUID(),
  deviceId: randomUUID(),
  sourceWorkspace: randomUUID(),
  ownerWallet: "0x" + "a".repeat(40),
};
// Ephemeral public identity only. No real owner, keychain, transport or grant.
console.log(
  JSON.stringify(
    new EnrollmentConsent(
      () => scope,
      () => true,
      () => {},
    ).propose(),
  ),
);
