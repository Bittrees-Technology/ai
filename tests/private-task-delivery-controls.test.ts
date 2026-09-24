import test from "node:test";
import assert from "node:assert/strict";
import { PrivateTaskDeliveryState } from "../apps/dashboard/private-task-delivery-state.js";
import { macRelayFixture } from "./helpers/mac-relay.js";
async function fixture() {
  const g = await macRelayFixture(),
    calls: { path: string; body: any }[] = [];
  let mono = 0;
  const api = async (path: string, _method?: string, body?: any) => {
    calls.push({ path, body: structuredClone(body) });
    if (path === "/v1/private-relay") return g.relay.status();
    if (path === "/v1/private-tasks") return g.f.b.controls.taskStatus();
    if (path.endsWith("/cancel-review")) {
      g.relay.invalidate();
      return;
    }
    if (path.endsWith("/check-task"))
      return g.f.b.controls.checkRelayedTask(g.relay, body);
    if (path === "/v1/private-relay/responses/prepare")
      return g.f.b.controls.prepareRelayedResponse(g.relay, body);
    if (path.endsWith("/responses/send"))
      return g.f.b.controls.sendRelayedResponse(g.relay, body);
    if (path.endsWith("/responses/stop"))
      return g.f.b.controls.stopTaskResponse(body);
    throw Error("Unexpected path " + path);
  };
  const c = new PrivateTaskDeliveryState(
    api,
    () => {},
    g.f.clock,
    () => mono,
  );
  await c.refresh();
  const connection = g.input().id;
  const accept = async () => {
    await c.prepare("check", connection);
    await c.confirm(true);
    assert.equal(c.state.error, "");
  };
  const prepare = async () => {
    await c.prepare("accepted", connection, g.wire.envelope.header.operationId);
    await c.confirm(true);
    assert.equal(c.state.error, "");
    return c.state.snapshot!.tasks.responses[0]!;
  };
  return {
    g,
    c,
    calls,
    connection,
    accept,
    prepare,
    elapsed: (n: number) => {
      mono = n;
    },
  };
}

test("Mac delivery review keeps admission, preparation and sending separate over actual native controllers", async () => {
  const { g, c, calls, connection } = await fixture();
  try {
    await c.prepare("check", connection);
    await c.confirm(false);
    assert.equal(calls.filter((v) => v.path.endsWith("/check-task")).length, 0);
    const revision = c.state.review!.connection!.revision;
    c.state.review!.connection!.revision++;
    c.state.review!.action = "send";
    await c.confirm(true);
    assert.equal(c.state.error, "");
    assert.match(c.state.notice, /accepted locally.*not.*complete/);
    assert.equal(
      calls.find((v) => v.path.endsWith("/check-task"))!.body.expectedRevision,
      revision,
    );
    assert.equal(c.state.snapshot!.tasks.acceptedTasks.length, 1);
    assert.equal(c.state.snapshot!.tasks.responses.length, 0);
    assert.equal(g.outgoing.size, 0);
    const task = c.state.snapshot!.tasks.acceptedTasks[0]!;
    await c.prepare("accepted", connection, task.operationId);
    await c.confirm(true);
    assert.match(c.state.notice, /nothing was sent automatically/);
    assert.equal(g.outgoing.size, 0);
    const response = c.state.snapshot!.tasks.responses[0]!;
    await c.prepare("send", connection, response.id);
    await c.confirm(true);
    await c.confirm(true);
    assert.equal(c.state.error, "");
    assert.equal(g.outgoing.size, 1);
    assert.equal(
      calls.filter((v) => v.path.endsWith("/responses/send")).length,
      1,
    );
    assert.match(c.state.notice, /authentication or reading is not confirmed/);
    await g.f.work();
    await c.prepare("result", connection, task.operationId);
    await c.confirm(true);
    assert.equal(c.state.snapshot!.tasks.responses.length, 2);
    assert.doesNotMatch(
      JSON.stringify(c.state),
      /Synthetic private|prompt|ciphertext|publicKey|credential"/,
    );
  } finally {
    g.close();
  }
});

test("Mac delivery review consumes uncertain sends and requires current saved history for explicit retry", async () => {
  const { g, c, connection, accept, prepare, calls } = await fixture();
  try {
    await accept();
    const response = await prepare();
    g.control.loseSubmit = true;
    await c.prepare("send", connection, response.id);
    await c.confirm(true);
    assert.match(c.state.error, /nothing will be retried automatically/);
    assert.equal(c.state.snapshot, null);
    assert.equal(c.state.review, null);
    assert.equal(g.outgoing.size, 1);
    await c.confirm(true);
    assert.equal(
      calls.filter((v) => v.path.endsWith("/responses/send")).length,
      1,
    );
    g.control.loseSubmit = false;
    await c.refresh();
    await c.prepare("send", connection, response.id);
    await c.confirm(true);
    assert.equal(c.state.error, "");
    assert.equal(g.outgoing.size, 1);
    assert.match(c.state.notice, /original message was already recorded/);
    assert.equal(c.state.snapshot!.tasks.responses[0]!.attempts, 2);
  } finally {
    g.close();
  }
});

test("Mac delivery confirmation rejects a reply changed after review without contacting the relay", async () => {
  const { g, c, connection, accept, prepare, calls } = await fixture();
  try {
    await accept();
    const response = await prepare();
    await c.prepare("send", connection, response.id);
    await g.f.b.controls.stopTaskResponse({
      id: response.id,
      expectedRevision: response.revision,
      confirmed: true,
    });
    await c.confirm(true);
    assert.match(c.state.error, /details changed/);
    assert.equal(
      calls.filter((v) => v.path.endsWith("/responses/send")).length,
      0,
    );
    assert.equal(g.outgoing.size, 0);
  } finally {
    g.close();
  }
});

test("Mac delivery review checks wall and monotonic deadlines before native admission", async () => {
  for (const mode of ["wall", "elapsed", "rollback"] as const) {
    const { g, c, connection, elapsed, calls } = await fixture();
    try {
      await c.prepare("check", connection);
      if (mode === "wall") g.f.advance(120000);
      if (mode === "elapsed") elapsed(120000);
      if (mode === "rollback") g.f.advance(-1);
      await c.confirm(true);
      assert.match(c.state.error, /could not be confirmed/);
      assert.equal(
        calls.filter((v) => v.path.endsWith("/check-task")).length,
        0,
      );
    } finally {
      g.close();
    }
  }
});

test("hiding a Mac send review fences held native transport and suppresses its late response", async () => {
  const { g, c, connection, accept, prepare } = await fixture();
  try {
    await accept();
    const response = await prepare();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((r) => {
        release = r;
      }),
      started = new Promise<void>((r) => {
        entered = r;
      });
    g.control.beforeRecipient = async () => {
      entered();
      await held;
    };
    await c.prepare("send", connection, response.id);
    const sending = c.confirm(true);
    await started;
    c.hide();
    await Promise.resolve();
    await Promise.resolve();
    release();
    await sending;
    assert.equal(c.state.review, null);
    assert.equal(c.state.snapshot, null);
    assert.equal(c.state.notice, "");
    assert.equal(g.outgoing.size, 0);
    g.control.beforeRecipient = undefined;
    await c.refresh();
    assert.equal(c.state.error, "");
  } finally {
    g.close();
  }
});

test("saved reply retries can be stopped without an active connection or remote identity", async () => {
  const { g, c, accept, prepare } = await fixture();
  try {
    await accept();
    const response = await prepare();
    const r = g.relay.status().state.items[0]!;
    const review = await g.relay.prepare({
      action: "stop",
      id: r.id,
      expectedRevision: r.revision,
    });
    await g.relay.confirm({
      reviewId: review.id,
      acknowledged: true,
      confirmed: true,
    });
    g.f.b.deny();
    const before = g.f.b.identities();
    await c.refresh();
    assert.equal(c.activeConnections().length, 0);
    await c.prepare("stop", undefined, response.id);
    await c.confirm(true);
    assert.equal(c.state.error, "");
    assert.match(c.state.notice, /retries stopped/);
    assert.equal(c.state.snapshot!.tasks.responses[0]!.state, "stopped");
    assert.equal(g.f.b.identities(), before);
  } finally {
    g.close();
  }
});
