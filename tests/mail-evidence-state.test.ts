import test from "node:test";
import assert from "node:assert/strict";
import {
  MailEvidenceState,
  type EvidenceView,
} from "../apps/dashboard/mail-evidence-state.js";
const response = (sectionId = "body-1") => ({
  taskId: "task",
  taskRevision: 3,
  sectionId,
  text: "<script>untrusted correspondence</script>",
  mode: "plain",
  incomplete: false,
});
function pending() {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
test("Mail passage preview requests only the chosen task revision and latest request wins", async () => {
  const a = pending(),
    b = pending(),
    calls: unknown[] = [],
    views: EvidenceView[] = [];
  const state = new MailEvidenceState(
    async (...args) => {
      calls.push(args);
      return calls.length === 1 ? a.promise : b.promise;
    },
    "task",
    3,
    (v) => views.push(v),
  );
  assert.equal(calls.length, 0);
  const first = state.open("body-1"),
    second = state.open("body-2");
  b.resolve(response("body-2"));
  await second;
  a.resolve(response());
  await first;
  assert.deepEqual(calls[1], [
    "/v1/requests/task/mail-evidence",
    "POST",
    { expectedRevision: 3, sectionId: "body-2" },
  ]);
  assert.equal(state.view.evidence?.sectionId, "body-2");
  assert.equal(state.view.evidence?.text, response().text);
  state.hide();
  assert.equal(state.view.evidence, null);
  assert.ok(views.length >= 4);
});
test("Mail passage hides and disposal discard late successes and failures", async () => {
  for (const dispose of [false, true])
    for (const fail of [false, true]) {
      const p = pending(),
        views: EvidenceView[] = [];
      const state = new MailEvidenceState(
        () => p.promise,
        "task",
        3,
        (v) => views.push(v),
      );
      const request = state.open("body-1");
      if (dispose) state.dispose();
      else state.hide();
      const count = views.length;
      if (fail) p.reject(Error("private failure"));
      else p.resolve(response());
      await request;
      assert.equal(state.view.evidence, null);
      assert.equal(state.view.unavailable, false);
      assert.equal(views.length, count);
    }
});
test("Mail passage mismatched identities, malformed responses and current denial clear content", async () => {
  for (const invalid of [
    { ...response(), taskId: "other" },
    { ...response(), taskRevision: 4 },
    response("body-2"),
    { ...response(), text: "x".repeat(32001) },
    { ...response(), mode: "other" },
    null,
  ]) {
    let next: unknown = response();
    const state = new MailEvidenceState(
      async () => {
        if (next === null) throw Error("private source denial");
        return next;
      },
      "task",
      3,
      () => {},
    );
    await state.open("body-1");
    assert.ok(state.view.evidence);
    next = invalid;
    await state.open("body-1");
    assert.equal(state.view.evidence, null);
    assert.equal(state.view.unavailable, true);
    assert.equal(JSON.stringify(state.view).includes("private source"), false);
  }
});
