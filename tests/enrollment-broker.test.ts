import test from "node:test";
import assert from "node:assert/strict";
import { EnrollmentBroker } from "../modules/task-sync/enrollment-broker.js";
const token = "a".repeat(64);
test("loopback broker accepts only authenticated typed operations for existing session", async () => {
  let calls = 0;
  const session = {
    execute: async () => {
      calls++;
      return { fixture: true };
    },
  };
  const broker = new EnrollmentBroker(token, () => session);
  const url = await broker.listen();
  const send = (body: any, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await send({ operation: "heartbeat" })).status, 200);
    const rejectedHeaders: Record<string, string>[] = [
      { Authorization: "wrong" },
      { Origin: "https://ai.bittrees.org" },
      { Cookie: "session=bad" },
    ];
    for (const headers of rejectedHeaders)
      assert.equal(
        (await send({ operation: "heartbeat" }, headers)).status,
        403,
      );
    const { request } = await import("node:http");
    const wrongHost = await new Promise<number>((resolve, reject) => {
      const req = request(
        url,
        {
          method: "POST",
          headers: {
            Host: "evil.example",
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on("error", reject);
      req.end('{"operation":"heartbeat"}');
    });
    assert.equal(wrongHost, 403);
    for (const body of [
      { operation: "activate" },
      { operation: "heartbeat", url: "https://example.com" },
      { operation: "create-review", epoch: "new" },
    ])
      assert.equal((await send(body)).status, 400);
    assert.equal(
      (await send({ operation: "heartbeat", padding: "x".repeat(16001) }))
        .status,
      413,
    );
    assert.equal(calls, 1);
  } finally {
    await broker.close();
  }
});
test("disabled or replaced session cannot release response", async () => {
  let session: { execute: () => Promise<unknown> } | null = null;
  const broker = new EnrollmentBroker(token, () => session);
  const url = await broker.listen();
  const send = () =>
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: '{"operation":"heartbeat"}',
    });
  try {
    assert.equal((await send()).status, 403);
    session = {
      execute: async () => {
        session = null;
        return { secret: "must not return" };
      },
    };
    const result = await send();
    assert.equal(result.status, 403);
    assert.ok(!(await result.text()).includes("must not return"));
  } finally {
    await broker.close();
  }
});
