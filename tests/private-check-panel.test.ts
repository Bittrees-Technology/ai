import test from "node:test";
import assert from "node:assert/strict";
import { PrivateCheckPanelState } from "../apps/dashboard/private-check-state.js";
import { privateEndpoints } from "./helpers/private-endpoints.js";
type F = Awaited<ReturnType<typeof privateEndpoints>>;
function panel(f: F, endpoint = f.a) {
  const calls: { path: string; body: any }[] = [];
  let held = "",
    fail = "",
    release: (() => void) | undefined;
  let entered!: () => void;
  const waiting = new Promise<void>((r) => {
    entered = r;
  });
  const api = async (path: string, _method?: string, body?: any) => {
    calls.push({ path, body });
    const routes: Record<string, () => unknown> = {
      "/v1/private-peers": () => endpoint.controls.peerStatus(),
      "/v1/private-peer-checks": () => endpoint.controls.peerCheckStatus(),
      "/v1/private-peer-checks/begin": () =>
        endpoint.controls.beginPeerCheck(body),
      "/v1/private-peer-checks/respond": () =>
        endpoint.controls.respondPeerCheck(body),
      "/v1/private-peer-checks/complete": () =>
        endpoint.controls.completePeerCheck(body),
      "/v1/private-peer-checks/envelope": () =>
        endpoint.controls.peerCheckEnvelope(body),
      "/v1/private-peer-checks/resume": () =>
        endpoint.controls.resumePeerCheck(body),
      "/v1/private-peer-checks/stop": () =>
        endpoint.controls.stopPeerCheck(body),
    };
    const result = await routes[path]!();
    if (held === path)
      await new Promise<void>((r) => {
        release = r;
        entered();
      });
    if (fail === path) throw Error("LOST_ACK");
    return result;
  };
  return {
    c: new PrivateCheckPanelState(api, () => {}, f.clock),
    calls,
    waiting,
    hold: (path: string) => {
      held = path;
    },
    fail: (path: string) => {
      fail = path;
    },
    release: () => release?.(),
  };
}
async function start(f: F, p: ReturnType<typeof panel>) {
  await p.c.refresh();
  p.c.prepare("begin", f.b.grant.deviceId);
  await p.c.confirm(true);
  const row = p.c.state.status!.checks.at(-1)!;
  p.c.prepare("envelope", row.id);
  await p.c.confirm(true);
  return { row, envelope: JSON.parse(p.c.state.output!.code) };
}
test("Mac check panels exchange real HPKE codes with explicit actions and no task authority", async () => {
  const f = await privateEndpoints(false),
    a = panel(f),
    b = panel(f, f.b);
  try {
    const { row, envelope } = await start(f, a);
    await b.c.refresh();
    b.c.prepare("respond", f.a.grant.deviceId, JSON.stringify(envelope));
    assert.ok(b.c.state.review);
    await b.c.confirm(false);
    assert.equal(b.calls.filter((c) => c.path.endsWith("/respond")).length, 0);
    await b.c.confirm(true);
    const reply = b.c.state.status!.checks[0]!;
    assert.equal(reply.state, "pending");
    assert.equal(b.c.state.output, null);
    b.c.prepare("envelope", reply.id);
    await b.c.confirm(true);
    a.c.prepare("complete", f.b.grant.deviceId, b.c.state.output!.code);
    assert.equal(a.c.state.review!.id, row.id);
    await a.c.confirm(true);
    assert.equal(a.c.state.status!.checks[0]!.state, "verified");
    assert.match(a.c.state.notice, /not a live connection/);
    assert.equal(f.a.controls.permissionStatus().grants.length, 0);
    assert.equal(f.b.controls.permissionStatus().grants.length, 0);
    assert.equal(f.b.controls.peerCheckStatus().checks[0]!.state, "pending");
    assert.equal(f.a.store.export(f.a.owner).length, 0);
  } finally {
    f.close();
  }
});
test("Mac check review rejects mismatched, oversized, malformed and expired input without a mutation", async () => {
  const f = await privateEndpoints(false),
    p = panel(f);
  try {
    const { row, envelope } = await start(f, p),
      before = p.calls.length;
    for (const value of [
      "<script>bad</script>",
      "A".repeat(65537),
      JSON.stringify(envelope),
      JSON.stringify({ ...envelope, extra: true }),
    ]) {
      p.c.prepare("respond", f.b.grant.deviceId, value);
      assert.equal(p.c.state.review, null);
      assert.ok(p.c.state.error);
    }
    assert.equal(p.calls.length, before);
    p.c.prepare("stop", row.id);
    f.advance(300001);
    await p.c.confirm(true);
    assert.match(p.c.state.error, /expired/);
    assert.equal(p.calls.length, before);
    p.c.prepare("envelope", row.id);
    assert.equal(p.c.state.review, null);
    p.c.prepare("stop", row.id);
    await p.c.confirm(true);
    assert.equal(p.c.state.status!.checks[0]!.state, "stopped");
  } finally {
    f.close();
  }
});
test("Mac check panel keeps original ciphertext on reopen and stops by the reviewed revision", async () => {
  const f = await privateEndpoints(false),
    p = panel(f);
  try {
    const { row, envelope } = await start(f, p);
    f.a.reopen();
    await p.c.refresh();
    p.c.prepare("envelope", row.id);
    await p.c.confirm(true);
    assert.deepEqual(JSON.parse(p.c.state.output!.code), envelope);
    p.c.prepare("stop", row.id);
    f.a.controls.stopPeerCheck({
      id: row.id,
      expectedRevision: row.revision,
      confirmed: true,
    });
    await p.c.confirm(true);
    assert.match(p.c.state.error, /no automatic retry/);
    assert.equal(p.calls.filter((c) => c.path.endsWith("/stop")).length, 1);
    await p.c.refresh();
    assert.equal(p.c.state.status!.checks[0]!.state, "stopped");
  } finally {
    f.close();
  }
});
test("Mac check panel suppresses delayed code after hide and reconciles a lost begin acknowledgement without auto-retry", async () => {
  const f = await privateEndpoints(false),
    p = panel(f);
  try {
    const { row } = await start(f, p);
    p.hold("/v1/private-peer-checks/envelope");
    p.c.prepare("envelope", row.id);
    const pending = p.c.confirm(true);
    await p.waiting;
    p.c.hide();
    p.release();
    await pending;
    assert.equal(p.c.state.output, null);
    assert.equal(p.c.state.review, null);
    p.hold("");
    p.fail("/v1/private-peer-checks/begin");
    p.c.prepare("begin", f.b.grant.deviceId);
    await p.c.confirm(true);
    await p.c.confirm(true);
    assert.match(p.c.state.error, /may already be saved/);
    assert.equal(p.calls.filter((c) => c.path.endsWith("/begin")).length, 2);
    await p.c.refresh();
    assert.equal(p.c.state.status!.checks.length, 2);
  } finally {
    f.close();
  }
});
test("Mac check panel resumes the original interrupted preparation and invalidates stale peer review", async () => {
  const f = await privateEndpoints(false),
    p = panel(f);
  try {
    await p.c.refresh();
    f.a.store.db.exec(
      "CREATE TRIGGER fail_check_update BEFORE UPDATE ON private_peer_checks BEGIN SELECT RAISE(ABORT, 'test'); END",
    );
    p.c.prepare("begin", f.b.grant.deviceId);
    await p.c.confirm(true);
    assert.ok(p.c.state.error);
    f.a.store.db.exec("DROP TRIGGER fail_check_update");
    await p.c.refresh();
    const row = p.c.state.status!.checks[0]!;
    assert.equal(row.state, "preparing");
    p.c.prepare("resume", row.id);
    await p.c.confirm(true);
    assert.equal(p.c.state.status!.checks[0]!.id, row.id);
    assert.equal(p.c.state.status!.checks[0]!.state, "pending");
    p.c.prepare("begin", f.b.grant.deviceId);
    const rev = await f.a.controls.preparePeer({
      action: "revoke",
      expectedRevision: f.a.controls.peerStatus().revision,
      peerId: f.b.grant.deviceId,
    });
    await f.a.controls.confirmPeer({
      reviewId: rev.id,
      confirmed: true,
      acknowledged: true,
    });
    await p.c.confirm(true);
    assert.ok(p.c.state.error);
    assert.equal(f.a.controls.peerCheckStatus().checks.length, 1);
  } finally {
    f.close();
  }
});
