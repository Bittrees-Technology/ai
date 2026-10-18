import { storageActivityHelper } from "../../modules/workflows/storage-activity-helper.js";
import { z } from "zod";
import { cloudHelper } from "../../modules/agents/cloud-helper.js";
import { randomBytes, createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { myCloudHelper } from "../../modules/workflows/mycloud-helper.js";
import { pinnedMyCloudCheck } from "../../modules/workflows/recurring-mycloud-source.js";
const exec = promisify(execFile),
  hash = (text: string | Buffer) =>
    createHash("sha256").update(text).digest("hex");
export async function verifyMyCloudSshIdentity() {
  const root = "/Users/jhineline/.ssh";
  for (const path of [root, root + "/mycloud_admin", root + "/known_hosts"]) {
    const s = await lstat(path);
    if (s.isSymbolicLink() || s.mode & 0o022)
      throw Error("SSH identity path changed");
  }
  const keys = await exec(
    "/usr/bin/ssh-keygen",
    ["-F", "192.168.1.164", "-f", root + "/known_hosts"],
    { timeout: 5000, maxBuffer: 16384 },
  );
  if (
    hash(
      keys.stdout
        .split("\n")
        .filter((l) => l && !l.startsWith("#"))
        .join("\n"),
    ) !== "7782fec48ff4e3d17529b77a8ed1dd1c0fce1371b32506477e17b2b122cfe649"
  )
    throw Error("NAS host identity changed");
}

async function main() {
  // This entry lives in Resources/engine/dist/apps/companion. Caller cannot supply a command or destination.
  if (process.argv.length !== 2) throw Error("Launcher takes no arguments");
  const resources = fileURLToPath(new URL("../../../../", import.meta.url));
  const token = randomBytes(32).toString("hex");
  const helper = myCloudHelper({
    token,
    journalPath:
      "/Users/jhineline/Library/Application Support/Bittrees AI/mycloud-helper-operations.db",
    authorize: async () => {
      try {
        const r = await fetch(
          "http://127.0.0.1:43127/internal/mycloud-approval",
          {
            headers: { authorization: "Bearer " + token },
            redirect: "error",
            signal: AbortSignal.timeout(2000),
          },
        );
        if (!r.ok) {
          await r.body?.cancel();
          return null;
        }
        const text = await r.text();
        if (text.length > 256) return null;
        return z
          .strictObject({ revision: z.string().regex(/^[a-f0-9]{64}$/) })
          .parse(JSON.parse(text)).revision;
      } catch {
        return null;
      }
    },
    check: async (signal) => {
      await verifyMyCloudSshIdentity();
      const raw = await pinnedMyCloudCheck(signal);
      await verifyMyCloudSshIdentity();
      return raw;
    },
  });
  await new Promise<void>((r) => helper.server.listen(0, "127.0.0.1", r));
  const address = helper.server.address();
  if (!address || typeof address === "string") throw Error("No helper address");
  // Preserve the separately authorized free-only broker. No model calls on startup.
  const cloudToken = randomBytes(32).toString("hex");
  const cloud = cloudHelper(cloudToken);
  try {
    await new Promise<void>((resolve, reject) => {
      cloud.once("error", reject);
      cloud.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    await helper.close();
    throw error;
  }
  const cloudAddress = cloud.address();
  if (!cloudAddress || typeof cloudAddress === "string") {
    await helper.close();
    cloud.close();
    throw Error("Cloud helper unavailable");
  }
  const activityToken = randomBytes(32).toString("hex");
  const activity = storageActivityHelper({
    token: activityToken,
    authorize: async (request) => {
      try {
        const response = await fetch(
          "http://127.0.0.1:43127/internal/storage-activity-approval?operationId=" +
            request.operationId,
          {
            headers: { authorization: "Bearer " + activityToken },
            redirect: "error",
            signal: AbortSignal.timeout(2000),
          },
        );
        const text = await response.text();
        if (!response.ok || text.length > 10000) return null;
        const value = z
          .strictObject({
            operationId: z.string().uuid(),
            path: z.string(),
            checkout: z.string().nullable(),
            revision: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .parse(JSON.parse(text));
        return value.operationId === request.operationId &&
          value.path === request.path &&
          value.checkout === request.checkout
          ? value.revision
          : null;
      } catch {
        return null;
      }
    },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      activity.once("error", reject);
      activity.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    cloud.closeAllConnections();
    cloud.close();
    await helper.close();
    throw error;
  }
  const activityAddress = activity.address();
  if (!activityAddress || typeof activityAddress === "string")
    throw Error("Storage activity helper unavailable");
  const closeHelpers = async () => {
    activity.closeAllConnections();
    activity.close();
    cloud.closeAllConnections();
    cloud.close();
    await helper.close();
  };
  const child = spawn(
    "/usr/bin/sandbox-exec",
    [
      "-f",
      resolve(resources, "offline.sb"),
      resolve(resources, "../MacOS/BittreesAI-offline-host"),
    ],
    {
      stdio: "inherit",
      env: {
        HOME: "/Users/jhineline",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "en_US.UTF-8",
        BITTREES_STORAGE_ACTIVITY_URL: `http://127.0.0.1:${activityAddress.port}/activity`,
        BITTREES_STORAGE_ACTIVITY_TOKEN: activityToken,
        BITTREES_MYCLOUD_HELPER_URL: `http://127.0.0.1:${address.port}`,
        BITTREES_MYCLOUD_HELPER_TOKEN: token,
        BITTREES_CLOUD_HELPER_URL: `http://127.0.0.1:${cloudAddress.port}/cloud`,
        BITTREES_CLOUD_HELPER_TOKEN: cloudToken,
      },
    },
  );
  const stop = () => child.kill("SIGTERM");
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  child.once("error", () => {
    void closeHelpers().finally(() => process.exit(1));
  });
  child.once("exit", (code) => {
    void closeHelpers().finally(() => process.exit(code ?? 1));
  });
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void main().catch(() => {
    console.error("MyCloud scoped launcher could not start");
    process.exit(1);
  });
