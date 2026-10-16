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
