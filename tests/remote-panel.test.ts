import test from "node:test";
import assert from "node:assert/strict";
import { RemotePanelState } from "../apps/dashboard/remote-state.js";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test("Remote panel drops late pairing secrets and task previews after focus loss", async () => {
  const pairing = deferred<any>(),
    tasks = deferred<any>();
  const panel = new RemotePanelState(
    async (path) => (path.endsWith("begin") ? pairing.promise : tasks.promise),
    () => {},
    () => 1000,
  );
  const begin = panel.begin();
  assert.equal(panel.state.busy, true);
  panel.hide();
  pairing.resolve({ id: "id", approvalCode: "PRIVATE_CODE", expiresAt: 2000 });
  await begin;
  assert.equal(panel.state.pending, null);
  assert.equal(panel.state.busy, false);
  const load = panel.loadTasks();
  panel.hide();
  tasks.resolve({
    items: [
      {
        id: "t",
        revision: 1,
        status: "queued",
        input: { prompt: "PRIVATE_TASK" },
      },
    ],
  });
  await load;
  assert.deepEqual(panel.state.tasks, []);
  assert.equal(JSON.stringify(panel.state).includes("PRIVATE"), false);
});
test("Remote panel sends only reviewed selection IDs and revisions, then clears previews", async () => {
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  const panel = new RemotePanelState(
    async (path, method, body) => {
      calls.push({ path, method, body });
      if (path === "/v1/requests")
        return {
          items: [
            {
              id: "a",
              revision: 2,
              status: "queued",
              input: { prompt: "PRIVATE_A" },
            },
            {
              id: "b",
              revision: 5,
              status: "failed",
              input: { prompt: "PRIVATE_B" },
            },
          ],
        };
      if (path === "/v1/remote")
        return { available: true, connection: { state: "paired" } };
      return {};
    },
    () => {},
  );
  await panel.loadTasks();
  panel.select("a");
  await panel.publish();
  assert.equal(calls.length, 1);
  panel.review(true);
  panel.select("b");
  assert.equal(panel.state.reviewed, false);
  await panel.publish();
  assert.equal(calls.length, 1);
  panel.review(true);
  await panel.publish();
  assert.deepEqual(calls[1], {
    path: "/v1/remote/publish",
    method: "POST",
    body: {
      confirmed: true,
      tasks: [
        { id: "a", revision: 2 },
        { id: "b", revision: 5 },
      ],
    },
  });
  assert.equal(JSON.stringify(calls).includes("PRIVATE"), false);
  assert.deepEqual(panel.state.tasks, []);
  assert.equal(panel.state.reviewed, false);
});
test("Remote panel never auto-pairs or uploads on refresh, and hides submitted errors", async () => {
  const calls: string[] = [];
  const panel = new RemotePanelState(
    async (path) => {
      calls.push(path);
      if (path === "/v1/remote") return { available: false, connection: null };
      throw Error("PRIVATE_RAW_ERROR");
    },
    () => {},
  );
  await panel.refresh();
  assert.deepEqual(calls, ["/v1/remote"]);
  assert.equal(panel.state.available, false);
  await panel.begin();
  assert.equal(panel.state.error.includes("PRIVATE"), false);
  panel.hide();
  assert.equal(panel.state.error, "");
});
test("Remote panel local removal uses a distinct confirmation and explains remote revocation remains", async () => {
  let requested: any;
  const panel = new RemotePanelState(
    async (...args) => {
      requested = args;
      return { removedLocally: true, remoteRevocationConfirmed: false };
    },
    () => {},
  );
  await panel.forget();
  assert.deepEqual(requested, [
    "/v1/remote/local",
    "DELETE",
    undefined,
    { "X-Confirm-Delete": "local-remote-connection-only" },
  ]);
  assert.equal(panel.state.connection, null);
  assert.match(panel.state.notice, /Revoke the device on ai.bittrees.org/);
});
