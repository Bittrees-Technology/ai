import { randomBytes } from "node:crypto";
import { MemoryStore } from "../modules/memory/store.js";
import { Vault } from "../modules/storage/vault.js";
const owner = {
  userId: "synthetic-retrieval-evaluation",
  tenantId: "isolated",
};
const memory = new MemoryStore(
  ":memory:",
  new Vault(randomBytes(32)),
  async () => true,
  () => 1000,
);
const expected = [
  "release build",
  "release build requires a source review",
  "release build needs a tested backup",
  "release build requires local consent",
  "release build must preserve task history",
  "release build remains a development preview",
];
try {
  for (let i = 0; i < 105 + expected.length - 1; i++) {
    const text = i < 105 ? expected[0]! : expected[i - 104]!;
    const item = await memory.add(owner, {
      type: "fact",
      text,
      origin: "user",
      sources: [
        {
          app: "local",
          tenantId: owner.tenantId,
          resourceId: `synthetic-${i}`,
          revision: "1",
        },
      ],
    });
    await memory.review(owner, item.id, 1, { approve: true });
  }
  const results = await memory.search(owner, "release build", 6);
  const unique = new Set(results.map((r) => r.text));
  console.log(
    JSON.stringify(
      {
        fixture: "duplicate-crowding-v1",
        syntheticOnly: true,
        retainedMemories: 110,
        query: "release build",
        requestedResults: 6,
        returnedResults: results.length,
        distinctTexts: unique.size,
        distinctTextRecall:
          expected.filter((text) => unique.has(text)).length / expected.length,
        duplicateSlots: results.length - unique.size,
        originalRecordsRemain: (await memory.export(owner)).length,
        expectations:
          "Six manually enumerated distinct texts should remain available despite 105 copies of the first text. This is not a general semantic-retrieval benchmark.",
      },
      null,
      2,
    ),
  );
} finally {
  memory.close();
}
