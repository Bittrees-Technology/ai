import { readFile, copyFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const root = new URL("../", import.meta.url);
const pins = {
  "modules/wallet-review/agent-wallet-policy.mjs":
    "24ca9b356f25d151493898c9c50e1b3b2a1e860a9c35a2b0f2dc851952a5ffb5",
  "modules/wallet-review/signed-action.mjs":
    "880637ce1d55ac606562c42843e6fca8ab90e96583381a2d3409c670ba8b1088",
};
for (const [path, pin] of Object.entries(pins))
  if (
    createHash("sha256")
      .update(await readFile(new URL(path, root)))
      .digest("hex") !== pin
  )
    throw Error("Reviewed wallet helper pin changed");
for (const path of [
  ...Object.keys(pins),
  "modules/wallet-review/native-review.mjs",
  "apps/companion/native-wallet-review.mjs",
]) {
  const target = new URL("dist/" + path, root);
  await mkdir(new URL(".", target), { recursive: true });
  await copyFile(new URL(path, root), target);
}
