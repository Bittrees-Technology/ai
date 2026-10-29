import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID, createHash, verify } from "node:crypto";
import {
  CentralWorkflowWorker,
  canonical,
} from "../modules/workflows/central-worker.js";
import { Vault } from "../modules/storage/vault.js";
import { Ollama } from "../modules/models/ollama.js";
test("central worker preserves signed identity and completed model evidence across lost replies and restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "central-worker-")),
    key = randomBytes(32),
    profileId = randomUUID();
  let generations = 0,
    completions = 0,
    lost = true,
    publicKey = "";
  const input = { title: "A task", instruction: "Return a result." },
    job = {
      id: randomUUID(),
      runId: randomUUID(),
      stepIndex: 0,
      leaseId: randomUUID(),
      leaseUntil: new Date(Date.now() + 900000).toISOString(),
      input,
      inputHash: createHash("sha256").update(canonical(input)).digest("hex"),
    };
  const runtime = {
    pin: async () => ({
      profile: { model: "fixture" },
      digest: "fixture-digest",
    }),
    generate: async () => {
      generations++;
      return "Result";
    },
  } as unknown as Ollama;
  const request: typeof fetch = async (_url, options: any) => {
    const b = JSON.parse(options.body),
      p = JSON.parse(
        Buffer.from(
          options.headers["x-bittrees-agent-proof"],
          "base64url",
        ).toString(),
      );
    assert.ok(
      verify(
        null,
        Buffer.from(
          "Bittrees MCP authority request v1\n" + canonical(p.request),
        ),
        publicKey,
        Buffer.from(p.signature, "base64"),
      ),
    );
    assert.equal(
      p.request.parametersDigest,
      createHash("sha256")
        .update(
          canonical({ tool: b.params.name, arguments: b.params.arguments }),
        )
        .digest("hex"),
    );
    let result: any;
    if (b.params.name === "workflow_claim") result = { job };
    else if (b.params.name === "workflow_renew")
      result = { leaseUntil: job.leaseUntil };
    else {
      completions++;
      if (lost) {
        lost = false;
        throw Error("Reply lost");
      }
      result = { completed: true, runId: job.runId, followUpQueued: true };
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: b.id,
        result: { structuredContent: result },
      }),
    );
  };
  const make = () =>
    new CentralWorkflowWorker(
      join(dir, "state.db"),
      new Vault(key),
      runtime,
      () => ({}),
      () => ({ reason: "ready", seconds: 60 }),
      async (_s, fn) => fn(),
      request,
    );
  let worker = make();
  try {
    const e = worker.enrollment(randomUUID());
    publicKey = e.request.publicKey;
    const principal = e.request.principal;
    worker.configure({
      confirmed: true,
      enabled: true,
      tenant: "t",
      workspace: "w",
      connectionId: randomUUID(),
      workflowId: "test",
      delegationId: randomUUID(),
      profileId,
      mcpToken: "fixture-token-123456",
    });
    await worker.tick();
    assert.equal(worker.status().pending, true);
    assert.deepEqual(worker.status().currentJob, {
      id: job.id,
      runId: job.runId,
      stepIndex: 0,
      title: input.title,
      leaseUntil: job.leaseUntil,
      completionPending: true,
    });
    assert.equal(
      JSON.stringify(worker.status()).includes("fixture-token-123456"),
      false,
    );
    assert.equal(JSON.stringify(worker.status()).includes('"output"'), false);

    assert.equal(generations, 1);
    await worker.close();
    worker = make();
    assert.equal(worker.status().principal, principal);
    await worker.tick();
    assert.equal(generations, 1);
    assert.equal(completions, 2);
    assert.equal(worker.status().pending, false);
    assert.equal(worker.status().lastReceipt.followUpQueued, true);
    assert.equal(worker.status().lastReceipt.workflowId, "test");
    assert.equal(worker.status().currentJob, null);
    assert.equal(
      JSON.stringify(worker.status()).includes("fixture-token"),
      false,
    );
    await worker.pause();
    await worker.tick();
    assert.equal(generations, 1);
  } finally {
    await worker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("central worker holds revoked, malformed, expired and unbounded renewals before model execution", async () => {
  for (const renewal of [
    null,
    {},
    { leaseUntil: "not-a-date" },
    { leaseUntil: new Date(Date.now() - 1000).toISOString() },
    { leaseUntil: new Date(Date.now() + 3600000).toISOString() },
  ]) {
    const dir = await mkdtemp(join(tmpdir(), "central-renew-"));
    let generations = 0,
      completions = 0;
    const input = { title: "Task", instruction: "Return result" };
    const job = {
      id: randomUUID(),
      runId: randomUUID(),
      stepIndex: 0,
      leaseId: randomUUID(),
      leaseUntil: new Date(Date.now() + 900000).toISOString(),
      input,
      inputHash: createHash("sha256").update(canonical(input)).digest("hex"),
    };
    const request: typeof fetch = async (_url, options: any) => {
      const body = JSON.parse(options.body);
      if (body.params.name === "workflow_complete") completions++;
      if (body.params.name === "workflow_renew" && renewal === null)
        return new Response("revoked", { status: 403 });
      const result = body.params.name === "workflow_claim" ? { job } : renewal;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { structuredContent: result },
        }),
      );
    };
    const runtime = {
      pin: async () => ({}),
      generate: async () => {
        generations++;
        return "output";
      },
    } as unknown as Ollama;
    const worker = new CentralWorkflowWorker(
      join(dir, "state.db"),
      new Vault(randomBytes(32)),
      runtime,
      () => ({}),
      () => ({ reason: "ready", seconds: 60 }),
      async (_s, fn) => fn(),
      request,
    );
    try {
      worker.configure({
        confirmed: true,
        enabled: true,
        tenant: "t",
        workspace: "w",
        connectionId: randomUUID(),
        workflowId: "test",
        delegationId: randomUUID(),
        profileId: randomUUID(),
        mcpToken: "fixture-token-123456",
      });
      await worker.tick();
      assert.equal(worker.status().progress.state, "held");
      assert.equal(worker.status().pending, true);
      assert.equal(generations, 0);
      assert.equal(completions, 0);
    } finally {
      await worker.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("central restart recovery binds actual instructions, run and step before any model turn", async () => {
  for (const change of [
    "stale-hash",
    "run",
    "step",
    "new-input",
    "unchanged",
  ]) {
    const dir = await mkdtemp(join(tmpdir(), "central-recovery-"));
    const key = randomBytes(32);
    const input = {
      title: "Original task",
      instruction: "Return original result",
    };
    const job = {
      id: randomUUID(),
      runId: randomUUID(),
      stepIndex: 0,
      leaseId: randomUUID(),
      leaseUntil: new Date(Date.now() - 1000).toISOString(),
      input,
      inputHash: createHash("sha256").update(canonical(input)).digest("hex"),
    };
    let restarted = false,
      generations = 0,
      completions = 0,
      renewals = 0;
    const request: typeof fetch = async (_url, options: any) => {
      const body = JSON.parse(options.body);
      let result: unknown;
      if (body.params.name === "workflow_claim") {
        const recovered = { ...job, input: { ...job.input } };
        if (restarted) {
          recovered.leaseId = randomUUID();
          recovered.leaseUntil = new Date(Date.now() + 900000).toISOString();
          if (change === "run") recovered.runId = randomUUID();
          if (change === "step") recovered.stepIndex = 1;
          if (change === "stale-hash" || change === "new-input")
            recovered.input.instruction = "Changed instructions";
          if (change === "new-input")
            recovered.inputHash = createHash("sha256")
              .update(canonical(recovered.input))
              .digest("hex");
        }
        result = { job: recovered };
      } else if (body.params.name === "workflow_renew") {
        renewals++;
        if (!restarted) throw Error("Renewal reply unavailable before restart");
        result = { leaseUntil: new Date(Date.now() + 900000).toISOString() };
      } else {
        completions++;
        result = { completed: true, runId: job.runId, followUpQueued: false };
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { structuredContent: result },
        }),
      );
    };
    const runtime = {
      pin: async () => ({
        profile: { model: "fixture" },
        digest: "fixture-digest",
      }),
      generate: async () => {
        generations++;
        return "Original result";
      },
    } as unknown as Ollama;
    const make = () =>
      new CentralWorkflowWorker(
        join(dir, "state.db"),
        new Vault(key),
        runtime,
        () => ({}),
        () => ({ reason: "ready", seconds: 60 }),
        async (_signal, fn) => fn(),
        request,
      );
    let worker = make();
    try {
      worker.configure({
        confirmed: true,
        enabled: true,
        tenant: "fixture",
        workspace: "fixture",
        connectionId: randomUUID(),
        workflowId: "recovery",
        delegationId: randomUUID(),
        profileId: randomUUID(),
        mcpToken: "fixture-token-123456",
      });
      await worker.tick();
      assert.equal(worker.status().pending, true);
      assert.equal(worker.status().progress.state, "held");
      assert.equal(generations, 0);
      assert.equal(renewals, 1);
      await worker.close();
      restarted = true;
      worker = make();
      await worker.tick();
      if (change === "unchanged") {
        assert.equal(generations, 1);
        assert.equal(completions, 1);
        assert.equal(worker.status().lastReceipt.runId, job.runId);
        assert.equal(worker.status().pending, false);
      } else {
        assert.equal(generations, 0, change);
        assert.equal(completions, 0, change);
        assert.equal(renewals, 1, change);
        assert.equal(worker.status().pending, true, change);
        assert.equal(worker.status().progress.state, "held", change);
      }
    } finally {
      await worker.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});
