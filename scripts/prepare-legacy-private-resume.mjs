import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, symlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const repo = fileURLToPath(new URL("../", import.meta.url));
const ref = "3c697c8388b0a06ab570db61637f6fe70ee687a6";
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
  "234ad3525b4e59ae1f7eae97cfc2942b73c880ca8e57c9dbe9f1f3e7c9c1145e"
)
  throw Error("Prior resume authority source hash mismatch");
const dir = join(repo, ".legacy-private-resume");
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
console.log(`Prepared verified schema36 source ${ref}`);
