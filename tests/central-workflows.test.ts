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
      JSON.stringify({ id: b.id, result: { structuredContent: result } }),
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
    assert.equal(generations, 1);
    await worker.close();
    worker = make();
    assert.equal(worker.status().principal, principal);
    await worker.tick();
    assert.equal(generations, 1);
    assert.equal(completions, 2);
    assert.equal(worker.status().pending, false);
    assert.equal(worker.status().lastReceipt.followUpQueued, true);
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
