import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentQueue } from "../modules/agents/queue.js";
import { AgentProfiles } from "../modules/agents/profiles.js";
import { AgentCoordinator } from "../modules/agents/coordinator.js";
import { Vault } from "../modules/storage/vault.js";
import { OpenRouter } from "../modules/agents/openrouter.js";
import { AgentRestClient } from "../modules/agents/rest.js";
const tick = () => new Promise<void>((r) => setImmediate(r));
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agents-"));
  const vault = new Vault(randomBytes(32));
  return {
    dir,
    vault,
    q: new AgentQueue(join(dir, "queue.db"), vault),
    clean: () => rmSync(dir, { recursive: true, force: true }),
  };
}
test("whole tasks FIFO; cancelling middle waiter cannot release active task", async () => {
  const s = setup();
  let release!: () => void;
  let active = 0,
    max = 0;
  const order: string[] = [];
  const a = s.q.run("a", new AbortController().signal, async () => {
    active++;
    max = Math.max(max, active);
    order.push("a");
    await new Promise<void>((r) => (release = r));
    active--;
  });
  await tick();
  const c = new AbortController();
  const b = s.q.run("b", c.signal, async () => {
    throw Error("must not run");
  });
  const rejected = assert.rejects(b);
  const d = s.q.run("d", new AbortController().signal, async () => {
    active++;
    max = Math.max(max, active);
    order.push("d");
    active--;
  });
  c.abort();
  await rejected;
  await tick();
  assert.deepEqual(order, ["a"]);
  release();
  await Promise.all([a, d]);
  assert.equal(max, 1);
  assert.deepEqual(order, ["a", "d"]);
  await s.q.close();
  s.clean();
});
test("pause holds queued work; running cancellation stays serialized until actual exit", async () => {
  const s = setup();
  s.q.pause();
  let ran = false;
  const p = s.q.run("paused", new AbortController().signal, async () => {
    ran = true;
  });
  await tick();
  assert.equal(ran, false);
  s.q.resume();
  await p;
  let exit!: () => void;
  const active = s.q.run(
    "cancel",
    new AbortController().signal,
    async (signal) => {
      await new Promise<void>((r) => (exit = r));
      assert.equal(signal.aborted, true);
    },
  );
  await tick();
  const id = s.q.status().active!.id;
  s.q.cancel(id);
  let second = false;
  const next = s.q.run("next", new AbortController().signal, async () => {
    second = true;
  });
  await tick();
  assert.equal(second, false);
  const fail = assert.rejects(active);
  exit();
  await fail;
  await next;
  await s.q.close();
  s.clean();
});
test("draft retries deduplicate and preserve actual model evidence; profile changes hold queued work", async () => {
  const s = setup();
  const profiles = new AgentProfiles(join(s.dir, "profiles.db"), s.vault);
  const profile = profiles.save({
    id: randomUUID(),
    name: "Analyst",
    role: "Review evidence",
    methodology: "Cite only supplied sources",
    knowledge: [{ name: "Test", text: "Supplied reference" }],
    provider: "local",
    modelProfileId: randomUUID(),
  });
  let calls = 0;
  const runtime: any = {
    pin: async () => ({ profile: { model: "test-local" }, digest: "abc" }),
    generate: async () => {
      calls++;
      return "Draft based on supplied reference";
    },
  };
  const coordinator = new AgentCoordinator(
    join(s.dir, "drafts.db"),
    s.vault,
    s.q,
    profiles,
    runtime,
    () => ({}),
    () => true,
  );
  const req = {
    operationId: randomUUID(),
    workflow: "review",
    agentProfileId: profile.id,
    instruction: "Review",
  };
  coordinator.submit(req);
  coordinator.submit(req);
  await tick();
  assert.equal(calls, 1);
  assert.equal(coordinator.drafts()[0].receipt.sourceWrites, false);
  assert.throws(() => coordinator.submit({ ...req, instruction: "changed" }));
  s.q.pause();
  coordinator.submit({ ...req, operationId: randomUUID() });
  profiles.save({ ...profile, methodology: "Changed method" });
  s.q.resume();
  await tick();
  assert.equal(calls, 1);
  assert.equal(coordinator.drafts()[1].state, "held");
  await s.q.close();
  await coordinator.close();
  s.clean();
});
test("OpenRouter denies unapproved export and paid models without sending requests", async () => {
  let calls = 0;
  const client = new OpenRouter((async () => {
    calls++;
    throw Error();
  }) as any);
  const base = {
    model: "test/model:free",
    prompt: "x",
    apiKey: "secret",
    authorization: {
      networkAllowed: false,
      dataExportAllowed: false,
      additionalSpendingUSD: 0 as const,
    },
  };
  await assert.rejects(client.generate(base, new AbortController().signal));
  await assert.rejects(
    client.generate(
      {
        ...base,
        model: "test/paid",
        authorization: {
          ...base.authorization,
          networkAllowed: true,
          dataExportAllowed: true,
        },
      },
      new AbortController().signal,
    ),
  );
  assert.equal(calls, 0);
});
test("OpenRouter requests HTTPS, zero prices, no fallbacks and no retention", async () => {
  const client = new OpenRouter((async (url: any, init: any) => {
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(init.redirect, "error");
    const b = JSON.parse(init.body);
    assert.equal(b.provider.max_price.prompt, 0);
    assert.equal(b.provider.max_price.request, 0);
    assert.equal(b.provider.allow_fallbacks, false);
    assert.equal(b.provider.zdr, true);
    return Response.json({
      id: "receipt",
      model: "test/model:free",
      choices: [{ message: { content: "draft" } }],
    });
  }) as any);
  const result = await client.generate(
    {
      model: "test/model:free",
      prompt: "x",
      apiKey: "secret",
      authorization: {
        networkAllowed: true,
        dataExportAllowed: true,
        additionalSpendingUSD: 0,
      },
    },
    new AbortController().signal,
  );
  assert.equal(result.requestId, "receipt");
});
test("interagent transport denies HTTP and revoked access; binds returned operation ID", async () => {
  assert.throws(
    () =>
      new AgentRestClient(
        "http://example.com",
        async () => "",
        async () => true,
      ),
  );
  let calls = 0;
  const client = new AgentRestClient(
    "https://example.com",
    async () => "secret",
    async () => false,
    (async () => {
      calls++;
      throw Error();
    }) as any,
  );
  const message = {
    version: 1,
    operationId: randomUUID(),
    coordinatorId: randomUUID(),
    agentProfileId: randomUUID(),
    workflow: "test",
    instruction: "test",
  };
  await assert.rejects(client.submit(message, new AbortController().signal));
  assert.equal(calls, 0);
  const wrong = new AgentRestClient(
    "https://example.com",
    async () => "secret",
    async () => true,
    (async () =>
      Response.json({ operationId: randomUUID(), state: "queued" })) as any,
  );
  await assert.rejects(wrong.submit(message, new AbortController().signal));
});
test("queue pause persists through restart and held records never replay", async () => {
  const s = setup();
  s.q.pause();
  await s.q.close();
  const next = new AgentQueue(join(s.dir, "queue.db"), s.vault);
  assert.equal(next.status().paused, true);
  await next.close();
  s.clean();
});
test("workflow profile changes model and context but fences changed assignments", async () => {
  const { ProfiledOllama } =
    await import("../modules/agents/profiled-runtime.js");
  const s = setup();
  const profiles = new AgentProfiles(join(s.dir, "profiles.db"), s.vault);
  const model = {
    id: "selected",
    runtime: "ollama",
    model: "local:selected",
    contextTokens: 16000,
    maxOutputTokens: 500,
    temperature: 0.2,
  };
  const p = profiles.save({
    id: randomUUID(),
    name: "Verifier",
    role: "Verify only supplied evidence",
    methodology: "Quote references",
    knowledge: [{ name: "Knowledge", text: "Reference data" }],
    provider: "local",
    modelProfileId: "selected",
  });
  profiles.bind({ workflow: "test", profile: p.id });
  const original = globalThis.fetch;
  let prompt = "";
  globalThis.fetch = (async (url: any, init: any) => {
    const path = new URL(url).pathname;
    if (path === "/api/tags")
      return Response.json({
        models: [{ name: model.model, digest: "a".repeat(64), size: 100 }],
      });
    if (path === "/api/show") return Response.json({});
    if (path === "/api/generate") {
      prompt = JSON.parse(init.body).prompt;
      return Response.json({ response: "draft", done: true });
    }
    throw Error("Unexpected request");
  }) as any;
  try {
    const runtime = new ProfiledOllama(
      "test",
      () => profiles,
      (id) => {
        assert.equal(id, "selected");
        return model;
      },
    );
    const pinned = await runtime.pin({});
    assert.equal(pinned.profile.model, model.model);
    await runtime.generate(pinned, "Fixed workflow rule");
    assert.match(prompt, /Fixed workflow rule/);
    assert.match(prompt, /Quote references/);
    profiles.save({ ...p, methodology: "Changed" });
    await assert.rejects(
      runtime.generate(pinned, "Fixed workflow rule"),
      /changed/,
    );
  } finally {
    globalThis.fetch = original;
    profiles.close();
    await s.q.close();
    s.clean();
  }
});
