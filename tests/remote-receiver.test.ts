import test from "node:test";
import assert from "node:assert/strict";
import { RemoteReceiver } from "../modules/remote/receiver.js";
import { RemoteClientError } from "../modules/remote/client.js";
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  let enabled = false,
    valid = true,
    busy = false,
    polls = 0,
    failure = "";
  let held:
    ((signal?: AbortSignal) => Promise<{ receipts: any[] }>) | undefined;
  const jobs: { delay: number; fn: () => void; cancelled: boolean }[] = [];
  const client = {
    get running() {
      return busy;
    },
    status: async () => ({
      backgroundReceiving: enabled,
      controls: valid ? "enabled" : "confirmation_required",
    }),
    setReceiving: async (value: boolean) => {
      enabled = value;
    },
    pollControls: async (signal?: AbortSignal) => {
      polls++;
      if (held) return held(signal);
      if (failure) throw new RemoteClientError(failure as any);
      return { receipts: [] };
    },
  };
  const schedule = (fn: () => void, delay: number) => {
    const job = { fn, delay, cancelled: false };
    jobs.push(job);
    return {
      cancel: () => {
        job.cancelled = true;
      },
    };
  };
  const receiver = new RemoteReceiver(client as any, schedule, () => 1000);
  return {
    receiver,
    jobs: () => jobs.filter((j) => !j.cancelled),
    pollCount: () => polls,
    enableSaved: () => {
      enabled = true;
    },
    valid: (value: boolean) => {
      valid = value;
    },
    busy: (value: boolean) => {
      busy = value;
    },
    fail: (value: string) => {
      failure = value;
    },
    hold: (fn: typeof held) => {
      held = fn;
    },
    tick: async () => {
      const next = jobs.find((j) => !j.cancelled);
      assert.ok(next);
      next.cancelled = true;
      next.fn();
      await flush();
    },
  };
}
test("Receiver starts without networking and needs saved opt-in; stop and restart retain permission choice", async () => {
  const f = fixture();
  assert.equal(f.jobs().length, 0);
  assert.equal(f.pollCount(), 0);
  f.receiver.start();
  await f.tick();
  assert.equal(f.pollCount(), 0);
  assert.equal(f.receiver.status().state, "off");
  await f.receiver.configure(true);
  await f.tick();
  assert.equal(f.pollCount(), 1);
  assert.equal(f.jobs()[0]!.delay, 10000);
  assert.equal(f.receiver.status().lastCheckedAt, 1000);
  await f.receiver.pause();
  assert.equal(f.jobs().length, 0);
  f.receiver.start();
  await f.tick();
  assert.equal(f.pollCount(), 2);
  await f.receiver.configure(false);
  assert.equal(f.jobs().length, 0);
  f.receiver.start();
  await f.tick();
  assert.equal(f.pollCount(), 2);
  await f.receiver.shutdown();
  f.receiver.start();
  assert.equal(f.jobs().length, 0);
});
test("Receiver backs off transient errors, avoids busy client and stops on permission or storage failure", async () => {
  const f = fixture();
  f.enableSaved();
  f.fail("UNAVAILABLE");
  f.receiver.start();
  for (const delay of [10000, 20000, 40000, 60000, 60000]) {
    await f.tick();
    assert.equal(f.jobs()[0]!.delay, delay);
  }
  f.fail("");
  await f.tick();
  assert.equal(f.jobs()[0]!.delay, 10000);
  f.busy(true);
  const polls = f.pollCount();
  await f.tick();
  assert.equal(f.pollCount(), polls);
  f.busy(false);
  f.fail("STORAGE_UNAVAILABLE");
  await f.tick();
  assert.equal(f.receiver.status().state, "attention");
  assert.equal(f.jobs().length, 0);
  f.fail("");
  f.valid(false);
  f.receiver.start();
  await f.tick();
  assert.equal(f.receiver.status().state, "attention");
  assert.equal(f.jobs().length, 0);
  await f.receiver.shutdown();
});
test("Stopping aborts the one in-flight delivery and cannot schedule another check", async () => {
  const f = fixture();
  f.enableSaved();
  let signal: AbortSignal | undefined,
    finish!: (result: { receipts: any[] }) => void;
  f.hold(async (received) => {
    signal = received;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  f.receiver.start();
  await f.tick();
  f.receiver.start();
  assert.equal(f.pollCount(), 1);
  assert.equal(f.jobs().length, 0);
  const stopped = f.receiver.configure(false);
  assert.equal(signal?.aborted, true);
  finish({ receipts: [] });
  await stopped;
  assert.equal(f.receiver.status().state, "off");
  assert.equal(f.jobs().length, 0);
  await f.receiver.shutdown();
});
test("Shutdown during an awaited status check cannot begin command delivery", async () => {
  let finish!: (value: any) => void,
    polls = 0,
    run!: () => void;
  const receiver = new RemoteReceiver(
    {
      running: false,
      status: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      setReceiving: async () => {},
      pollControls: async () => {
        polls++;
        return { receipts: [] };
      },
    } as any,
    (fn) => {
      run = fn;
      return { cancel() {} };
    },
  );
  receiver.start();
  run();
  const stopped = receiver.shutdown();
  finish({ backgroundReceiving: true, controls: "enabled" });
  await stopped;
  assert.equal(polls, 0);
  assert.equal(receiver.status().state, "off");
});
