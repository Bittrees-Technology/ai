/** Build the exact public PR143 browser key provider for actual IndexedDB upgrade checks. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { build } from "vite";
const repo = fileURLToPath(new URL("../", import.meta.url)),
  ref = "84132a15d0ddf6027bc9bc8d8d9dbf4217fa69f0";
const hashes = {
  "browser-endpoint-keys.ts":
    "ad415d0fee2b56a73e5ab8b0d5ce184d5fc73bc6c7540af2b9dd24232f052731",
  "browser-key-recovery.ts":
    "dd0717bea99d8d76ce31158f014e11f3a0f5e2c61f41cf1a53ea172268732585",
  "private-peer-contracts.ts":
    "ad3cbb8cbcb15dc911160f8240b0245b32fb729fa2e8a26d815153b17965a85e",
};
const dir = join(repo, ".legacy-browser-keys");
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
  "export {BrowserEndpointKeys} from './browser-endpoint-keys.js';export {openBrowserKeyRecovery} from './browser-key-recovery.js';\n",
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
      fileName: () => "legacy-keys.js",
    },
    minify: false,
  },
});
console.log(
  "Verified PR143 legacy source hashes and built isolated browser compatibility module.",
);
