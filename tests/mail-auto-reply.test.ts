import test from "node:test";
import assert from "node:assert/strict";
import { generateScopedReply } from "../modules/connectors/mail-auto-reply.js";
const input = {
  instructions: "Opening hours only",
  facts: "Open Monday to Friday, 09:00–17:00.",
  excluded: "Bookings",
  subject: "Hours",
  text: "When are you open?",
};
test("scoped answer requires a second independent review", async () => {
  const calls: string[] = [];
  const r = await generateScopedReply(input, async (p) => {
    calls.push(p);
    return JSON.stringify(
      calls.length === 1
        ? {
            decision: "reply",
            text: "We are open Monday to Friday, 09:00–17:00.",
            factIds: [1],
          }
        : { withinScope: true, supported: true, needsReview: false },
    );
  });
  assert.equal(r.decision, "reply");
  assert.equal(calls.length, 2);
});
test("review verdict prevents automatic use", async () => {
  let n = 0;
  assert.equal(
    (
      await generateScopedReply(input, async () =>
        JSON.stringify(
          ++n === 1
            ? { decision: "reply", text: "We will book you in.", factIds: [1] }
            : { withinScope: false, supported: false, needsReview: true },
        ),
      )
    ).decision,
    "review",
  );
});
test("unknown facts and recipient output fail closed", async () => {
  for (const r of [
    { decision: "reply", text: "Open today", factIds: [99] },
    { decision: "reply", text: "Send to stranger@example.org", factIds: [1] },
  ])
    await assert.rejects(
      generateScopedReply(input, async () => JSON.stringify(r)),
    );
});
test("model refusal produces no outgoing text", async () => {
  assert.deepEqual(
    await generateScopedReply(input, async () =>
      JSON.stringify({
        decision: "review",
        text: "Untrusted draft",
        factIds: [],
      }),
    ),
    { decision: "review", text: "", factIds: [] },
  );
});
