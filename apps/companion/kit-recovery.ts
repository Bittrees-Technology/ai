import { z } from "zod";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AddOnlySecretEntry } from "./key-install.js";
import { recoverAndActivateWithKit } from "./install-recovered-key.js";
import { RecoveryError } from "./recovery.js";
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => isAbsolute(v) && !v.includes("\0"));
const request = z.strictObject({
  operation: z.literal("recover-with-kit-v1"),
  confirmed: z.literal(true),
  backup: path,
  kit: path,
  code: z.string().regex(/^btr1_[A-Za-z0-9_-]{43}$/),
});
export const kitRecoveryErrors = [
  "INVALID_PATH",
  "INVALID_ACTIVE_CONTENT",
  "RECOVERY_KIT_REJECTED",
  "KEY_STORE_UNAVAILABLE",
  "EXISTING_KEY_CONFLICT",
  "CURRENT_DATA_KEY_CONFLICT",
  "BACKUP_RESTORE_FAILED",
  "COMPANION_RUNNING_OR_PORT_UNAVAILABLE",
] as const;
/** Native pipe only: the trusted caller fixes base/helper, never the request. */
export async function recoverKitRequest(
  input: unknown,
  base: string,
  entry: AddOnlySecretEntry,
  port = 43127,
) {
  const value = request.parse(input);
  const handle = await open(
    value.kit,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let kit: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== 116)
      throw new RecoveryError("RECOVERY_KIT_REJECTED");
    const bytes = Buffer.alloc(117);
    const { bytesRead } = await handle.read(bytes, 0, 117, 0);
    if (bytesRead !== 116) throw new RecoveryError("RECOVERY_KIT_REJECTED");
    kit = bytes.subarray(0, 116);
  } finally {
    await handle.close();
  }
  const result = await recoverAndActivateWithKit(
    value.backup,
    base,
    kit,
    value.code,
    entry,
    port,
  );
  // No data, paths or secret material goes back to the UI.
  return {
    version: 1 as const,
    ...{ activated: result.activated, keyStatus: result.keyStatus },
  };
}
