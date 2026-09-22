import { z } from "zod";
import type { SecretEntry } from "../../modules/storage/keychain.js";
import { prepareUserRecoveryKit } from "./key-recovery.js";
/** Private native-process response, never an HTTP response or diagnostic log. */
export async function prepareRecoverySetup(
  request: unknown,
  entry: SecretEntry,
) {
  z.strictObject({
    operation: z.literal("prepare-recovery-kit-v1"),
    confirmed: z.literal(true),
  }).parse(request);
  const prepared = await prepareUserRecoveryKit(entry);
  return {
    version: 1,
    kitBase64: prepared.kit.toString("base64"),
    recoveryCode: prepared.recoveryCode,
    kitId: prepared.kitId,
  };
}
