/** Build the exact public PR151 browser private-storage providers for actual IndexedDB upgrade checks. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { build } from "vite";
const repo = fileURLToPath(new URL("../", import.meta.url)),
  ref = "3d692912ebecb14a04748b92226435ef1eb36e9f";
const hashes = {
  "browser-outbox.ts":
    "bd0361fd4a8df1066d14b80f58860dd2c551d35020b802027c185ab664d5ecd3",
  "private-peer-contracts.ts":
    "ad3cbb8cbcb15dc911160f8240b0245b32fb729fa2e8a26d815153b17965a85e",
  "private-envelope.ts":
    "bef94de718b6c2329cba90ef74a45d30edb890956a7318ffff5118016fdaf5ad",
  "private-task-contracts.ts":
    "24ad7932b0b6f11de6b1444cbb033ee28fa87b27c6555335eda41dc1993f37bb",
  "browser-key-state.ts":
    "69b1a9bb3a897d61f2888c3b3362ed5cc72a33a08955888225ff09c9297efdf8",
  "browser-key-lifecycle.ts":
    "0bd9dcfd259bc30ab90b6544fabc9197c09cee115f87144bc4d393c99eead948",
  "browser-endpoint-keys.ts":
    "6bcbac0d1b16b3e3f16abec3527d7e541364968ae90f18b5f3ca6b2cdb5418c4",
  "browser-key-recovery.ts":
    "1f27b130105816797afbb7a45bde8f85a93296f6d326e38f657bd7b3e308da68",
  "browser-peers.ts":
    "7ea0a71d25b11d13cb95619f6c87e5a7952ce0510b91054bfd2619542f5247e1",
  "private-peer-state.ts":
    "4423095cd3e46f2ec07cc56d09433f0dadaa089b87a1a8a7ff67f3375636b111",
};
const dir = join(repo, ".legacy-browser-private");
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
  "export {BrowserPrivateOutbox} from './browser-outbox.js';export {BrowserPeerEnrollment} from './browser-peers.js';export {BrowserKeyLifecycle} from './browser-key-lifecycle.js';export {BrowserEndpointKeys} from './browser-endpoint-keys.js';export {openBrowserKeyRecovery} from './browser-key-recovery.js';\n",
);
await build({
  configFile: false,
  root: repo,
  build: {
    outDir: join(repo, "tests/browser/fixture/public/legacy-private"),
    emptyOutDir: true,
    lib: {
      entry: join(dir, "index.ts"),
      formats: ["es"],
      fileName: () => "index.js",
    },
    minify: false,
  },
});
console.log(
  "Verified PR151 legacy source hashes and built isolated browser compatibility module.",
);
