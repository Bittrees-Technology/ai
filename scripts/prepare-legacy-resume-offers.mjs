import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, symlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const repo = fileURLToPath(new URL("../", import.meta.url));
const ref = "59804e6febfb35a62ceb3abee0c9a73ae673780f";
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
  "5b888c1705af5dbeb98e49c3d0eafce1291fe0ef384e2caf754eaac8aad42155"
)
  throw Error("Prior resume authority source hash mismatch");
const dir = join(repo, ".legacy-resume-offers");
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
console.log(`Prepared verified schema37 source ${ref}`);
