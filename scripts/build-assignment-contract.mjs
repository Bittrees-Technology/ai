import { readFile, mkdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const source = new URL(
  "../modules/task-sync/crm-result-lease-contract.mjs",
  import.meta.url,
);
// Frozen Workflows/CRM result lease proof v1; update only with protocol review.
const expected =
  "b72dfc85ef20c2ad9d78ea1156815c9001159686105dd7faf2a8c86acf2f8a34";
if (
  createHash("sha256")
    .update(await readFile(source))
    .digest("hex") !== expected
)
  throw Error("Reviewed CRM lease contract changed");
const target = new URL(
  "../dist/modules/task-sync/crm-result-lease-contract.mjs",
  import.meta.url,
);
await mkdir(new URL(".", target), { recursive: true });
await copyFile(source, target);
