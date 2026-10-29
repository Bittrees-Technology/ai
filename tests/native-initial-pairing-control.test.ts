import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  InitialPairingNativeControl,
  type InitialPairingNativeActions,
} from "../modules/task-sync/initial-pairing-native-control.js";
import { NativeInitialPairingReviewActions } from "../modules/task-sync/initial-pairing-native-review.js";

const native = "a".repeat(64),
  core = "b".repeat(64);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture(overrides: Partial<InitialPairingNativeActions> = {}) {
  const calls: string[] = [];
  const actions: InitialPairingNativeActions = {
    prepare() {
      calls.push("prepare");
      return { fixture: "scope" };
    },
    async approve(input) {
      calls.push("approve");
      return { fixture: input };
    },
    async poll() {
      calls.push("poll");
      return { fixture: "pending" };
    },
    async close() {
      calls.push("close");
    },
    ...overrides,
  };
  const control = new InitialPairingNativeControl(native, core, actions);
  const url = await control.listen();
  const send = (
    body: unknown,
    headers: Record<string, string> = {},
    endpoint = url,
  ) =>
    fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + native,
        "Content-Type": "application/json",
        ...headers,
      },
      body:
        body instanceof Uint8Array
          ? Uint8Array.from(body).buffer
          : typeof body === "string"
            ? body
            : JSON.stringify(body),
    });
  return { calls, control, url, send };
}
test("pairing IPC rejects core/browser, malformed and oversized inputs without invoking actions", async () => {
  const f = await fixture();
  try {
    const deniedHeaders: Record<string, string>[] = [
      { Authorization: "Bearer " + core },
      { Origin: "" },
      { Cookie: "" },
      { Origin: "https://ai.bittrees.org" },
      { "Content-Encoding": "" },
      { "Content-Encoding": "identity" },
      { "Content-Type": "text/plain" },
    ];
    for (const headers of deniedHeaders)
      assert.ok(
        (await f.send({ action: "prepare" }, headers)).status >= 400,
        Object.keys(headers).join(","),
      );
    for (const body of [
      { action: "prepare", principal: "agent:" + randomUUID() },
      { action: "approve", digest: "c".repeat(64) },
      {
        action: "approve",
        reviewId: randomUUID(),
        digest: "c".repeat(64),
        sourceUrl: "https://example.com",
      },
      { action: "poll", permissionsGranted: true },
      { action: "execute", command: "ignored" },
      "{",
      new Uint8Array([123, 34, 0xff, 34, 58, 48, 125]),
      " ".repeat(2049),
    ])
      assert.ok((await f.send(body)).status >= 400);
    assert.equal(
      (await f.send({ action: "prepare" }, {}, f.url + "?extra=1")).status,
      403,
    );
    assert.equal((await fetch(f.url)).status, 403);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(await (await f.send({ action: "prepare" })).json(), {
      fixture: "scope",
    });
    assert.deepEqual(f.calls, ["prepare"]);
  } finally {
    await f.control.close();
  }
  await assert.rejects(f.control.listen());
});
test("duplicate sensitive headers cannot choose another native identity or capability", async () => {
  const f = await fixture();
  const host = new URL(f.url).host;
  try {
    for (const duplicate of ["Host", "Authorization", "Content-Type"]) {
      const value =
        duplicate === "Host"
          ? host
          : duplicate === "Authorization"
            ? "Bearer " + native
            : "application/json";
      const headers = [
        "Host",
        host,
        "Authorization",
        "Bearer " + native,
        "Content-Type",
        "application/json",
        duplicate,
        value,
        "Connection",
        "close",
      ];
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(f.url, { method: "POST", headers }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        });
        req.on("error", reject);
        req.end(JSON.stringify({ action: "prepare" }));
      });
      assert.ok(status >= 400);
    }
    // fetch normalizes Host, so exercise an actual forged host on the wire.
    const wrongHost = await new Promise<number>((resolve, reject) => {
      const req = request(
        f.url,
        {
          method: "POST",
          headers: {
            Host: "localhost:" + new URL(f.url).port,
            Authorization: "Bearer " + native,
            "Content-Type": "application/json",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ action: "prepare" }));
    });
    assert.equal(wrongHost, 403);
    const saturated = await new Promise<number>((resolve, reject) => {
      const headers = [
        "Host",
        host,
        "Authorization",
        "Bearer " + native,
        "Content-Type",
        "application/json",
      ];
      for (let i = 0; i < 25; i++) headers.push("X-Fixture-" + i, "1");
      headers.push("Origin", "", "Connection", "close");
      const req = request(f.url, { method: "POST", headers }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      });
      req.on("error", reject);
      req.end(JSON.stringify({ action: "prepare" }));
    });
    assert.ok(
      saturated === 403 || saturated === 431,
      "Header parser limits cannot hide a trailing browser header",
    );
    const trailer = await new Promise<number>((resolve, reject) => {
      const req = request(
        f.url,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + native,
            "Content-Type": "application/json",
            "Transfer-Encoding": "chunked",
            Trailer: "X-Fixture",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      req.on("error", reject);
      req.write(JSON.stringify({ action: "prepare" }));
      req.addTrailers({ "X-Fixture": "not accepted" });
      req.end();
    });
    assert.equal(trailer, 400);
    assert.deepEqual(f.calls, []);
  } finally {
    await f.control.close();
  }
});
test("real review proposal over native IPC still denies when source purpose is unavailable", async () => {
  const pem = () =>
    generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
  let admitted = 0,
    created = 0;
  const actions = new NativeInitialPairingReviewActions({
    identity: { principal: "agent:" + randomUUID(), publicKey: pem() },
    rolesPublicKey: pem(),
    admitSource() {
      admitted++;
      throw Error("private source-purpose detail must not leak");
    },
    createSession() {
      created++;
      throw Error("No production counterpart");
    },
  });
  const f = await fixture({
    prepare: () => actions.prepare(),
    approve: (input) => actions.approve(input),
    poll: () => actions.poll(),
    close: () => actions.close(),
  });
  try {
    const prepared = (await (
      await f.send({ action: "prepare" })
    ).json()) as any;
    assert.equal(prepared.review.permissionsGranted, false);
    assert.equal(prepared.review.runtimeEnrolled, false);
    assert.equal(admitted, 0);
    assert.equal(created, 0);
    const response = await f.send({
      action: "approve",
      reviewId: prepared.review.reviewId,
      digest: prepared.digest,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Native pairing control unavailable",
    });
    assert.equal(admitted, 1);
    assert.equal(created, 0);
    assert.equal(
      (await f.send({ action: "prepare" })).status,
      403,
      "Failed admission cannot create a new consent from a retry",
    );
  } finally {
    await f.control.close();
  }
});
test("cancel is admitted during in-flight work and late results cannot escape", async () => {
  const entered = deferred(),
    release = deferred();
  let closed = 0;
  const f = await fixture({
    async approve() {
      entered.resolve();
      await release.promise;
      return { fixture: "late result" };
    },
    async close() {
      closed++;
      release.resolve();
    },
  });
  try {
    const active = f.send({
      action: "approve",
      reviewId: randomUUID(),
      digest: "c".repeat(64),
    });
    await entered.promise;
    assert.equal((await f.send({ action: "poll" })).status, 409);
    assert.deepEqual(await (await f.send({ action: "cancel" })).json(), {
      cancelled: true,
    });
    const result = await active;
    assert.equal(result.status, 400);
    assert.deepEqual(await result.json(), {
      error: "Native pairing control unavailable",
    });
    assert.ok(closed >= 1);
    assert.equal((await f.send({ action: "poll" })).status, 403);
  } finally {
    await f.control.close();
  }
});
test("authenticated disconnect cancels pending work and denies replay", async () => {
  const entered = deferred(),
    release = deferred(),
    cancelled = deferred();
  const f = await fixture({
    async approve() {
      entered.resolve();
      await release.promise;
      return { fixture: "late" };
    },
    async close() {
      cancelled.resolve();
      release.resolve();
    },
  });
  try {
    const req = request(f.url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + native,
        "Content-Type": "application/json",
      },
    });
    req.on("error", () => {});
    req.end(
      JSON.stringify({
        action: "approve",
        reviewId: randomUUID(),
        digest: "c".repeat(64),
      }),
    );
    await entered.promise;
    req.destroy();
    await cancelled.promise;
    assert.equal((await f.send({ action: "poll" })).status, 403);
  } finally {
    await f.control.close();
  }
});
test("oversized or thrown action responses cancel without leaking details or allowing retries", async () => {
  for (const oversized of [false, true]) {
    let closed = 0;
    const f = await fixture({
      async poll() {
        if (oversized) return { private: "x".repeat(16385) };
        throw Error("private failure detail");
      },
      async close() {
        closed++;
      },
    });
    try {
      const response = await f.send({ action: "poll" });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: "Native pairing control unavailable",
      });
      assert.ok(closed >= 1);
      assert.equal((await f.send({ action: "poll" })).status, 403);
    } finally {
      await f.control.close();
    }
  }
});
test("control rejects shared capabilities and can close once before listening", async () => {
  const actions = {
    prepare() {},
    async approve() {},
    async poll() {},
    async close() {},
  };
  assert.throws(() => new InitialPairingNativeControl(core, core, actions));
  assert.throws(
    () => new InitialPairingNativeControl("invalid", core, actions),
  );
  const control = new InitialPairingNativeControl(native, core, actions);
  const closing = control.close();
  assert.equal(control.close(), closing);
  await closing;
  await assert.rejects(control.listen());
});
