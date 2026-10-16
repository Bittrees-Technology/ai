import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Vault } from "../modules/storage/vault.js";
import { localWorkflows } from "../apps/companion/workflows.js";
test("local synchronization projects only safe metadata and never sends research content or template prompts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "local-workflow-index-")),
    vault = new Vault(randomBytes(32)),
    original = globalThis.fetch,
    id = randomUUID();
  let captured: any;
  try {
    await writeFile(
      join(dir, "workflow-device.enc"),
      vault.seal({ controlToken: "a".repeat(64) }, "workflow-device"),
    );
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://ai.bittrees.org/api/workflows");
      captured = JSON.parse(String(init?.body));
      return Response.json({ synced: true });
    };
    const flow = localWorkflows(
      dir,
      vault,
      () => [],
      () =>
        [
          {
            id,
            revision: 2,
            definition: {
              kind: "investor-research",
              name: "Private research",
              prompt: "Private prompt",
              urls: ["https://private.example"],
              brief: "Private brief",
            },
            state: "running",
            progress: {
              peopleSaved: 4,
              target: 74,
              datasetPeople: 130,
              datasetTarget: 200,
              crmPeople: 126,
              pagesProcessed: 64,
              queued: 18,
              failures: 14,
              skipped: 153,
              measuredAt: "2026-10-16T17:00:00.000Z",
            },
          },
        ] as any,
    );
    await flow.sync();
    assert.deepEqual(captured.input.entries, [
      {
        id,
        revision: 2,
        kind: "investor-research",
        state: "running",
        progress: {
          peopleSaved: 4,
          target: 74,
          datasetPeople: 130,
          datasetTarget: 200,
          crmPeople: 126,
          pagesProcessed: 64,
          queued: 18,
          failures: 14,
          skipped: 153,
          measuredAt: "2026-10-16T17:00:00.000Z",
        },
      },
    ]);
    assert.ok(!JSON.stringify(captured).includes("Private"));
    assert.ok(!JSON.stringify(captured).includes("private.example"));
  } finally {
    globalThis.fetch = original;
    await rm(dir, { recursive: true, force: true });
  }
});
test("a local workspace without workflow pairing never registers or uploads automatically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "local-workflow-unpaired-")),
    original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      throw Error("unexpected network");
    };
    await localWorkflows(dir, new Vault(randomBytes(32)), () => []).sync();
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
    await rm(dir, { recursive: true, force: true });
  }
});

test("project-task catalogue accepts only safe metadata", async () => {
  const { localCatalogueSchema } =
    await import("../modules/coordinator/workflow-catalogue.js");
  const input = {
    action: "catalogue",
    observedAt: Date.now(),
    entries: [
      { id: randomUUID(), revision: 1, kind: "crm-task-work", state: "paused" },
      {
        id: randomUUID(),
        revision: 2,
        kind: "crm-task-planning",
        state: "complete",
      },
    ],
  };
  assert.equal(localCatalogueSchema.parse(input).entries.length, 2);
  assert.throws(() =>
    localCatalogueSchema.parse({
      ...input,
      entries: [{ ...input.entries[0], taskText: "private" }],
    }),
  );
});

test("existing qualification jobs cannot invalidate the whole paired workflow catalogue", async () => {
  const { localCatalogueSchema } =
    await import("../modules/coordinator/workflow-catalogue.js");
  const entries = [
    {
      id: randomUUID(),
      revision: 1,
      kind: "investor-qualification",
      state: "complete",
    },
    {
      id: randomUUID(),
      revision: 2,
      kind: "investor-research",
      state: "running",
    },
  ];
  assert.equal(
    localCatalogueSchema.parse({
      action: "catalogue",
      observedAt: Date.now(),
      entries,
    }).entries.length,
    2,
  );
});
