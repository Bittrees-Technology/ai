import test from "node:test";
import assert from "node:assert/strict";
import { centralWorkflowResponse } from "../modules/workflows/central-response.js";
const valid = {
  jsonrpc: "2.0",
  id: "request",
  result: { structuredContent: { leaseUntil: "future" } },
};
const read = (body: unknown) =>
  centralWorkflowResponse(
    new Response(JSON.stringify(body)),
    "request",
    new AbortController().signal,
  );
test("workflow responses require the exact RPC request and successful structured result", async () => {
  assert.deepEqual(await read(valid), { leaseUntil: "future" });
  for (const body of [
    { ...valid, id: "another" },
    { ...valid, jsonrpc: "1.0" },
    { ...valid, error: { message: "denied" } },
    { ...valid, result: { isError: true, structuredContent: {} } },
    { ...valid, result: {} },
  ])
    await assert.rejects(read(body));
});
test("workflow responses count streamed bytes and cancel oversized bodies", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from("é".repeat(32001)));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    centralWorkflowResponse(
      new Response(stream),
      "request",
      new AbortController().signal,
    ),
    /too large/,
  );
  assert.equal(cancelled, true);
});
test("a deadline cancels a stalled workflow response without waiting for source cancellation", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
      return new Promise(() => {});
    },
  });
  const pending = centralWorkflowResponse(
    new Response(stream),
    "request",
    controller.signal,
  );
  controller.abort(Error("deadline"));
  await assert.rejects(pending, /deadline/);
  assert.equal(cancelled, true);
});
test("rejected HTTP responses never expose a successful result", async () => {
  await assert.rejects(
    centralWorkflowResponse(
      new Response(JSON.stringify(valid), { status: 403 }),
      "request",
      new AbortController().signal,
    ),
  );
});
