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
