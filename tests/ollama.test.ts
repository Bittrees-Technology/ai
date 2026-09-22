import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Ollama } from "../modules/models/ollama.js";
const profile = {
  id: "p",
  runtime: "ollama",
  model: "local:1b",
  contextTokens: 2048,
  maxOutputTokens: 100,
  temperature: 0.2,
};
test("local model pinning, bounded generation and no tool execution", async () => {
  let digest = "a".repeat(64),
    cloud = false;
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const b of req) text += b;
    const body = text ? JSON.parse(text) : {};
    calls.push({ path: req.url!, body });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/tags")
      res.end(
        JSON.stringify({ models: [{ name: "local:1b", size: 100, digest }] }),
      );
    else if (req.url === "/api/show")
      res.end(
        JSON.stringify(
          cloud
            ? { remote_host: "https://cloud.invalid" }
            : { capabilities: ["completion"] },
        ),
      );
    else
      res.end(
        JSON.stringify({
          response: "Draft with fake tool instruction; plain text only.",
          done: true,
        }),
      );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const model = new Ollama(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    );
    const pinned = await model.pin(profile);
    assert.match(await model.generate(pinned, "PRIVATE TEST"), /plain text/);
    const generation = calls.find((c) => c.path === "/api/generate")!;
    assert.equal(generation.body.stream, false);
    assert.equal("tools" in generation.body, false);
    assert.equal(generation.body.prompt, "PRIVATE TEST");
    digest = "b".repeat(64);
    await assert.rejects(model.generate(pinned, "never sent"), /MODEL_CHANGED/);
    assert.equal(calls.filter((c) => c.path === "/api/generate").length, 1);
    cloud = true;
    await assert.rejects(model.pin(profile), /REMOTE_MODEL_DENIED/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("runtime URL cannot be changed to a remote host, credentials or alternate path", () => {
  for (const endpoint of [
    "https://api.example.com",
    "http://localhost:11434",
    "http://127.0.0.1:11434/proxy",
    "http://name:secret@127.0.0.1:11434",
  ])
    assert.throws(() => new Ollama(endpoint));
});
test("cancellation interrupts a model request without fallback", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.write("{");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const abort = new AbortController();
    const model = new Ollama(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    );
    const result = model.listModels(abort.signal);
    abort.abort();
    await assert.rejects(result);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("optional structured format is bounded, snapshotted and never retries without constraints", async () => {
  const formats: unknown[] = [];
  let reject = false;
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/tags")
      res.end(
        JSON.stringify({
          models: [{ name: profile.model, size: 1, digest: "a".repeat(64) }],
        }),
      );
    else if (req.url === "/api/show")
      res.end(JSON.stringify({ capabilities: ["completion"] }));
    else {
      formats.push(body.format);
      if (reject) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "synthetic unsupported format" }));
      } else
        res.end(JSON.stringify({ response: '{"answer":"ready"}', done: true }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const runtime = new Ollama(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    );
    const pinned = await runtime.pin(profile);
    const format = { type: "object", required: ["answer"] };
    const pending = runtime.generate(pinned, "Return JSON", undefined, format);
    format.required.push("changed-after-call");
    assert.equal(await pending, '{"answer":"ready"}');
    assert.deepEqual(formats[0], { type: "object", required: ["answer"] });
    await runtime.generate(pinned, "Return JSON", undefined, "json");
    assert.equal(formats[1], "json");
    await assert.rejects(
      runtime.generate(pinned, "Return JSON", undefined, {
        description: "x".repeat(16385),
      }),
      /CAPACITY/,
    );
    assert.equal(formats.length, 2);
    reject = true;
    await assert.rejects(
      runtime.generate(pinned, "Return JSON", undefined, "json"),
      /MODEL_UNAVAILABLE/,
    );
    assert.equal(formats.length, 3);
    assert.equal(formats[2], "json");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
