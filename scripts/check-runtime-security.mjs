import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// The Mac package copies process.execPath, so the build host must be patched too.
export function assertPatchedNode(version = process.versions.node) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const patched =
    match &&
    Number(match[1]) === 24 &&
    (Number(match[2]) > 22 ||
      (Number(match[2]) === 22 && Number(match[3]) >= 1));
  if (!patched)
    throw new Error(
      "A supported Node 24 runtime at 24.22.1 or later is required; update the build runtime before packaging.",
    );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
)
  assertPatchedNode();
