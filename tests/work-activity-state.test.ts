import test from "node:test";
import assert from "node:assert/strict";
import {
  centralLane,
  researchLane,
  centralRunUrl,
} from "../apps/dashboard/work-activity-state.js";
test("local activity keeps uncertain completion and stale leases out of Done", () => {
  const now = Date.parse("2026-10-29T10:00:00Z");
  const s = {
    enabled: true,
    running: true,
    currentJob: { leaseUntil: "2026-10-29T10:01:00Z" },
  };
  assert.equal(centralLane(s, now), "running");
  assert.equal(
    centralLane({ ...s, progress: { state: "held" } }, now),
    "blocked",
  );
  assert.equal(
    centralLane(
      { ...s, currentJob: { ...s.currentJob, completionPending: true } },
      now,
    ),
    "review",
  );
  assert.equal(centralLane({ ...s, enabled: false }, now), "backlog");
  assert.equal(centralLane(s, now + 120000), "blocked");
  assert.equal(researchLane("sources_exhausted"), "blocked");
  assert.equal(researchLane("needs_attention"), "blocked");
  assert.equal(researchLane("unexpected"), "blocked");
  assert.equal(researchLane("complete"), "done");
});
test("central run links preserve source identity without URL parameter injection", () => {
  const u = new URL(centralRunUrl("a&run=other", "run?x=1"));
  assert.equal(u.origin, "https://workflow.bittrees.org");
  assert.equal(u.searchParams.get("workflow"), "a&run=other");
  assert.equal(u.searchParams.get("run"), "run?x=1");
});
