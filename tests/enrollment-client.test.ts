import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EnrollmentClient } from "../modules/task-sync/enrollment-client.js";
import { EnrollmentBroker } from "../modules/task-sync/enrollment-broker.js";
const token = "a".repeat(64);
test("client denies remote, alternate and ambiguous endpoints before connection", () => {
  for (const url of [
    "https://ai.bittrees.org/enrollment",
    "http://localhost:1234/enrollment",
    "http://127.0.0.1/enrollment",
    "http://127.0.0.1:1234/enrollment?extra=1",
    "http://127.0.0.1:1234/x/../enrollment",
    "http://user@127.0.0.1:1234/enrollment",
  ])
    assert.throws(() => new EnrollmentClient(url, token));
});
test("typed client reaches existing broker session and does not fall back on auth failure", async () => {
  let calls = 0;
  const session = {
    execute: async () => {
      calls++;
      return { fixture: true };
    },
  };
  const broker = new EnrollmentBroker(token, () => session);
  const url = await broker.listen();
  try {
    const client = new EnrollmentClient(url, token);
    assert.deepEqual(
      await client.execute(
        { operation: "heartbeat" },
        new AbortController().signal,
      ),
      { fixture: true },
    );
    await assert.rejects(
      client.execute({ operation: "activate" }, new AbortController().signal),
    );
    await assert.rejects(
      new EnrollmentClient(url, "b".repeat(64)).execute(
        { operation: "heartbeat" },
        new AbortController().signal,
      ),
    );
    assert.equal(calls, 1);
  } finally {
    await broker.close();
  }
});
test("client rejects redirect, oversized and malformed responses", async () => {
  let mode = "redirect";
  const server = createServer((_req, res) => {
    res.writeHead(mode === "redirect" ? 302 : 200, {
      "Content-Type": "application/json",
      Location: "https://ai.bittrees.org",
    });
    res.end(mode === "large" ? "x".repeat(64001) : "not-json");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const a = server.address();
  if (!a || typeof a === "string") throw Error("address");
  const client = new EnrollmentClient(
    `http://127.0.0.1:${a.port}/enrollment`,
    token,
  );
  try {
    for (mode of ["redirect", "large", "malformed"])
      await assert.rejects(
        client.execute(
          { operation: "heartbeat" },
          new AbortController().signal,
        ),
      );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("caller cancellation interrupts a pending broker request", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let cancelled!: () => void;
  const observed = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  const session = {
    execute: async (_raw: unknown, signal: AbortSignal) => {
      entered();
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            cancelled();
            resolve();
          },
          { once: true },
        ),
      );
      return { secret: "discard" };
    },
  };
  const broker = new EnrollmentBroker(token, () => session);
  const url = await broker.listen();
  try {
    const controller = new AbortController();
    const result = new EnrollmentClient(url, token).execute(
      { operation: "heartbeat" },
      controller.signal,
    );
    const rejected = assert.rejects(result, /cancelled/);
    await started;
    controller.abort();
    await rejected;
    await observed;
  } finally {
    await broker.close();
  }
});
