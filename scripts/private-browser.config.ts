import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
// Browser automation for this task is restricted to disposable GitHub runners.
// This gate prevents the normal command from driving the user's local browsers.
if (process.env.GITHUB_ACTIONS !== "true")
  throw Error("Run private browser tests on the GitHub CI runner.");
export default defineConfig({
  testDir: "../tests/browser",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30000,
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/private-browser.json" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:44137",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    command:
      "npx vite build tests/browser/fixture --outDir ../../../.private-browser-fixture --emptyOutDir && npx vite preview tests/browser/fixture --outDir ../../../.private-browser-fixture --host 127.0.0.1 --port 44137 --strictPort",
    url: "http://127.0.0.1:44137",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
