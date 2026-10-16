import test from "node:test";
import assert from "node:assert/strict";
import { LocalModelTurns } from "../modules/models/local-turns.js";
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
};
test("research and CRM model turns are FIFO; cancelling queued work cannot overlap inference", async () => {
  const turns = new LocalModelTurns(),
    hold = gate(),
    began = gate(),
    cancelled = new AbortController();
  const order: string[] = [];
  const research = turns.run(new AbortController().signal, async () => {
    order.push("research");
    began.release();
    await hold.promise;
  });
  await began.promise;
  const skip = turns.run(cancelled.signal, async () => {
    order.push("cancelled");
  });
  const reject = assert.rejects(skip);
  const crm = turns.run(new AbortController().signal, async () => {
    order.push("crm");
  });
  const next = turns.run(new AbortController().signal, async () => {
    order.push("research-next");
  });
  cancelled.abort();
  await reject;
  assert.deepEqual(order, ["research"]);
  hold.release();
  await Promise.all([research, crm, next]);
  assert.deepEqual(order, ["research", "crm", "research-next"]);
  await assert.rejects(
    turns.run(new AbortController().signal, async () => {
      throw Error("model failed");
    }),
  );
  assert.equal(
    await turns.run(new AbortController().signal, async () => "released"),
    "released",
  );
});
