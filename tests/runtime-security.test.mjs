import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPatchedNode } from "../scripts/check-runtime-security.mjs";

test("Mac packaging accepts stable patched Node 24 versions", () => {
  for (const version of ["24.22.1", "v24.22.1", "24.22.2", "24.23.0"])
    assert.doesNotThrow(() => assertPatchedNode(version));
});

test("Mac packaging refuses stale, unsupported, malformed and prerelease runtimes", () => {
  for (const version of [
    "24.20.0",
    "24.22.0",
    "22.23.4",
    "25.5.0",
    "26.12.1",
    "24.22.1-rc.1",
    "24",
    "invalid",
  ])
    assert.throws(() => assertPatchedNode(version), /24.22.1/);
});
