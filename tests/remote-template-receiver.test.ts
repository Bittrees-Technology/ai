import test from "node:test";
import assert from "node:assert/strict";
import { RemoteTemplateReceiver } from "../modules/remote/template-receiver.js";
import { RemoteClientError } from "../modules/remote/client.js";
const flush = () => new Promise<void>((r) => setImmediate(r));
function fixture() {
  const templates = ["one", "two"].map((permissionId) => ({
    permissionId,
    state: "active",
    backgroundReceiving: false,
  }));
  const calls: string[] = [],
    jobs: { fn: () => void; delay: number; cancelled: boolean }[] = [];
  let busy = false,
    failure = "",
    hold: ((s?: AbortSignal) => Promise<any>) | undefined;
  const client = {
    get running() {
      return busy;
    },
    status: async () => ({ state: "paired", templates }),
    setTemplateReceiving: async (id: string, enabled: boolean) => {
      templates.find((t) => t.permissionId === id)!.backgroundReceiving =
        enabled;
    },
    pollTemplate: async (id: string, signal?: AbortSignal) => {
      calls.push(id);
      if (hold) return hold(signal);
      if (failure) throw new RemoteClientError(failure as any);
      return { receipts: [] };
    },
  };
  const receiver = new RemoteTemplateReceiver(
    client as any,
    (fn, delay) => {
      const job = { fn, delay, cancelled: false };
      jobs.push(job);
      return {
        cancel: () => {
          job.cancelled = true;
        },
      };
    },
    () => 1000,
  );
  return {
    receiver,
    templates,
    calls,
    jobs: () => jobs.filter((j) => !j.cancelled),
    busy: (value: boolean) => {
      busy = value;
    },
    fail: (value: string) => {
      failure = value;
    },
    hold: (value: typeof hold) => {
      hold = value;
    },
    tick: async () => {
      const job = jobs.find((j) => !j.cancelled)!;
      assert.ok(job);
      job.cancelled = true;
      job.fn();
      await flush();
    },
  };
}
test("Template receiving stays off until separate opt-in and shares passes fairly across enabled permissions", async () => {
  const f = fixture();
  f.receiver.start();
  await f.tick();
  assert.deepEqual(f.calls, []);
  await f.receiver.configure("one", true);
  await f.tick();
  assert.deepEqual(f.calls, ["one"]);
  await f.receiver.configure("two", true);
  await f.tick();
  await f.tick();
  assert.deepEqual(f.calls, ["one", "two", "one"]);
  await f.receiver.configure("one", false);
  await f.tick();
  assert.equal(f.calls.at(-1), "two");
  await f.receiver.pause();
  f.receiver.start();
  await f.tick();
  assert.equal(f.calls.at(-1), "two");
  f.templates[1]!.state = "confirmation_required";
  await f.tick();
  assert.equal(f.receiver.status().state, "attention");
  assert.equal(f.jobs().length, 0);
  await f.receiver.shutdown();
  f.receiver.start();
  assert.equal(f.jobs().length, 0);
});
test("Template receiver backs off network failures, avoids client contention and stops on storage failure", async () => {
  const f = fixture();
  await f.receiver.configure("one", true);
  f.fail("UNAVAILABLE");
  for (const delay of [10000, 20000, 40000, 60000]) {
    await f.tick();
    assert.equal(f.jobs()[0]!.delay, delay);
  }
  f.fail("");
  f.busy(true);
  const before = f.calls.length;
  await f.tick();
  assert.equal(f.calls.length, before);
  f.busy(false);
  await f.tick();
  assert.equal(f.jobs()[0]!.delay, 10000);
  f.fail("STORAGE_UNAVAILABLE");
  await f.tick();
  assert.equal(f.receiver.status().state, "attention");
  assert.equal(f.jobs().length, 0);
});
test("Stopping template receiving aborts and drains a delayed pass before persisting opt-out", async () => {
  const f = fixture();
  let resolve!: (value: any) => void, signal: AbortSignal | undefined;
  f.hold((s) => {
    signal = s;
    return new Promise((r) => {
      resolve = r;
    });
  });
  await f.receiver.configure("one", true);
  await f.tick();
  const stopping = f.receiver.configure("one", false);
  assert.equal(signal?.aborted, true);
  assert.equal(f.templates[0]!.backgroundReceiving, true);
  resolve({ receipts: [] });
  await stopping;
  assert.equal(f.templates[0]!.backgroundReceiving, false);
  await f.tick();
  assert.equal(f.receiver.status().state, "off");
  assert.deepEqual(f.calls, ["one"]);
});
