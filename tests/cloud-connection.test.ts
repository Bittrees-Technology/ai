import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../modules/storage/vault.js";
import {
  CloudConnection,
  cloudModel,
} from "../modules/agents/cloud-connection.js";
import { cloudReadiness, cloudHelper } from "../modules/agents/cloud-helper.js";
import { OpenRouter } from "../modules/agents/openrouter.js";
const key = "sk-or-v1-" + "a".repeat(64);
const signal = () => new AbortController().signal;
const response = (data: unknown) =>
  new Response(JSON.stringify(data), { status: 200 });
function account(balance = 0, limit = 0, zdr = true) {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url: any) => {
      calls.push(String(url));
      if (String(url).endsWith("/key"))
        return response({
          data: { limit, free_model_daily_requests: { remaining: 50 } },
        });
      if (String(url).endsWith("/credits"))
        return response({ data: { total_credits: balance, total_usage: 0 } });
      return response({
        data: zdr
          ? [
              {
                model_id: cloudModel,
                tag: "phala",
                status: 0,
                pricing: { prompt: "0", completion: "0" },
              },
            ]
          : [],
      });
    },
  };
}
test("negative balance and nonzero cap fail before inference", async () => {
  for (const [balance, limit] of [
    [-0.12, 0],
    [0, 10],
  ]) {
    const a = account(balance, limit);
    assert.equal(
      (await cloudReadiness(key, signal(), a.fetch as any)).ready,
      false,
    );
    assert(!a.calls.some((x) => x.includes("completions")));
  }
});
test("only pinned free ZDR endpoint is eligible", async () => {
  for (const zdr of [false, true]) {
    const a = account(0, 0, zdr);
    assert.equal(
      (await cloudReadiness(key, signal(), a.fetch as any)).ready,
      zdr,
    );
  }
});
test("key encrypted at rest and absent from status; replacement disables and aborts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cloud-key-"));
  const vault = new Vault(randomBytes(32));
  let aborted = false;
  const c = new CloudConnection(
    join(dir, "c.db"),
    vault,
    async (body: any, s) => {
      if (body.action === "check") return { ready: true };
      return new Promise((_, reject) =>
        s.addEventListener("abort", () => {
          aborted = true;
          reject(Error("revoked"));
        }),
      );
    },
  );
  try {
    c.install({ apiKey: key });
    assert(!JSON.stringify(c.status()).includes(key));
    await c.check();
    c.enable({ confirmed: true });
    const pending = c.generate(
      "public synthetic prompt",
      cloudModel,
      signal(),
      randomUUID(),
    );
    c.disable();
    await assert.rejects(pending);
    assert(aborted);
    assert.equal(c.status().enabled, false);
    c.close();
    assert(!readFileSync(join(dir, "c.db")).includes(key));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("cannot enable before account verification or execute wrong model", async () => {
  const c = new CloudConnection(
    ":memory:",
    new Vault(randomBytes(32)),
    async () => ({ ready: false }),
  );
  try {
    c.install({ apiKey: key });
    assert.throws(() => c.enable({ confirmed: true }));
    await assert.rejects(c.generate("x", "paid/model", signal(), randomUUID()));
  } finally {
    c.close();
  }
});
test("helper rejects unauthenticated, origin and unknown command before network", async () => {
  let calls = 0;
  const server = cloudHelper("a".repeat(64), (async () => {
    calls++;
    throw Error("unexpected");
  }) as any);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address() as any;
  try {
    for (const headers of [
      {},
      {
        authorization: "Bearer " + "a".repeat(64),
        origin: "https://example.com",
      },
    ]) {
      const r = await fetch(`http://127.0.0.1:${a.port}/cloud`, {
        method: "POST",
        headers: headers as Record<string, string>,
        body: "{}",
      });
      assert.equal(r.status, 403);
    }
    const r = await fetch(`http://127.0.0.1:${a.port}/cloud`, {
      method: "POST",
      headers: { authorization: "Bearer " + "a".repeat(64) },
      body: JSON.stringify({ action: "shell", apiKey: key }),
    });
    assert((await r.json()).error);
    assert.equal(calls, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("generation pins Phala and forbids paid fallback, training and retention", async () => {
  let body: any;
  const runtime = new OpenRouter((async (_url, options) => {
    body = JSON.parse(options!.body as string);
    return response({
      id: "receipt",
      provider: "Phala",
      model: cloudModel,
      choices: [{ message: { content: "draft" } }],
    });
  }) as typeof fetch);
  await runtime.generate(
    {
      apiKey: key,
      model: cloudModel,
      prompt: "synthetic",
      provider: "phala",
      authorization: {
        networkAllowed: true,
        dataExportAllowed: true,
        additionalSpendingUSD: 0,
      },
    },
    signal(),
  );
  assert.deepEqual(body.provider.only, ["phala"]);
  assert.equal(body.provider.allow_fallbacks, false);
  assert.equal(body.provider.zdr, true);
  assert.equal(body.provider.data_collection, "deny");
  assert.deepEqual(body.provider.max_price, {
    prompt: 0,
    completion: 0,
    request: 0,
  });
});
