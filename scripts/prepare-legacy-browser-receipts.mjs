import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { build } from "vite";
const repo = fileURLToPath(new URL("../", import.meta.url));
const ref = "4eafe8e83171fb298a6d4454ee6ce96dae0bf177",
  expected = "f9578716eedec6213c56fdc450f1de2a12528f30034810aec1dde1c71796fbce";
const archive = execFileSync(
  "git",
  ["archive", "--format=tar", ref, "modules"],
  { cwd: repo, maxBuffer: 16 * 1024 * 1024 },
);
if (createHash("sha256").update(archive).digest("hex") !== expected)
  throw Error("Prior common-storage source hash mismatch");
const dir = join(repo, ".legacy-browser-receipts");
await mkdir(dir, { recursive: true });
execFileSync("tar", ["-x", "-C", dir], { input: archive });
await writeFile(
  join(dir, "index.ts"),
  `export { BrowserConversationContent } from './modules/remote/browser-conversation-content.js';
export { BrowserEndpointKeys } from './modules/remote/browser-endpoint-keys.js';
export { openBrowserKeyRecovery } from './modules/remote/browser-key-recovery.js';
export { BrowserConversationConsent } from './modules/remote/browser-conversation-consent.js';
export { BrowserKeyLifecycle } from './modules/remote/browser-key-lifecycle.js';
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
    outDir: join(repo, "tests/browser/fixture/public/legacy-receipts"),
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
  "Verified version13 module archive and built the actual previous common-storage providers.",
);
