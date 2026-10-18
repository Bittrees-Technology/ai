import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  automationIdentity,
  originalAutomationPaused,
} from "../modules/workflows/recurring-source.js";
test("cutover requires actual paused source and unchanged instructions/schedule", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "recurring-source-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = {
    id: "example",
    kind: "heartbeat",
    name: "Example",
    prompt: "Keep scope exact",
    rrule: "FREQ=DAILY;BYHOUR=9",
    target_thread_id: "original-chat",
    status: "ACTIVE",
    updated_at: 1,
  };
  const definition = {
    id: source.id,
    sourceFingerprint: automationIdentity(source),
  };
  await mkdir(join(root, source.id));
  const path = join(root, source.id, "automation.toml");
  const save = (v: unknown) =>
    writeFile(
      path,
      Object.entries(v as object)
        .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
        .join("\n"),
    );
  await save(source);
  assert.equal(await originalAutomationPaused(root, definition), false);
  await save({ ...source, status: "PAUSED", updated_at: 2 });
  assert.equal(await originalAutomationPaused(root, definition), true);
  await save({ ...source, status: "PAUSED", prompt: "Expanded scope" });
  assert.equal(await originalAutomationPaused(root, definition), false);
  assert.equal(
    await originalAutomationPaused(root, { ...definition, id: "../example" }),
    false,
  );
});
test("cutover rejects symlinks, missing fields and duplicate TOML keys", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "recurring-source-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "example"));
  const path = join(root, "example", "automation.toml"),
    other = join(root, "payload");
  await writeFile(other, 'status = "PAUSED"');
  await symlink(other, path);
  const definition = { id: "example", sourceFingerprint: "a".repeat(64) };
  assert.equal(await originalAutomationPaused(root, definition), false);
  await rm(path);
  await writeFile(path, 'status = "PAUSED"\nstatus = "PAUSED"');
  assert.equal(await originalAutomationPaused(root, definition), false);
});
