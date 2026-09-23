import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  fsyncSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { freemem } from "node:os";
import { z } from "zod";
import { StoreError } from "../../modules/storage/store.js";
export const executionLimitsSchema = z
  .object({
    parallelTasks: z.number().int().min(1).max(4),
    maxTaskSeconds: z.number().int().min(1).max(1800),
    minFreeMemoryGiB: z.number().int().min(0).max(1024),
    pauseNewTasks: z.boolean(),
  })
  .strict();
const documentSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    limits: executionLimitsSchema,
  })
  .strict();
export type ExecutionLimits = z.infer<typeof executionLimitsSchema>;
export const defaultExecutionLimits: ExecutionLimits = {
  parallelTasks: 1,
  maxTaskSeconds: 120,
  minFreeMemoryGiB: 0,
  pauseNewTasks: false,
};
/** Machine-local settings, independent of content backups and model profiles.
 * The companion's exclusive listening port provides the single-writer boundary. */
export class ExecutionControls {
  private value: z.infer<typeof documentSchema>;
  constructor(
    private path: string,
    private freeBytes: () => number = freemem,
  ) {
    this.value = {
      version: 1,
      revision: 0,
      limits: { ...defaultExecutionLimits },
    };
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 4096)
        throw new Error("Invalid execution settings file");
      this.value = documentSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
    } finally {
      closeSync(fd);
    }
  }
  read() {
    return structuredClone(this.value);
  }
  update(raw: unknown) {
    const input = z
      .object({
        expectedRevision: z.number().int().nonnegative(),
        limits: executionLimitsSchema,
        confirmed: z.literal(true),
      })
      .strict()
      .parse(raw);
    if (input.expectedRevision !== this.value.revision)
      throw new StoreError("CONFLICT");
    const next = {
      version: 1 as const,
      revision: this.value.revision + 1,
      limits: input.limits,
    };
    const temporary = this.path + "." + randomUUID() + ".tmp";
    try {
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(next) + "\n");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.path);
      this.value = next;
    } finally {
      rmSync(temporary, { force: true });
    }
    return this.read();
  }
  admission(activeTasks: number) {
    const { limits } = this.value;
    let freeMemoryBytes: number | null = null;
    try {
      const n = this.freeBytes();
      if (Number.isFinite(n) && n >= 0) freeMemoryBytes = n;
    } catch {
      /* Unknown is not zero. */
    }
    const reason = limits.pauseNewTasks
      ? "paused"
      : activeTasks >= limits.parallelTasks
        ? "busy"
        : limits.minFreeMemoryGiB > 0 && freeMemoryBytes === null
          ? "memory_unknown"
          : limits.minFreeMemoryGiB > 0 &&
              freeMemoryBytes! < limits.minFreeMemoryGiB * 1024 ** 3
            ? "low_memory"
            : "ready";
    return { ...this.read(), activeTasks, freeMemoryBytes, reason };
  }
}
