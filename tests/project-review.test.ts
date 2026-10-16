import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reviewSources,
  renderGroundedReview,
} from "../modules/research/project-review.js";

test("review excludes correction warnings and rejects invented or misattributed excerpts", () => {
  const sources = reviewSources(
    "QUALITY REVIEW: Wrong Miami address.\n\nSaved source claim: Mike Hennessy Director of Investments\nAnalyst screening: likely fit",
    '{"records":[]}',
  );
  assert.equal(sources.length, 1);
  assert.doesNotMatch(JSON.stringify(sources), /Miami|likely fit/);
  for (const item of [
    { sourceId: "task-1", quote: "Miami" },
    { sourceId: "other", quote: "Mike Hennessy" },
    { sourceId: "task-1", quote: "Mike Hennessy lives in Miami" },
  ])
    assert.throws(() =>
      renderGroundedReview({ canComplete: true, excerpts: [item] }, sources),
    );
  const result = renderGroundedReview(
    {
      canComplete: true,
      excerpts: [
        { sourceId: "task-1", quote: "Mike Hennessy Director of Investments" },
      ],
    },
    sources,
  );
  assert.match(result, /NOT INDEPENDENT VERIFICATION/);
  assert.doesNotMatch(result, /Miami|likely fit/);
  assert.match(result, /No source record or permission was changed/);
});
test("model prose, refusal and malformed output cannot become a completed review", () => {
  const sources = reviewSources("Review supplied facts", "truncated{");
  assert.throws(() =>
    renderGroundedReview(
      { canComplete: true, excerpts: [], result: "Likely qualified" },
      sources,
    ),
  );
  assert.throws(() =>
    renderGroundedReview({ canComplete: false, excerpts: [] }, sources),
  );
  assert.match(
    renderGroundedReview({ canComplete: true, excerpts: [] }, sources),
    /Evidence is insufficient/,
  );
});
