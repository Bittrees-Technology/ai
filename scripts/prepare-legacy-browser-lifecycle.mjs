/** Build the exact public PR149 browser key provider for actual IndexedDB upgrade checks. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { build } from "vite";
const repo = fileURLToPath(new URL("../", import.meta.url)),
  ref = "99a3c5e3a408305438f718e3326363b656234c9e";
const hashes = {
  "browser-endpoint-keys.ts":
    "6bcbac0d1b16b3e3f16abec3527d7e541364968ae90f18b5f3ca6b2cdb5418c4",
  "browser-key-recovery.ts":
    "1f27b130105816797afbb7a45bde8f85a93296f6d326e38f657bd7b3e308da68",
  "private-peer-contracts.ts":
    "ad3cbb8cbcb15dc911160f8240b0245b32fb729fa2e8a26d815153b17965a85e",
  "browser-key-lifecycle.ts":
    "3efe623b49d163ea2a01a98f09c3f775a68be1f6cd17739f9a0b42b6f10f9785",
  "browser-key-state.ts":
    "d411547abcc8b0bf53c2b7efd871fdd1e40a94432b329aaaba527d2db1c96292",
};
const dir = join(repo, ".legacy-browser-lifecycle");
await mkdir(dir, { recursive: true });
for (const [name, expected] of Object.entries(hashes)) {
  const raw = execFileSync("git", ["show", ref + ":modules/remote/" + name], {
    cwd: repo,
  });
  if (createHash("sha256").update(raw).digest("hex") !== expected)
    throw Error("Legacy source hash mismatch");
  await writeFile(join(dir, name), raw);
}
await writeFile(
  join(dir, "index.ts"),
  "export {BrowserKeyLifecycle} from './browser-key-lifecycle.js';export {BrowserEndpointKeys} from './browser-endpoint-keys.js';export {openBrowserKeyRecovery} from './browser-key-recovery.js';\n",
);
await build({
  configFile: false,
  root: repo,
  build: {
    outDir: join(repo, "tests/browser/fixture/public"),
    emptyOutDir: false,
    lib: {
      entry: join(dir, "index.ts"),
      formats: ["es"],
      fileName: () => "legacy-lifecycle.js",
    },
    minify: false,
  },
});
console.log(
  "Verified PR149 legacy source hashes and built isolated browser compatibility module.",
);
