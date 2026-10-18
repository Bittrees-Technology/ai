import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseChecker } from "../apps/companion/updates.js";
const installed = "a".repeat(40),
  source = "b".repeat(40);
function fixture(status = "ahead", success = true) {
  let calls = 0;
  const prefix =
    "https://github.com/Bittrees-Technology/ai/releases/download/v0.1.0-preview.300/";
  const request: typeof fetch = async (input) => {
    calls++;
    const url = String(input);
    let value: any;
    if (url.includes("/releases?"))
      value = [
        {
          tag_name: "v0.1.0-preview.300",
          draft: false,
          prerelease: true,
          assets: [
            "download.json",
            "Bittrees-AI-macOS-arm64-development.zip",
          ].map((name) => ({ name, browser_download_url: prefix + name })),
        },
      ];
    else if (url.endsWith("download.json"))
      value = {
        format: 1,
        application: "Bittrees AI",
        architecture: "arm64",
        sourceCommit: source,
        workflow: "Bittrees-Technology/ai/.github/workflows/macos-download.yml",
        filename: "Bittrees-AI-macOS-arm64-development.zip",
        sha256: "c".repeat(64),
      };
    else if (url.includes("/compare/")) value = { status };
    else if (url.includes("/pulls?")) value = [];
    else
      value = {
        check_runs: [
          "checks",
          "macos-package",
          "autonote-integration",
          "remote-status-integration",
          "browser-private-protocol",
        ].map((name, id) => ({
          name,
          id,
          app: { slug: "github-actions" },
          conclusion: success ? "success" : "failure",
        })),
      };
    return new Response(JSON.stringify(value));
  };
  return {
    check: releaseChecker(
      async () => ({ sourceCommit: installed, sourceDirty: false }),
      request,
    ),
    calls: () => calls,
  };
}
test("offers successful published preview and coalesces/caches checks", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.check(), f.check()]);
  assert.equal(a.state, "available");
  assert.equal(a.tag, b.tag);
  assert.equal(f.calls(), 4);
  await f.check();
  assert.equal(f.calls(), 4);
});
test("never offers older, identical or divergent source as an upgrade", async () => {
  for (const status of ["behind", "identical", "diverged"])
    assert.equal((await fixture(status).check()).state, "current");
});
test("failed release checks suppress notification", async () =>
  assert.equal((await fixture("ahead", false).check()).state, "current"));
test("offline status is unavailable, not up to date, and backs off", async () => {
  let calls = 0;
  const check = releaseChecker(
    async () => ({ sourceCommit: installed, sourceDirty: false }),
    async () => {
      calls++;
      throw Error("offline");
    },
  );
  assert.equal((await check()).state, "unavailable");
  await check();
  assert.equal(calls, 1);
});
