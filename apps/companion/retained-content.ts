import { createHash } from "node:crypto";
import { lstat, opendir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { StoreError } from "../../modules/storage/store.js";
import { resolveActiveContent } from "./active-content.js";
export const contentIdPattern =
  /^(original|bittrees-ai-recovered-[A-Za-z0-9]{6})$/;
const dataFiles = [
  "tasks.db",
  "tasks.db-wal",
  "tasks.db-shm",
  "tasks.db-journal",
  "memory.db",
  "memory.db-wal",
  "memory.db-shm",
  "memory.db-journal",
];
const copyFiles = [...dataFiles, "RECOVERY.json"];
export type RetainedCopy = {
  id: string;
  bytes: number;
  modifiedAt: string;
  review: string;
  protectedAs: "active" | "previous" | null;
};
async function directory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new StoreError("INVALID_INPUT");
}
async function optionalStat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
/** The caller must own the companion port. Only inactive managed content is removable. */
export function retainedContent(base: string, activeDirectory: string) {
  let busy = false;
  async function exclusive<T>(fn: () => Promise<T>) {
    if (busy) throw new StoreError("CONFLICT");
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  }
  async function selection() {
    await directory(base);
    const value = await resolveActiveContent(base);
    if (value.directory !== activeDirectory) throw new StoreError("CONFLICT");
    return value;
  }
  async function inspect(
    id: string,
    current: Awaited<ReturnType<typeof selection>>,
  ): Promise<RetainedCopy> {
    if (!contentIdPattern.test(id)) throw new StoreError("INVALID_INPUT");
    const original = id === "original",
      path = original ? base : join(base, "stores", id);
    if (!original) {
      await directory(join(base, "stores"));
      await directory(path);
      const children = await readdir(path);
      if (children.some((name) => !copyFiles.includes(name)))
        throw new StoreError("INVALID_INPUT");
    }
    const digest = createHash("sha256");
    const identity = await lstat(path);
    digest.update(JSON.stringify([id, identity.dev, identity.ino]));
    let bytes = 0,
      modified = 0,
      files = 0;
    for (const file of original ? dataFiles : copyFiles) {
      const info = await optionalStat(join(path, file));
      if (!info) {
        digest.update(JSON.stringify([file, null]));
        continue;
      }
      if (!info.isFile() || info.isSymbolicLink())
        throw new StoreError("INVALID_INPUT");
      files++;
      bytes += info.size;
      modified = Math.max(modified, info.mtimeMs);
      digest.update(
        JSON.stringify([
          file,
          info.dev,
          info.ino,
          info.size,
          info.mtimeMs,
          info.ctimeMs,
        ]),
      );
    }
    if (original && files === 0) throw new StoreError("NOT_FOUND");
    const protectedAs =
      id === (current.name ?? "original")
        ? "active"
        : current.name !== null && id === (current.previous ?? "original")
          ? "previous"
          : null;
    return {
      id,
      bytes,
      modifiedAt: new Date(modified).toISOString(),
      review: digest.digest("hex"),
      protectedAs,
    };
  }
  return {
    list(after?: string) {
      return exclusive(async () => {
        if (after !== undefined && !contentIdPattern.test(after))
          throw new StoreError("INVALID_INPUT");
        const current = await selection();
        const names: string[] = [];
        const keep = (name: string) => {
          if ((!after || name > after) && contentIdPattern.test(name)) {
            names.push(name);
            names.sort();
            if (names.length > 51) names.pop();
          }
        };
        const parent = join(base, "stores");
        if (await optionalStat(parent)) {
          await directory(parent);
          for await (const item of await opendir(parent))
            if (
              item.name !== "original" &&
              item.isDirectory() &&
              !item.isSymbolicLink()
            )
              keep(item.name);
        }
        if (
          (
            await Promise.all(
              dataFiles.map((file) => optionalStat(join(base, file))),
            )
          ).some(Boolean)
        )
          keep("original");
        const items: RetainedCopy[] = [];
        for (const name of names.slice(0, 50))
          items.push(await inspect(name, current));
        return {
          items,
          nextCursor: names.length > 50 ? items.at(-1)!.id : null,
        };
      });
    },
    remove(id: string, review: string) {
      return exclusive(async () => {
        const current = await selection(),
          copy = await inspect(id, current);
        if (copy.protectedAs) throw new StoreError("CONFLICT");
        if (!/^[a-f0-9]{64}$/.test(review) || copy.review !== review)
          throw new StoreError("CONFLICT");
        // Confirm again immediately before deletion; the live engine's selection
        // must not have changed since the list/review or during filesystem inspection.
        const final = await selection();
        if (final.name !== current.name || final.previous !== current.previous)
          throw new StoreError("CONFLICT");
        if (id === "original") {
          for (const file of dataFiles)
            await rm(join(base, file), { force: true });
        } else await rm(join(base, "stores", id), { recursive: true });
        return { deleted: true as const };
      });
    },
  };
}
