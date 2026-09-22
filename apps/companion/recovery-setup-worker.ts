import { fstatSync, writeSync } from "node:fs";
import { macKeychainEntry } from "../../modules/storage/keychain.js";
import { prepareRecoverySetup } from "./recovery-setup.js";
// Internal pipe protocol. Refuse ordinary terminal invocation before key access.
try {
  if (
    process.env.BITTREES_RECOVERY_PREVIEW !== "1" ||
    !fstatSync(0).isFIFO() ||
    !fstatSync(1).isFIFO() ||
    process.argv.length !== 2
  )
    throw Error();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of process.stdin) {
    const chunk = Buffer.from(raw);
    size += chunk.length;
    if (size > 128) throw Error();
    chunks.push(chunk);
  }
  const request: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const result = await prepareRecoverySetup(
    request,
    macKeychainEntry("personal"),
  );
  writeSync(1, JSON.stringify(result));
} catch {
  // Never log parser/provider errors or secret protocol fields.
  process.exitCode = 1;
}
