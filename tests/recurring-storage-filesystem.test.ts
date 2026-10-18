import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
test("fixed storage worker pin matches reviewed filesystem source", () => {
  const source = readFileSync(
    new URL("../scripts/storage_cleanup_source.py", import.meta.url),
  );
  const wrapper = readFileSync(
    new URL(
      "../modules/workflows/recurring-storage-source.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    wrapper.match(/const pin = "([a-f0-9]{64})"/)?.[1],
  );
});
test("real disposable filesystem safety fixtures", () => {
  const result = spawnSync(
    "python3",
    [
      "-B",
      new URL("./storage_cleanup_source_test.py", import.meta.url).pathname,
    ],
    { timeout: 20000, encoding: "utf8", maxBuffer: 65536 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 8 tests/);
});
