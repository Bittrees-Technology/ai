import { randomBytes } from "node:crypto";
import { MemoryStore } from "../modules/memory/store.js";
import { Vault } from "../modules/storage/vault.js";
const owner = {
  userId: "synthetic-diversity-evaluation",
  tenantId: "isolated",
};
const memory = new MemoryStore(
  ":memory:",
  new Vault(randomBytes(32)),
  async () => true,
  () => 1000,
);
try {
  for (let i = 0; i < 16; i++) {
    const item = await memory.add(owner, {
      type: "fact",
      text: i === 15 ? "release unrelated planning" : `release build note ${i}`,
      origin: "user",
      sources: [
        {
          app: "local",
          tenantId: owner.tenantId,
          resourceId: i < 12 ? "repeated-source" : `source-${i}`,
          revision: "1",
        },
      ],
    });
    await memory.review(owner, item.id, 1, {
      approve: true,
      pinned: i < 12 || i === 15,
    });
  }
  const results = await memory.search(owner, "release build", 4);
  console.log(
    JSON.stringify(
      {
        fixture: "source-diversity-v1",
        syntheticOnly: true,
        retainedMemories: 16,
        requestedResults: 4,
        returnedResults: results.length,
        distinctSources: new Set(
          results.flatMap((r) => r.sources.map((s) => s.resourceId)),
        ).size,
        allMatchEveryQueryTerm: results.every((r) => r.why.relevance === 1),
        pinnedFirst: results[0]?.why.pinned,
        originalRecordsRemain: (await memory.export(owner)).length,
        expectations:
          "Four distinct sources with identical full-term coverage are available. Twelve slightly higher-scored pinned records share one source; one pinned partial-term distractor must not enter the results. This is not a general relevance benchmark.",
      },
      null,
      2,
    ),
  );
} finally {
  memory.close();
}
