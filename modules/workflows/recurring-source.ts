import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonical } from "../contracts/canonical-json.js";
import type { RecurringDefinition } from "./recurring.js";

const identityFields = [
  "id",
  "kind",
  "name",
  "prompt",
  "rrule",
  "target_thread_id",
];
export function automationIdentity(value: Record<string, unknown>) {
  const selected = Object.fromEntries(
    identityFields.map((key) => [key, value[key]]),
  );
  if (Object.values(selected).some((value) => typeof value !== "string"))
    throw Error("Source configuration incomplete");
  return createHash("sha256").update(canonical(selected)).digest("hex");
}

/** Read only. Never edits a Codex automation or trusts a caller-supplied pause flag. */
export async function originalAutomationPaused(
  root: string,
  definition: Pick<RecurringDefinition, "id" | "sourceFingerprint">,
) {
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(definition.id)) return false;
  try {
    const parent = join(root, definition.id),
      path = join(parent, "automation.toml");
    for (const directory of [root, parent]) {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
    }
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 128000)
      return false;
    const text = await readFile(path, "utf8"),
      values: Record<string, unknown> = {};
    if (Buffer.byteLength(text) > 128000) return false;
    for (const line of text.split(/\r?\n/)) {
      const match = /^(\w+) = (.*)$/.exec(line);
      if (!match) continue;
      const key = match[1]!;
      if (Object.hasOwn(values, key)) return false;
      values[key] = JSON.parse(match[2]!);
    }
    return (
      values.id === definition.id &&
      values.status === "PAUSED" &&
      automationIdentity(values) === definition.sourceFingerprint
    );
  } catch {
    return false;
  }
}
