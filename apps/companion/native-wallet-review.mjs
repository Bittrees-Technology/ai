import { reviewNativeWalletDraft } from "../../modules/wallet-review/native-review.mjs";
// Fixed native read-only subprocess. No CLI paths/commands, networking, key access,
// storage writes or wallet methods. Native host supplies selected JSON via stdin.
if (process.argv.length !== 2)
  throw Error("No wallet review arguments allowed");
let size = 0;
const chunks = [];
try {
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 131072) throw Error("Wallet draft exceeds review limit");
    chunks.push(chunk);
  }
  const input = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
  const output = JSON.stringify(reviewNativeWalletDraft(input));
  if (Buffer.byteLength(output) > 262144)
    throw Error("Wallet review exceeds display limit");
  process.stdout.write(output);
} catch {
  process.stderr.write(
    "Wallet draft review rejected; no wallet or permissions changed.\n",
  );
  process.exitCode = 1;
}
