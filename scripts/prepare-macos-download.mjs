import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

// Runs only in the dedicated disposable Mac build; never installs or starts the app.
assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
assert.equal(process.env.GITHUB_REPOSITORY, "Bittrees-Technology/ai");
assert.equal(process.env.GITHUB_REF, "refs/heads/main");
const sourceCommit = process.env.GITHUB_SHA;
assert.match(sourceCommit ?? "", /^[a-f0-9]{40}$/);
assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sourceCommit);
const bundle = "dist/macos/Bittrees AI.app";
const resources = `${bundle}/Contents/Resources`;
const info = JSON.parse(readFileSync(`${resources}/build-info.json`, "utf8"));
assert.equal(info.sourceCommit, sourceCommit);
assert.equal(info.sourceDirty, false);
assert.equal(info.architecture, "arm64");
assert.equal(info.distribution, "local-development-adhoc");
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
assert.equal(sha256(`${resources}/engine/package-lock.json`), info.dependencyLockSha256);
assert.equal(sha256("package-lock.json"), info.dependencyLockSha256);
execFileSync("codesign", ["--verify", "--deep", "--strict", bundle]);
mkdirSync("dist/download", { recursive: true });
const filename = "Bittrees-AI-macOS-arm64-development.zip";
const archive = `dist/download/${filename}`;
execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", bundle, archive]);
const manifest = {
  format: 1,
  application: "Bittrees AI",
  version: info.version,
  architecture: info.architecture,
  minimumMacOS: "13.0",
  distribution: info.distribution,
  notarized: false,
  sourceCommit,
  workflow: "Bittrees-Technology/ai/.github/workflows/macos-download.yml",
  runUrl: `https://github.com/Bittrees-Technology/ai/actions/runs/${process.env.GITHUB_RUN_ID}`,
  filename,
  bytes: statSync(archive).size,
  sha256: sha256(archive),
  builtAt: info.builtAt,
  automaticUpdates: false,
  installedOrActivated: false,
};
writeFileSync("dist/download/download.json", JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
writeFileSync("dist/download/SHA256SUMS", `${manifest.sha256}  ${filename}\n`, { flag: "wx" });
