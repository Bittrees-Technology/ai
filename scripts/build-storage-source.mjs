import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const worker = new URL("./storage_cleanup_source.py", import.meta.url);
const wrapper = await readFile(
  new URL("../modules/workflows/recurring-storage-source.ts", import.meta.url),
  "utf8",
);
const expected = wrapper.match(/const pin = "([a-f0-9]{64})"/)?.[1];
if (
  !expected ||
  createHash("sha256")
    .update(await readFile(worker))
    .digest("hex") !== expected
)
  throw Error("Storage worker and reviewed pin differ");
const target = new URL(
  "../dist/modules/workflows/storage_cleanup_source.py",
  import.meta.url,
);
await mkdir(new URL(".", target), { recursive: true });
await copyFile(worker, target);
