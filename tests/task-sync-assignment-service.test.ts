import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Vault } from "../modules/storage/vault.js";
import { Ollama } from "../modules/models/ollama.js";
import { immediateTurn } from "../modules/models/local-turns.js";
import { AssignmentService } from "../modules/task-sync/assignment-service.js";
import {
  launchAssignmentServiceBroker,
  nativeAssignmentServiceClient,
} from "../modules/task-sync/assignment-service-native.js";

const assignment = () => ({
  assignmentId: randomUUID(),
  taskId: randomUUID(),
  taskRevision: 1,
  projectId: randomUUID(),
  workflowId: "fixture",
  workflowRevision: 1,
  principal: "agent:" + randomUUID(),
});
const review = () => ({
  version: 1 as const,
  epoch: randomUUID(),
  approvedAt: Date.now(),
  expiresAt: Date.now() + 60000,
  profileId: "fixture",
  modelDigest: "a".repeat(64),
  validator: { id: "fixture-review", revision: "a".repeat(64) },
  assignments: [assignment()],
});

test("assignment service has no storage or model activity without native admission", async () => {
  const dir = mkdtempSync(join(tmpdir(), "assignment-disabled-"));
  try {
    const path = join(dir, "service.db");
    const service = new AssignmentService({
      path,
      runnerPath: join(dir, "runner.db"),
      vault: new Vault(randomBytes(32)),
      runtime: new Ollama(),
      profile: () => {
        throw Error("Unexpected profile read");
      },
      turn: immediateTurn,
      admission: () => {
        throw Error("Unexpected admission read");
      },
    });
    await service.tick();
    assert.equal(service.status().phase, "disabled");
    assert.equal(existsSync(path), false);
    await service.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native capability without a validator holds before intake and inference", async () => {
  const dir = mkdtempSync(join(tmpdir(), "assignment-no-validator-"));
  let otherCalls = 0;
  const service = new AssignmentService({
    path: join(dir, "service.db"),
    runnerPath: join(dir, "runner.db"),
    vault: new Vault(randomBytes(32)),
    runtime: new Ollama(),
    profile: () => {
      throw Error("Unexpected model access");
    },
    turn: immediateTurn,
    admission: () => true,
    client: {
      execute: async (raw: unknown) => {
        if ((raw as { kind: string }).kind === "review")
          return Response.json({
            review: { ...review(), validator: undefined },
          });
        otherCalls++;
        throw Error("Unexpected source action");
      },
    },
  });
  try {
    await service.tick();
    assert.equal(service.status().hold, "validation-required");
    assert.equal(otherCalls, 0);
    assert.equal(service.status().assignments[0]?.attempts, 0);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assignment attempt budget and operator pause survive service restart and epoch changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "assignment-budget-"));
  let current = review(),
    intakes = 0;
  const vault = new Vault(randomBytes(32));
  const options = {
    path: join(dir, "service.db"),
    runnerPath: join(dir, "runner.db"),
    vault,
    runtime: new Ollama(),
    profile: () => {
      throw Error("Unexpected model call");
    },
    turn: immediateTurn,
    admission: () => true,
    client: {
      async execute(raw: unknown) {
        const op = raw as { kind: string };
        if (op.kind === "review") return Response.json({ review: current });
        intakes++;
        return Response.json({ error: "Held fixture" }, { status: 503 });
      },
    },
  };
  try {
    let service = new AssignmentService(options);
    await service.tick();
    await service.pause();
    await service.close();
    service = new AssignmentService(options);
    assert.equal(service.status().phase, "paused");
    await service.tick();
    assert.equal(intakes, 1);
    service.resume();
    await service.tick();
    await service.close();
    current = { ...current, epoch: randomUUID() };
    service = new AssignmentService(options);
    await service.tick();
    await service.tick();
    assert.equal(intakes, 3);
    assert.equal(service.status().hold, "attempt-budget");
    assert.equal(service.status().assignments[0]?.attempts, 3);
    await service.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native assignment broker rejects scope drift, stale epoch and revocation before forwarding", async () => {
  let current: ReturnType<typeof review> | null = review();
  const approved = current;
  let forwards = 0,
    revoke = false;
  const broker = await launchAssignmentServiceBroker({
    current: () => current,
    authorize: async () => {
      if (revoke) current = null;
    },
    forward: async () => {
      forwards++;
      return Response.json({});
    },
  });
  try {
    const client = nativeAssignmentServiceClient(broker.environment)!;
    const execute = (raw: unknown) =>
      client.execute(raw, AbortSignal.timeout(3000));
    await assert.rejects(
      execute({
        kind: "assignment",
        epoch: approved.epoch,
        input: { kind: "task", assignmentId: randomUUID() },
      }),
    );
    await assert.rejects(
      execute({
        kind: "assignment",
        epoch: randomUUID(),
        input: {
          kind: "task",
          assignmentId: approved.assignments[0]!.assignmentId,
        },
      }),
    );
    await assert.rejects(
      execute({
        kind: "authorize",
        epoch: approved.epoch,
        binding: {
          action: "read",
          assignment: { ...approved.assignments[0], taskRevision: 2 },
        },
      }),
    );
    revoke = true;
    await assert.rejects(
      execute({
        kind: "authorize",
        epoch: approved.epoch,
        binding: { action: "read", assignment: approved.assignments[0] },
      }),
    );
    assert.equal(forwards, 0);
  } finally {
    await broker.close();
  }
});

for (const stage of ["before-pin", "during-pin"] as const) {
  test(
    "native model admission expiry " + stage + " prevents generation",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "assignment-model-admission-")),
        approved = review();
      let now = Date.now(),
        pins = 0,
        generations = 0;
      const runId = randomUUID(),
        leaseId = randomUUID();
      const service = new AssignmentService({
        path: join(dir, "service.db"),
        runnerPath: join(dir, "runner.db"),
        vault: new Vault(randomBytes(32)),
        runtime: {
          pin: async () => {
            pins++;
            now = approved.expiresAt + 1;
            return { digest: "a".repeat(64) };
          },
          generate: async () => {
            generations++;
            throw Error("Unapproved generation");
          },
        } as unknown as Ollama,
        profile: () => ({}),
        turn: immediateTurn,
        admission: () => true,
        now: () => now,
        client: {
          execute: async (raw: unknown) => {
            const op = raw as any;
            if (op.kind === "review")
              return Response.json({ review: approved });
            if (op.kind === "authorize") {
              if (op.binding.action === "infer" && stage === "before-pin")
                now = approved.expiresAt + 1;
              return Response.json({ authorized: true });
            }
            if (op.kind === "assignment") {
              if (op.input.kind === "intake") return Response.json({ runId });
              if (op.input.kind === "claim")
                return Response.json({
                  assignmentDigest: (
                    await import("../modules/task-sync/proof-contract.js")
                  ).digest(approved.assignments[0]),
                  runId,
                  leaseId,
                  expiresAt: approved.expiresAt + 60000,
                });
              if (op.input.kind === "task")
                return Response.json({
                  assignment: approved.assignments[0],
                  instruction: "Synthetic approved input",
                });
            }
            throw Error("Unexpected source effect");
          },
        },
      });
      try {
        await service.tick();
        assert.equal(generations, 0);
        assert.equal(pins, stage === "before-pin" ? 0 : 1);
        assert.equal(
          service.status().assignments[0]?.phase,
          "inference-unconfirmed",
        );
      } finally {
        await service.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}
