import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  LocalInvestorReview,
  investorGates,
} from "../modules/workflows/local-investor-review.js";
import { Vault } from "../modules/storage/vault.js";
const quote = "Saved professional biography";
const input = {
  version: 1,
  candidateId: "fixture-only",
  name: "Fixture",
  sourceSnapshotSha256: "a".repeat(64),
  sources: [
    {
      id: "s1",
      url: "https://example.org/bio",
      retrievedAt: "2026-01-01T00:00:00Z",
      quote,
      quoteSha256: createHash("sha256").update(quote).digest("hex"),
    },
  ],
};
const proposal = {
  gates: investorGates.map((gate) => ({
    gate,
    sourceIds: ["s1"],
    missingEvidence: "Current direct evidence required",
  })),
};
function setup(output = JSON.stringify(proposal), authorize = () => true) {
  let calls = 0;
  const adapter = new LocalInvestorReview(
    ":memory:",
    new Vault(randomBytes(32)),
    {
      runtime: {
        pin: async () =>
          ({ profile: { model: "local" }, digest: "b".repeat(64) }) as any,
        generate: async () => {
          calls++;
          return output;
        },
      },
      turn: async (_signal, work) => work(),
      authorize,
    },
  );
  return { adapter, calls: () => calls };
}
test("forces all gates unknown, preserves source provenance, deduplicates draft", async () => {
  const x = setup();
  try {
    const a: any = await x.adapter.review(
      input,
      {},
      new AbortController().signal,
    );
    const b = await x.adapter.review(input, {}, new AbortController().signal);
    assert.equal(x.calls(), 1);
    assert.equal(a.crmWrite, false);
    assert.equal(a.fullyVerified, false);
    assert.equal(a.verifiedInvestorCountDelta, 0);
    assert.deepEqual(a.sources, input.sources);
    assert(a.gates.every((g: any) => g.status === "unknown"));
    assert.deepEqual(a, b);
  } finally {
    x.adapter.close();
  }
});
test("rejects changed quotes and extra commands before model execution", async () => {
  const x = setup();
  try {
    for (const value of [
      { ...input, command: "run" },
      { ...input, sources: [{ ...input.sources[0], quote: "changed" }] },
    ])
      await assert.rejects(
        x.adapter.review(value, {}, new AbortController().signal),
      );
    assert.equal(x.calls(), 0);
  } finally {
    x.adapter.close();
  }
});
test("rejects forged sources and bounds repeated failures", async () => {
  const x = setup(
    JSON.stringify({
      gates: proposal.gates.map((g) => ({ ...g, sourceIds: ["invented"] })),
    }),
  );
  try {
    for (let i = 0; i < 3; i++)
      await assert.rejects(
        x.adapter.review(input, {}, new AbortController().signal),
      );
    assert.equal(x.calls(), 2);
  } finally {
    x.adapter.close();
  }
});
test("denies revoked authority even for cached draft", async () => {
  let allowed = true;
  const x = setup(undefined, () => allowed);
  try {
    await x.adapter.review(input, {}, new AbortController().signal);
    allowed = false;
    await assert.rejects(
      x.adapter.review(input, {}, new AbortController().signal),
    );
    assert.equal(x.calls(), 1);
  } finally {
    x.adapter.close();
  }
});
test("denies revocation while inference runs and does not persist a draft", async () => {
  let allowed = true;
  const adapter = new LocalInvestorReview(
    ":memory:",
    new Vault(randomBytes(32)),
    {
      runtime: {
        pin: async () =>
          ({ profile: { model: "local" }, digest: "b".repeat(64) }) as any,
        generate: async () => {
          allowed = false;
          return JSON.stringify(proposal);
        },
      },
      turn: async (_signal, work) => work(),
      authorize: () => allowed,
    },
  );
  try {
    await assert.rejects(
      adapter.review(input, {}, new AbortController().signal),
      /scope changed/,
    );
    await assert.rejects(
      adapter.review(input, {}, new AbortController().signal),
      /scope unavailable/,
    );
  } finally {
    adapter.close();
  }
});
test("rejects duplicate gates and forged completion fields", async () => {
  for (const output of [
    { gates: Array(6).fill(proposal.gates[0]) },
    { ...proposal, fullyVerified: true, crmWrite: true },
  ]) {
    const x = setup(JSON.stringify(output));
    try {
      await assert.rejects(
        x.adapter.review(input, {}, new AbortController().signal),
      );
    } finally {
      x.adapter.close();
    }
  }
});
test("cancellation persists and prevents duplicate execution", async () => {
  const x = setup();
  try {
    const draft: any = await x.adapter.review(
      input,
      {},
      new AbortController().signal,
    );
    x.adapter.cancel(draft.operationId);
    await assert.rejects(
      x.adapter.review(input, {}, new AbortController().signal),
      /cancelled/,
    );
    assert.equal(x.calls(), 1);
    assert.equal(x.adapter.outbox()[0].state, "cancelled");
  } finally {
    x.adapter.close();
  }
});
