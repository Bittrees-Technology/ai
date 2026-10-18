import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  assertCleanupScope,
  type StorageCleanupProof,
} from "./recurring-storage-cleanup.js";
const exec = promisify(execFile);
export const activityRequest = z.strictObject({
  operationId: z.string().uuid(),
  path: z.string().max(4096),
  checkout: z.string().max(4096).nullable(),
});
export type ActivityRequest = z.infer<typeof activityRequest>;
export type ActivityResult = {
  available: boolean;
  busy: boolean;
  openFiles: boolean;
};
/** Native-parent read only. Fixed executables; no raw process or file list leaves this function. */
export async function inspectStorageActivity(
  input: ActivityRequest,
  signal: AbortSignal,
): Promise<ActivityResult> {
  assertCleanupScope({
    path: input.path,
    checkout: input.checkout ?? undefined,
    ignoredAndUntracked: true,
    repositoryStatusHash: "0".repeat(64),
  } as StorageCleanupProof);
  const options = {
    signal,
    timeout: 15000,
    maxBuffer: 16 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
  };
  try {
    const processes = await exec("/bin/ps", ["-axo", "comm=,args="], options);
    const opened = await exec("/usr/sbin/lsof", ["-nP", "-Fn"], options);
    const prefix = input.checkout ?? input.path;
    return {
      available: true,
      busy:
        /(^|[/\s])(npm|npx|yarn|pnpm|webpack|turbo|rustc|cargo|tsc)(\s|$)/m.test(
          processes.stdout,
        ) || /(^|\s)(next|vite)\s+(dev|build)(\s|$)/m.test(processes.stdout),
      openFiles: opened.stdout
        .split("\n")
        .some(
          (line) =>
            line.startsWith("n/") &&
            (line.slice(1) === prefix ||
              line.slice(1).startsWith(prefix + "/")),
        ),
    };
  } catch {
    signal.throwIfAborted();
    return { available: false, busy: false, openFiles: false };
  }
}
/** Narrow local read capability. Does not authorize cleanup, arbitrary paths, commands or network access. */
export function storageActivityHelper(options: {
  token: string;
  authorize: (request: ActivityRequest) => Promise<string | null>;
  inspect?: typeof inspectStorageActivity;
}) {
  if (!/^[a-f0-9]{64}$/.test(options.token))
    throw Error("Invalid helper token");
  let busy = false;
  const server = createServer(
    { headersTimeout: 5000, requestTimeout: 5000 },
    async (req, res) => {
      req.setTimeout(5000, () => req.destroy());
      const bodyDeadline = setTimeout(() => req.destroy(), 5000);
      bodyDeadline.unref();
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "application/json");
      const deny = (status: number) => {
        res.writeHead(status);
        res.end('{"error":"Storage safety unavailable"}');
      };
      const actual = Buffer.from(req.headers.authorization ?? ""),
        expected = Buffer.from("Bearer " + options.token);
      if (
        req.socket.remoteAddress !== "127.0.0.1" ||
        req.method !== "POST" ||
        req.url !== "/activity" ||
        req.headers.origin ||
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      ) {
        clearTimeout(bodyDeadline);
        return deny(403);
      }
      let input: ActivityRequest;
      try {
        let body = "";
        for await (const chunk of req) {
          body += chunk.toString();
          if (Buffer.byteLength(body) > 10000) throw Error();
        }
        input = activityRequest.parse(JSON.parse(body));
        assertCleanupScope({
          path: input.path,
          checkout: input.checkout ?? undefined,
          ignoredAndUntracked: true,
          repositoryStatusHash: "0".repeat(64),
        } as StorageCleanupProof);
      } catch {
        return deny(400);
      } finally {
        clearTimeout(bodyDeadline);
      }
      req.setTimeout(0);
      if (busy) return deny(429);
      busy = true;
      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      try {
        const revision = await options.authorize(input);
        if (!revision) return deny(403);
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(20000),
        ]);
        const result = await (options.inspect ?? inspectStorageActivity)(
          input,
          signal,
        );
        if ((await options.authorize(input)) !== revision) return deny(403);
        signal.throwIfAborted();
        res.end(
          JSON.stringify({
            operationId: input.operationId,
            observedAt: Date.now(),
            ...result,
          }),
        );
      } catch {
        deny(503);
      } finally {
        busy = false;
      }
    },
  );
  return server;
}
