import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import Database from "better-sqlite3";
import { Vault } from "../modules/storage/vault.js";
import {
  CentralWorkflowWorker,
  canonical,
} from "../modules/workflows/central-worker.js";
import type { ModelTurn } from "../modules/models/local-turns.js";
import type { Ollama } from "../modules/models/ollama.js";

function fixture(finite = true) {
  const dir = mkdtempSync(join(tmpdir(), "finite-central-")),
    path = join(dir, "state.db"),
    vault = new Vault(randomBytes(32));
  let now = Date.now(),
    mode = "success",
    generations = 0,
    pins = 0,
    admission = "ready",
    completionAttempts = 0;
  let unblock: ((s: string) => void) | undefined;
  const wire: { name: string; args: any; proof: any }[] = [];
  const input = {
    title: "Synthetic local text",
    instruction: "Return synthetic result",
  };
  const job = {
    id: randomUUID(),
    runId: randomUUID(),
    stepIndex: 0,
    leaseId: randomUUID(),
    leaseUntil: new Date(now + 900000).toISOString(),
    input,
    inputHash: createHash("sha256").update(canonical(input)).digest("hex"),
  };
  const config = {
    confirmed: true,
    enabled: true,
    tenant: "synthetic",
    workspace: "synthetic",
    connectionId: randomUUID(),
    workflowId: "synthetic-text-only",
    delegationId: randomUUID(),
    profileId: randomUUID(),
    mcpToken: "synthetic-no-production-token",
    ...(finite
      ? {
          finitePilot: {
            version: 1,
            reviewId: randomUUID(),
            runId: job.runId,
            approvedAt: now,
            expiresAt: now + 900000,
          },
        }
      : {}),
  };
  const runtime = {
    pin: async () => {
      pins++;
      return {
        profile: { model: "synthetic-model" },
        digest: "synthetic-digest",
      };
    },
    generate: async () => {
      generations++;
      if (mode === "corrupt-ledger")
        write("finitePilot", { ...read("finitePilot"), modelTurns: 2 });
      if (mode === "model-lost")
        throw Error("Synthetic inference reply lost after generation");
      if (mode === "model-stalled")
        return new Promise<string>((resolve) => (unblock = resolve));
      if (mode === "invalid-model") return "";
      return "Synthetic result";
    },
  } as unknown as Ollama;
  const request = (async (_url: any, options: any) => {
    const rpc = JSON.parse(options.body),
      name = rpc.params.name;
    wire.push({
      name,
      args: rpc.params.arguments,
      proof: JSON.parse(
        Buffer.from(
          options.headers["x-bittrees-agent-proof"],
          "base64url",
        ).toString(),
      ),
    });
    let result: unknown;
    if (name === "workflow_claim")
      result = {
        job:
          mode === "empty"
            ? null
            : mode === "wrong-run"
              ? { ...job, runId: randomUUID() }
              : job,
      };
    else if (name === "workflow_renew") {
      if (mode === "renew-lost") throw Error("Synthetic renewal reply lost");
      result = { leaseUntil: job.leaseUntil };
    } else {
      completionAttempts++;
      if (mode === "complete-rpc-denied")
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32000, message: "synthetic revoked" },
        });
      if (mode === "complete-denied")
        return Response.json({ error: "synthetic denied" }, { status: 403 });
      if (
        (mode === "complete-lost" && completionAttempts === 1) ||
        mode === "complete-always-lost"
      )
        throw Error("Synthetic completion reply lost");
      result = {
        completed: true,
        runId: job.runId,
        followUpQueued: mode === "unexpected-successor",
      };
    }
    return Response.json({
      jsonrpc: "2.0",
      id: rpc.id,
      result: { structuredContent: result },
    });
  }) as typeof fetch;
  let modelTurn: ModelTurn = async (_signal, work) => work();
  const make = () =>
    new CentralWorkflowWorker(
      path,
      vault,
      runtime,
      () => ({}),
      () => ({ reason: admission, seconds: 60 }),
      (signal, work) => modelTurn(signal, work),
      request,
      () => now,
    );
  const write = (key: string, value: unknown) => {
    const db = new Database(path);
    db.prepare("INSERT OR REPLACE INTO state VALUES(?,?)").run(
      key,
      vault.seal(value, "central-workflows:" + key),
    );
    db.close();
  };
  const read = (key: string) => {
    const db = new Database(path, { readonly: true });
    const row = db.prepare("SELECT value FROM state WHERE key=?").get(key) as
      { value: Buffer } | undefined;
    db.close();
    return row ? vault.open<any>(row.value, "central-workflows:" + key) : null;
  };
  const seed = () => {
    const pair = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    write("identity", {
      ...pair,
      principal: "agent:" + randomUUID(),
      credentialId: createHash("sha256").update(pair.publicKey).digest("hex"),
    });
  };
  return {
    make,
    setTurn: (turn: ModelTurn) => (modelTurn = turn),
    seed,
    config,
    job,
    wire,
    read,
    write,
    mode: (v: string) => (mode = v),
    busy: () => (admission = "busy"),
    advance: (ms: number) => (now += ms),
    generations: () => generations,
    pins: () => pins,
    release: () => unblock?.("Late synthetic result"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("finite pilot never implicitly creates a missing identity", async () => {
  const f = fixture(),
    w = f.make();
  try {
    assert.throws(() => w.configure(f.config), /existing central identity/);
    assert.equal(w.status().principal, null);
    assert.equal(f.read("identity"), null);
    assert.equal(f.wire.length, 0);
  } finally {
    await w.close();
    f.cleanup();
  }
});
test("finite successful pilot stops after three calls/one generation and cannot resume or reset", async () => {
  const f = fixture();
  let w = f.make();
  f.seed();
  try {
    w.configure(f.config);
    await w.tick();
    assert.equal(f.generations(), 1);
    assert.equal(f.wire.length, 3);
    assert.equal(w.status().enabled, false);
    assert.equal(w.status().progress.state, "completed");
    assert.equal(w.status().finitePilot!.reason, "terminal");
    await w.close();
    w = f.make();
    await w.tick();
    assert.equal(f.wire.length, 3);
    assert.throws(() => w.resume());
    assert.throws(() => w.configure({ ...f.config, finitePilot: undefined }));
    assert.throws(() =>
      w.configure({
        ...f.config,
        finitePilot: { ...f.config.finitePilot, reviewId: randomUUID() },
      }),
    );
    assert.equal(f.generations(), 1);
  } finally {
    await w.close();
    f.cleanup();
  }
});
test("one lost completion reconciles saved evidence and the exact operation after restart, then stops", async () => {
  const f = fixture();
  let w = f.make();
  f.seed();
  try {
    w.configure(f.config);
    f.mode("complete-lost");
    await w.tick();
    assert.equal(
      w.status().progress.state,
      "completion-reconciliation-pending",
    );
    assert.equal(w.status().enabled, true);
    const saved = f.read("pending");
    assert.equal(saved.generation.state, "recorded");
    await w.close();
    w = f.make();
    await w.tick();
    assert.equal(f.generations(), 1);
    assert.deepEqual(
      f.wire.map((x) => x.name),
      [
        "workflow_claim",
        "workflow_renew",
        "workflow_complete",
        "workflow_complete",
      ],
    );
    assert.equal(f.wire[2]!.args.operationId, f.wire[3]!.args.operationId);
    assert.deepEqual(f.wire[2]!.args.evidence, f.wire[3]!.args.evidence);
    assert.notEqual(
      f.wire[2]!.proof.request.requestId,
      f.wire[3]!.proof.request.requestId,
    );
    assert.equal(w.status().enabled, false);
    await w.tick();
    assert.equal(f.wire.length, 4);
  } finally {
    await w.close();
    f.cleanup();
  }
});
test("a second uncertain completion exhausts the four-call allowance without regeneration", async () => {
  const f = fixture();
  let w = f.make();
  f.seed();
  try {
    w.configure(f.config);
    f.mode("complete-always-lost");
    await w.tick();
    await w.close();
    w = f.make();
    await w.tick();
    assert.equal(w.status().enabled, false);
    assert.equal(w.status().pending, true);
    assert.equal(w.status().finitePilot!.complete!.count, 2);
    await w.tick();
    assert.equal(f.wire.length, 4);
    assert.equal(f.generations(), 1);
    assert.throws(() => w.resume());
  } finally {
    await w.close();
    f.cleanup();
  }
});
for (const finite of [false, true])
  for (const mode of ["model-lost", "invalid-model"])
    test(`${finite ? "finite" : "ordinary"} ${mode} stops uncertain generation durably`, async () => {
      const f = fixture(finite);
      let w = f.make();
      f.seed();
      try {
        w.configure(f.config);
        f.mode(mode);
        await w.tick();
        assert.equal(f.generations(), 1);
        assert.equal(w.status().enabled, false);
        assert.equal(w.status().generationUncertain, true);
        const operation = f.read("pending").generation.operationId;
        const calls = f.wire.length;
        await w.close();
        w = f.make();
        await w.tick();
        assert.equal(f.generations(), 1);
        assert.equal(f.wire.length, calls);
        assert.equal(f.read("pending").generation.operationId, operation);
        assert.throws(() => w.resume(), /uncertain/);
      } finally {
        await w.close();
        f.cleanup();
      }
    });
test("cancelling an unresponsive model stops waiting and late output cannot be committed or rerun", async () => {
  const f = fixture();
  let w = f.make();
  f.seed();
  try {
    w.configure(f.config);
    f.mode("model-stalled");
    const running = w.tick();
    for (let n = 0; n < 50 && f.generations() === 0; n++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.generations(), 1);
    await w.pause();
    await running;
    f.release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.read("pending").evidence, undefined);
    assert.equal(w.status().enabled, false);
    await w.close();
    w = f.make();
    await w.tick();
    assert.equal(f.generations(), 1);
    assert.throws(() => w.resume());
  } finally {
    await w.close();
    f.cleanup();
  }
});
for (const mode of ["empty", "wrong-run", "renew-lost", "unexpected-successor"])
  test(mode + " cannot poll, reclaim or execute another run", async () => {
    const f = fixture();
    let w = f.make();
    f.seed();
    try {
      w.configure(f.config);
      f.mode(mode);
      await w.tick();
      assert.equal(w.status().enabled, false);
      const calls = f.wire.length,
        turns = f.generations();
      await w.close();
      w = f.make();
      await w.tick();
      assert.equal(f.wire.length, calls);
      assert.equal(f.generations(), turns);
      assert.throws(() => w.resume());
      if (mode === "unexpected-successor")
        assert.equal(w.status().finitePilot!.reason, "unexpected-successor");
    } finally {
      await w.close();
      f.cleanup();
    }
  });
for (const elapsed of [-1, 900001])
  test(
    "finite clock continuity/deadline stops even while admission is busy: " +
      elapsed,
    async () => {
      const f = fixture(),
        w = f.make();
      f.seed();
      try {
        w.configure(f.config);
        f.busy();
        f.advance(elapsed);
        await w.tick();
        assert.equal(w.status().enabled, false);
        assert.equal(f.wire.length, 0);
        assert.equal(f.generations(), 0);
        assert.throws(() => w.resume());
      } finally {
        await w.close();
        f.cleanup();
      }
    },
  );
test("legacy ambiguous model-running/held state is preserved and never regenerated", async () => {
  const f = fixture(false);
  let w = f.make();
  f.seed();
  try {
    w.configure(f.config);
    f.write("pending", { claimId: randomUUID(), job: f.job });
    f.write("progress", { state: "held" });
    await w.close();
    w = f.make();
    await w.tick();
    assert.equal(w.status().generationUncertain, true);
    assert.equal(w.status().enabled, false);
    assert.equal(f.wire.length, 0);
    assert.equal(f.generations(), 0);
    assert.ok(f.read("pending"));
  } finally {
    await w.close();
    f.cleanup();
  }
});
test("changed finite connection scope becomes irreversibly held rather than accepting restored counters", async () => {
  const f = fixture(),
    w = f.make();
  f.seed();
  try {
    w.configure(f.config);
    f.write("config", { ...f.config, workspace: "different" });
    await w.tick();
    assert.equal(w.status().enabled, false);
    assert.equal(f.wire.length, 0);
    assert.equal(w.status().finitePilot!.stopped, true);
    assert.throws(() => w.configure(f.config));
  } finally {
    await w.close();
    f.cleanup();
  }
});

test("ordinary continuous connections retain listening behavior after a confirmed terminal job", async () => {
  const f = fixture(false),
    w = f.make();
  f.seed();
  try {
    w.configure(f.config);
    await w.tick();
    assert.equal(f.generations(), 1);
    assert.equal(f.wire.length, 3);
    assert.equal(w.status().enabled, true);
    assert.equal(w.status().finitePilot, null);
    assert.equal(w.status().generationUncertain, false);
  } finally {
    await w.close();
    f.cleanup();
  }
});
test("concurrent finite workers cannot duplicate the claim or model turn", async () => {
  const f = fixture(),
    a = f.make();
  f.seed();
  a.configure(f.config);
  const b = f.make();
  try {
    await Promise.all([a.tick(), b.tick()]);
    assert.equal(f.wire.length, 1);
    assert.equal(f.generations(), 0);
    assert.equal(a.status().enabled, false);
    assert.equal(a.status().finitePilot!.claim!.count, 1);
  } finally {
    await a.close();
    await b.close();
    f.cleanup();
  }
});
test("pilot reviews longer than fifteen minutes are rejected before identity initialization", async () => {
  const f = fixture(),
    w = f.make();
  try {
    assert.throws(() =>
      w.configure({
        ...f.config,
        finitePilot: {
          ...f.config.finitePilot,
          expiresAt: f.config.finitePilot!.approvedAt + 900001,
        },
      }),
    );
    assert.equal(f.read("identity"), null);
    assert.equal(f.wire.length, 0);
  } finally {
    await w.close();
    f.cleanup();
  }
});

test("loss of a configured identity holds without generating a replacement key", async () => {
  const f = fixture(),
    w = f.make();
  f.seed();
  try {
    w.configure(f.config);
    f.write("identity", null);
    await w.tick();
    assert.equal(w.status().principal, null);
    assert.equal(w.status().enabled, false);
    assert.equal(f.read("identity"), null);
    assert.equal(f.wire.length, 0);
    assert.equal(f.generations(), 0);
  } finally {
    await w.close();
    f.cleanup();
  }
});

test("a clock rollback within the approval interval is detected after a busy tick", async () => {
  const f = fixture(),
    w = f.make();
  f.seed();
  try {
    w.configure(f.config);
    f.busy();
    f.advance(1000);
    await w.tick();
    assert.equal(w.status().enabled, true);
    f.advance(-500);
    await w.tick();
    assert.equal(w.status().enabled, false);
    assert.equal(f.wire.length, 0);
    assert.equal(f.generations(), 0);
  } finally {
    await w.close();
    f.cleanup();
  }
});

test("ledger corruption during a model turn holds without resetting data or rejecting the worker loop", async () => {
  const f = fixture(),
    w = f.make();
  f.seed();
  try {
    w.configure(f.config);
    f.mode("corrupt-ledger");
    await w.tick();
    assert.equal(f.read("config").enabled, false);
    assert.equal(f.read("finitePilot").modelTurns, 2);
    assert.equal(f.read("pending").evidence, undefined);
    assert.equal(f.generations(), 1);
    assert.equal(f.wire.length, 2);
    await w.tick();
    assert.equal(f.wire.length, 2);
    assert.throws(() => w.resume());
  } finally {
    await w.close();
    f.cleanup();
  }
});

test("completion reconciliation cannot replace the original logical operation ID", async () => {
  const f = fixture(),
    w = f.make();
  f.seed();
  try {
    w.configure(f.config);
    f.mode("complete-lost");
    await w.tick();
    const p = f.read("pending");
    const original = p.completeId;
    p.completeId = randomUUID();
    f.write("pending", p);
    await w.tick();
    assert.equal(w.status().enabled, false);
    assert.equal(f.wire.length, 3);
    assert.equal(f.generations(), 1);
    assert.equal(w.status().finitePilot!.complete!.id, original);
  } finally {
    await w.close();
    f.cleanup();
  }
});

test("an explicit completion authorization denial stops without automatic reconciliation", async () => {
  const f = fixture(),
    w = f.make();
  f.seed();
  try {
    w.configure(f.config);
    f.mode("complete-denied");
    await w.tick();
    assert.equal(w.status().enabled, false);
    assert.equal(w.status().progress.state, "held");
    assert.equal(f.wire.length, 3);
    await w.tick();
    assert.equal(f.wire.length, 3);
    assert.equal(f.generations(), 1);
    assert.ok(f.read("pending").evidence);
  } finally {
    await w.close();
    f.cleanup();
  }
});

test("a stalled task queue is cancellable and a late callback cannot start the finite pilot", async () => {
  const f = fixture(),
    w = f.make();
  f.seed();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  w.taskTurn = async (_title, signal, work) => {
    await gate;
    return work(signal);
  };
  try {
    w.configure(f.config);
    const running = w.tick();
    await w.pause();
    await running;
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(w.status().enabled, false);
    assert.equal(f.wire.length, 0);
    assert.equal(f.generations(), 0);
    assert.equal(f.read("pending"), null);
  } finally {
    release();
    await w.close();
    f.cleanup();
  }
});

test("a late model-queue callback cannot begin inference after cancellation", async () => {
  const f = fixture(),
    w = f.make();
  f.seed();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  f.setTurn(async (_signal, work) => {
    await gate;
    return work();
  });
  try {
    w.configure(f.config);
    const running = w.tick();
    for (let n = 0; n < 50 && !f.read("pending")?.generation; n++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.ok(f.read("pending").generation);
    assert.equal(f.generations(), 0);
    await w.pause();
    await running;
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.generations(), 0);
    assert.equal(f.wire.length, 2);
    assert.equal(f.read("pending").generation.invoked, false);
  } finally {
    release();
    await w.close();
    f.cleanup();
  }
});
test("a duplicate model-queue callback cannot invoke the provider twice", async () => {
  const f = fixture(),
    w = f.make();
  f.seed();
  f.setTurn(async (_signal, work) => {
    const first = await work();
    await assert.rejects(async () => work());
    return first;
  });
  try {
    w.configure(f.config);
    await w.tick();
    assert.equal(f.generations(), 1);
    assert.equal(f.wire.length, 3);
    assert.equal(w.status().enabled, false);
  } finally {
    await w.close();
    f.cleanup();
  }
});

test("JSON-RPC completion rejection without a result does not get a reconciliation request", async () => {
  const f = fixture(),
    w = f.make();
  f.seed();
  try {
    w.configure(f.config);
    f.mode("complete-rpc-denied");
    await w.tick();
    assert.equal(w.status().enabled, false);
    assert.equal(f.wire.length, 3);
    await w.tick();
    assert.equal(f.wire.length, 3);
    assert.equal(f.generations(), 1);
  } finally {
    await w.close();
    f.cleanup();
  }
});
