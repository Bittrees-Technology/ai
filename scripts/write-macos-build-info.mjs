import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const destination = process.argv[2];
if (!destination) throw Error("Build-info destination is required");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw Error("Invalid source revision");
const sourceDirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length !== 0;
const app = JSON.parse(readFileSync("package.json", "utf8"));
const info = {
  format: 1,
  application: "Bittrees AI",
  version: app.version,
  sourceCommit,
  sourceDirty,
  builtAt: new Date().toISOString(),
  architecture: process.arch,
  nodeVersion: process.version,
  dependencyLockSha256: createHash("sha256").update(readFileSync("package-lock.json")).digest("hex"),
  distribution: "local-development-adhoc",
};
writeFileSync(destination, JSON.stringify(info, null, 2) + "\n", { flag: "wx" });
