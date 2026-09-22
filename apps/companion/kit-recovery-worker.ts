import { fstatSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { macAddOnlyEntry } from "./key-install.js";
import { kitRecoveryErrors, recoverKitRequest } from "./kit-recovery.js";
import { RecoveryError } from "./recovery.js";
let connected = false;
try {
  if (
    process.env.BITTREES_RECOVERY_PREVIEW !== "1" ||
    process.argv.length !== 2 ||
    !fstatSync(0).isFIFO() ||
    !fstatSync(1).isFIFO()
  )
    throw Error();
  connected = true;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of process.stdin) {
    const chunk = Buffer.from(raw);
    size += chunk.length;
    if (size > 32768) throw Error();
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  let input: unknown;
  try {
    input = JSON.parse(bytes.toString("utf8"));
  } finally {
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
  const helper = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../KeyInstall",
  );
  const result = await recoverKitRequest(
    input,
    join(homedir(), "Library/Application Support/Bittrees AI"),
    macAddOnlyEntry(helper),
  );
  writeSync(1, JSON.stringify(result));
} catch (error) {
  if (connected) {
    const code =
      error instanceof RecoveryError &&
      kitRecoveryErrors.some((v) => v === error.message)
        ? error.message
        : "RECOVERY_UNCONFIRMED";
    try {
      writeSync(1, JSON.stringify({ version: 1, error: code }));
    } catch {
      /* Never log. */
    }
  }
  process.exitCode = 1;
}
