import type { ExecutionControls } from "./execution-limits.js";
import {
  arch,
  availableParallelism,
  freemem,
  platform,
  totalmem,
  uptime,
} from "node:os";
import { statfs } from "node:fs/promises";
import { maxFileBytes, maxTotalBytes } from "../../modules/models/imports.js";
/** Device-local operational data only. No hostname, paths, interfaces, account or content. */
export async function deviceStatus(
  directory: string,
  execution?: ReturnType<ExecutionControls["admission"]>,
) {
  let diskFreeBytes: number | null = null;
  try {
    const disk = await statfs(directory);
    diskFreeBytes = disk.bavail * disk.bsize;
  } catch {
    /* Unavailable capacity is unknown, never zero. */
  }
  const memoryBytes = totalmem();
  return {
    sampledAt: new Date().toISOString(),
    platform: platform(),
    architecture: arch(),
    logicalProcessors: availableParallelism(),
    memory: {
      totalBytes: memoryBytes,
      freeBytes: freemem(),
      companionBytes: process.memoryUsage().rss,
    },
    diskFreeBytes,
    uptimeSeconds: Math.floor(uptime()),
    limits: {
      importFileBytes: maxFileBytes,
      importTotalBytes: maxTotalBytes,
      importMemoryBytes: Math.floor(memoryBytes * 0.6),
      parallelGenerations: execution?.limits.parallelTasks ?? 1,
    },
    ...(execution ? { execution } : {}),
    remoteAccess: false,
    cloudFallback: false,
  };
}
export type DeviceStatus = Awaited<ReturnType<typeof deviceStatus>>;
