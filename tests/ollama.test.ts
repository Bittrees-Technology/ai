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
