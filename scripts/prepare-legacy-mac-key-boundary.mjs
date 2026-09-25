import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, symlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const repo = fileURLToPath(new URL("../", import.meta.url));
const ref = "d3ee4a9e5f82533509fde131e2e284906ed2d9fe";
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
  "a6f7db5edb23b123949fe5841212d4cc7dfd9ada2b8a4edf5b1627a691bcb36d"
)
  throw Error("Prior Mac key boundary source hash mismatch");
const dir = join(repo, ".legacy-mac-key-boundary");
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
console.log(`Prepared verified schema31 source ${ref}`);
