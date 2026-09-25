import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, symlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const repo = fileURLToPath(new URL("../", import.meta.url));
const ref = "3dbcf4e02ef22a2f4851779b11ba4255e8f6a4ae";
const archive = execFileSync(
  "git",
  [
    "archive",
    "--format=tar",
    ref,
    "modules",
    "apps",
    "tests",
    "scripts",
    "tsconfig.json",
    "package.json",
  ],
  { cwd: repo, maxBuffer: 32 * 1024 * 1024 },
);
if (
  createHash("sha256").update(archive).digest("hex") !==
  "e24ff0e40e804857c0db099301ae2dead0d22aaef35411157001b802965ab506"
)
  throw Error("Prior resume authority source hash mismatch");
const dir = join(repo, ".legacy-resume-authority");
await mkdir(dir, { recursive: true });
execFileSync("tar", ["-x", "-C", dir], { input: archive });
try {
  await symlink(join(repo, "node_modules"), join(dir, "node_modules"));
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
execFileSync(join(repo, "node_modules/.bin/tsc"), [], {
  cwd: dir,
  stdio: "inherit",
});
console.log(`Prepared verified schema35 source ${ref}`);
