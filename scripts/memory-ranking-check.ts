import { randomBytes } from "node:crypto";
import { MemoryStore } from "../modules/memory/store.js";
import { Vault } from "../modules/storage/vault.js";
// Manually enumerated lexical cases, not semantic/factual or model-quality acceptance.
const cases = [
  { query: "art report", full: "art report", partial: "quarterly report" },
  { query: "red account", full: "red account", partial: "credit account" },
  { query: "net change", full: "net change", partial: "internet change" },
  { query: "2026 report", full: "2026 report", partial: "12026 report" },
  { query: "cafe deadline", full: "café deadline", partial: "deadline only" },
  {
    query: "resume approved",
    full: "résumé approved",
    partial: "approved only",
  },
];
const owner = { userId: "ranking-fixture", tenantId: "synthetic" };
const results = [];
for (const [i, c] of cases.entries()) {
  const memory = new MemoryStore(
    ":memory:",
    new Vault(randomBytes(32)),
    async () => true,
    () => 1000,
  );
  try {
    for (const [label, text] of [
      ["full", c.full],
      ["partial", c.partial],
    ]) {
      const item = await memory.add(owner, {
        type: "fact",
        text,
        origin: "user",
        sources: [
          {
            app: "local",
            tenantId: owner.tenantId,
            resourceId: `${i}-${label}`,
            revision: "1",
          },
        ],
      });
      await memory.review(owner, item.id, 1, {
        approve: true,
        pinned: label === "partial",
      });
    }
    const found = await memory.search(owner, c.query, 2);
    const full = found.find((r) => r.text === c.full)!,
      partial = found.find((r) => r.text === c.partial)!;
    results.push({
      query: c.query,
      fullText: c.full,
      partialText: c.partial,
      expectedFullCoverage: 1,
      expectedPartialCoverage: 0.5,
      actualFullCoverage: full.why.relevance,
      actualPartialCoverage: partial.why.relevance,
      topText: found[0]!.text,
      fullFirst: found[0]!.text === c.full,
    });
  } finally {
    memory.close();
  }
}
const memory = new MemoryStore(
  ":memory:",
  new Vault(randomBytes(32)),
  async () => true,
  () => 1000,
);
let feedbackAfterEdit = 0;
try {
  const item = await memory.add(owner, {
    type: "fact",
    text: "release approved",
    origin: "user",
    sources: [
      {
        app: "local",
        tenantId: owner.tenantId,
        resourceId: "feedback",
        revision: "1",
      },
    ],
  });
  await memory.review(owner, item.id, 1, { approve: true });
  await memory.feedback(owner, item.id, "old-content-rating", "accepted");
  await memory.review(owner, item.id, 2, {
    text: "release not approved",
    approve: true,
  });
  feedbackAfterEdit = (await memory.search(owner, "release"))[0]!.why
    .usefulness;
} finally {
  memory.close();
}
console.log(
  JSON.stringify(
    {
      fixture: "memory-token-coverage-and-feedback-v1",
      syntheticOnly: true,
      cases: results,
      correctCoverageValues: results.reduce(
        (n, r) =>
          n +
          Number(r.actualFullCoverage === 1) +
          Number(r.actualPartialCoverage === 0.5),
        0,
      ),
      totalCoverageValues: cases.length * 2,
      fullMatchFirst: results.filter((r) => r.fullFirst).length,
      queries: cases.length,
      feedbackAfterEdit,
      expectedFeedbackAfterEdit: 0,
      limits:
        "Six manually labeled lexical cases and one content-edit case; no semantic relevance, factual correctness, model quality or live-source acceptance.",
    },
    null,
    2,
  ),
);
