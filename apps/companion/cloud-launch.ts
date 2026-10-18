import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { cloudHelper } from "../../modules/agents/cloud-helper.js";
if (process.argv.length !== 2) throw Error("No launcher arguments accepted");
const resources = fileURLToPath(new URL("../../../../", import.meta.url));
const token = randomBytes(32).toString("hex");
const helper = cloudHelper(token);
await new Promise<void>((resolve, reject) => {
  helper.once("error", reject);
  helper.listen(0, "127.0.0.1", resolve);
});
const address = helper.address();
if (!address || typeof address === "string") throw Error("Helper unavailable");
const child = spawn(
  "/usr/bin/sandbox-exec",
  [
    "-f",
    join(resources, "offline.sb"),
    join(resources, "../MacOS/BittreesAI-offline-host"),
  ],
  {
    stdio: "inherit",
    env: {
      HOME: process.env.HOME!,
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "en_US.UTF-8",
      BITTREES_CLOUD_HELPER_URL: `http://127.0.0.1:${address.port}/cloud`,
      BITTREES_CLOUD_HELPER_TOKEN: token,
    },
  },
);
child.once("exit", () => {
  helper.closeAllConnections();
  helper.close();
});
child.once("error", () => {
  helper.closeAllConnections();
  helper.close();
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => child.kill(signal));
