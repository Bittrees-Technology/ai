import test from "node:test";
import assert from "node:assert/strict";
import {
  localCatalogueSchema,
  syncLocalCatalogue,
} from "../modules/coordinator/workflow-catalogue.js";
import { randomUUID } from "node:crypto";
const input = {
  action: "catalogue",
  observedAt: Date.now(),
  entries: [{ id: randomUUID(), revision: 1, kind: "draft" }],
};
test("local workflow index excludes names, prompts, model settings, output and source authority", () => {
  assert.equal(localCatalogueSchema.parse(input).entries.length, 1);
  for (const field of [
    "name",
    "prompt",
    "output",
    "modelProfileId",
    "owner",
    "scopes",
    "signature",
  ])
    assert.throws(() =>
      localCatalogueSchema.parse({
        ...input,
        entries: [{ ...input.entries[0], [field]: "private" }],
      }),
    );
  assert.throws(() =>
    localCatalogueSchema.parse({
      ...input,
      entries: Array(171).fill(input.entries[0]),
    }),
  );
});
test("catalogue rejects invalid tokens, duplicate IDs and old observations before opening storage", async () => {
  let opens = 0;
  const pool = {
    connect: async () => {
      opens++;
      throw Error("unexpected");
    },
  } as any;
  await assert.rejects(syncLocalCatalogue(pool, "invalid", input), /DENIED/);
  await assert.rejects(
    syncLocalCatalogue(pool, "a".repeat(64), {
      ...input,
      entries: [input.entries[0], input.entries[0]],
    }),
    /DENIED/,
  );
  await assert.rejects(
    syncLocalCatalogue(pool, "a".repeat(64), {
      ...input,
      observedAt: Date.now() - 400000,
    }),
    /DENIED/,
  );
  assert.equal(opens, 0);
});
test("unpaired devices cannot publish a catalogue or acquire execution authority", async () => {
  const queries: string[] = [];
  const db = {
    query: async (q: string) => {
      queries.push(q);
      return {
        rows: q.startsWith("SELECT id,")
          ? [{ id: randomUUID(), wallet_address: null }]
          : [],
      };
    },
    release() {},
  };
  const result = await syncLocalCatalogue(
    { connect: async () => db } as any,
    "a".repeat(64),
    input,
  );
  assert.equal(result.synced, false);
  assert.ok(queries.includes("ROLLBACK"));
  assert.ok(!queries.some((q) => q.includes("INSERT")));
});

test("research progress is bounded numeric metadata and rejects content or authority fields", () => {
  const progress = {
    peopleSaved: 4,
    target: 74,
    datasetPeople: 130,
    datasetTarget: 200,
    crmPeople: 126,
    pagesProcessed: 64,
    queued: 18,
    failures: 14,
    skipped: 153,
    measuredAt: new Date().toISOString(),
  };
  const entry = {
    id: randomUUID(),
    revision: 1,
    kind: "investor-research",
    progress,
  };
  assert.deepEqual(
    localCatalogueSchema.parse({ ...input, entries: [entry] }).entries[0]!
      .progress,
    progress,
  );
  for (const patch of [
    { peopleSaved: -1 },
    { queued: 10001 },
    { target: 201 },
    { names: ["Private Person"] },
    { urls: ["https://private.example"] },
    { owner: "other" },
  ])
    assert.throws(() =>
      localCatalogueSchema.parse({
        ...input,
        entries: [{ ...entry, progress: { ...progress, ...patch } }],
      }),
    );
});

test("directory receipts sync bounded progress without source content", () => {
  const progress = {
    kind: "directory",
    recentReceipts: 10,
    modelRuns: 9,
    completed: 4,
    needsResearch: 6,
    queuedFollowups: 2,
    completedFollowups: 1,
    needsAttention: 0,
    measuredAt: new Date().toISOString(),
    latestReceiptId: randomUUID(),
    evidenceHash: "a".repeat(64),
  };
  const entry = {
    id: randomUUID(),
    revision: 1,
    kind: "cryptodirectory-validation",
    progress,
  };
  assert.deepEqual(
    localCatalogueSchema.parse({ ...input, entries: [entry] }).entries[0]!
      .progress,
    progress,
  );
  for (const patch of [
    { source: "private text" },
    { url: "https://example.org" },
    { modelRuns: 10001 },
    { evidenceHash: "not-a-digest" },
  ])
    assert.throws(() =>
      localCatalogueSchema.parse({
        ...input,
        entries: [{ ...entry, progress: { ...progress, ...patch } }],
      }),
    );
});
