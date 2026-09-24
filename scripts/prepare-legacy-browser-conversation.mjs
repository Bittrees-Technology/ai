import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { build } from "vite";
const repo = fileURLToPath(new URL("../", import.meta.url));
const ref = "bb256d75932c214af57111536ab317231bcedd18",
  expected = "e206fc342a112e056c33b3f364df855df38a6e09c23733f0c2c7d78904bae48f";
const archive = execFileSync(
  "git",
  ["archive", "--format=tar", ref, "modules"],
  { cwd: repo, maxBuffer: 16 * 1024 * 1024 },
);
if (createHash("sha256").update(archive).digest("hex") !== expected)
  throw Error("Prior common-storage source hash mismatch");
const dir = join(repo, ".legacy-browser-conversation");
await mkdir(dir, { recursive: true });
execFileSync("tar", ["-x", "-C", dir], { input: archive });
await writeFile(
  join(dir, "index.ts"),
  `export { BrowserKeyLifecycle } from './modules/remote/browser-key-lifecycle.js';
export { BrowserPeerEnrollment } from './modules/remote/browser-peers.js';
export { BrowserPeerChecks } from './modules/remote/browser-peer-checks.js';
export { BrowserPrivateOutbox } from './modules/remote/browser-outbox.js';
export { BrowserTaskConsent } from './modules/remote/browser-task-consent.js';
export { BrowserTaskComposition } from './modules/remote/browser-task-composition.js';
export { BrowserTaskHistory } from './modules/remote/browser-task-history.js';
`,
);
await build({
  configFile: false,
  root: repo,
  build: {
    outDir: join(repo, "tests/browser/fixture/public/legacy-conversation"),
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
  "Verified version7 module archive and built the actual previous common-storage providers.",
);
