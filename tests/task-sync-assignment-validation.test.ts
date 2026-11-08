import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { Vault } from "../modules/storage/vault.js";
import { AssignmentRunner } from "../modules/task-sync/assignment-runner.js";
import { digest } from "../modules/task-sync/proof-contract.js";
import {
  launchAssignmentServiceBroker,
  nativeAssignmentServiceClient,
} from "../modules/task-sync/assignment-service-native.js";

import { checkAssignmentNativeAction } from "../modules/task-sync/assignment-native-admission.js";

const validator = {
  id: "integer-addition",
  revision: digest({ rule: "integer-addition", version: 1 }),
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "validated-assignment-")),
    path = join(dir, "runner.db"),
    vault = new Vault(randomBytes(32));
  const assignment = {
    assignmentId: randomUUID(),
    taskId: randomUUID(),
    taskRevision: 1,
    projectId: randomUUID(),
    workflowId: "integer-addition",
    workflowRevision: 1,
    principal: "agent:" + randomUUID(),
  };
  let now = Date.now(),
    generated = 0,
    writes = 0,
    completions = 0,
    validations = 0,
    accepted = false,
    expireBeforeWrite = false;
  const receipts = new Map<string, unknown>();
  const claim = {
    assignmentDigest: digest(assignment),
    runId: randomUUID(),
    leaseId: randomUUID(),
    expiresAt: now + 60000,
  };
  const receipt = (input: any) => ({
    accepted: true,
    validatorId: validator.id,
    validatorRevision: validator.revision,
    assignmentDigest: digest(assignment),
    inputDigest: input.inputDigest,
    resultDigest: input.resultDigest,
    crmOperationId: input.crmOperationId,
    checkedAt: now,
    expiresAt: now + 10000,
  });
  const host: ConstructorParameters<typeof AssignmentRunner>[2] = {
    validator: () => validator,
    authorize: async () => {},
    generate: async () => {
      generated++;
      return { summary: "42" };
    },
    validate: async (input) => {
      validations++;
      assert.equal(input.inputDigest, digest("12 + 30"));
      assert.equal(Number(input.result.summary), 12 + 30);
      if (!accepted) throw Error("Independent validation rejected");
      return receipt(input);
    },
    request: async (url, init) => {
      if (url.endsWith("/claim")) return Response.json(claim);
      if (url.endsWith(assignment.taskId)) {
        if (expireBeforeWrite && validations) now += 20000;
        return Response.json({ assignment, instruction: "12 + 30" });
      }
      if (init.method === "GET") return Response.json(receipts.get(url));
      const payload = JSON.parse(String(init.body)),
        operationId = new Headers(init.headers).get("idempotency-key");
      if (url.includes("/results/")) writes++;
      else completions++;
      const result = { operationId, resultDigest: payload.resultDigest };
      receipts.set(url, result);
      return Response.json(result);
    },
  };
  let runner = new AssignmentRunner(path, vault, host, () => now);
  return {
    assignment,
    claim,
    path,
    vault,
    host,
    receipt,
    get runner() {
      return runner;
    },
    counts: () => ({ generated, writes, completions, validations }),
    allow: () => {
      accepted = true;
    },
    expire: () => {
      expireBeforeWrite = true;
    },
    run: () => runner.run(assignment, AbortSignal.timeout(3000)),
    reopen() {
      runner.close();
      runner = new AssignmentRunner(path, vault, host, () => now);
    },
    cleanup() {
      runner.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("missing validator holds before claiming or generating", async () => {
  const f = fixture();
  try {
    f.host.validator = undefined;
    f.host.validate = undefined;
    assert.deepEqual(await f.run(), {
      state: "held",
      reason: "validation-required",
    });
    assert.deepEqual(f.counts(), {
      generated: 0,
      writes: 0,
      completions: 0,
      validations: 0,
    });
  } finally {
    f.cleanup();
  }
});
test("rejected validation holds saved result across restart and later validates without inference replay", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.run(), /validation rejected/);
    assert.equal(
      f.runner.status(f.assignment.assignmentId)?.phase,
      "validation-held",
    );
    assert.equal(f.counts().writes, 0);
    assert.equal(f.counts().completions, 0);
    f.reopen();
    f.allow();
    assert.deepEqual(await f.run(), {
      state: "completed",
      runId: f.claim.runId,
    });
    assert.deepEqual(f.counts(), {
      generated: 1,
      writes: 1,
      completions: 1,
      validations: 2,
    });
    assert.equal(
      f.runner.status(f.assignment.assignmentId)?.validation?.validatorId,
      validator.id,
    );
  } finally {
    f.cleanup();
  }
});
for (const mutation of [
  "result",
  "input",
  "operation",
  "assignment",
  "validator",
  "expiry",
  "lifetime",
] as const) {
  test(
    "validation rejects mismatched " + mutation + " before effects",
    async () => {
      const f = fixture();
      try {
        f.host.validate = async (input) => {
          const r = f.receipt(input);
          if (mutation === "result") r.resultDigest = "a".repeat(64);
          if (mutation === "input") r.inputDigest = "a".repeat(64);
          if (mutation === "operation") r.crmOperationId = randomUUID();
          if (mutation === "assignment") r.assignmentDigest = "a".repeat(64);
          if (mutation === "validator") r.validatorRevision = "a".repeat(64);
          if (mutation === "expiry") r.expiresAt = r.checkedAt - 1;
          if (mutation === "lifetime") r.expiresAt = r.checkedAt + 31000;
          return r;
        };
        await assert.rejects(f.run(), /validation binding/);
        assert.equal(f.counts().writes, 0);
        assert.equal(f.counts().completions, 0);
      } finally {
        f.cleanup();
      }
    },
  );
}
test("validation expiring during source recheck cannot write", async () => {
  const f = fixture();
  try {
    f.allow();
    f.expire();
    await assert.rejects(f.run(), /Current independent/);
    assert.equal(f.counts().writes, 0);
  } finally {
    f.cleanup();
  }
});
test("legacy completed receipt is not silently promoted to validated completion", async () => {
  const f = fixture();
  try {
    f.allow();
    await f.run();
    f.runner.close();
    const db = new Database(f.path);
    const row = db
      .prepare("SELECT record FROM assignments WHERE id=?")
      .get(f.assignment.assignmentId) as { record: Buffer };
    const aad = "task-assignment:" + f.assignment.assignmentId;
    const state = f.vault.open<any>(row.record, aad);
    delete state.validation;
    db.prepare("UPDATE assignments SET record=? WHERE id=?").run(
      f.vault.seal(state, aad),
      f.assignment.assignmentId,
    );
    db.close();
    const runner = new AssignmentRunner(f.path, f.vault, f.host);
    try {
      assert.equal(
        runner.status(f.assignment.assignmentId)?.phase,
        "completed-unvalidated",
      );
      assert.deepEqual(
        await runner.run(f.assignment, AbortSignal.timeout(3000)),
        { state: "held", reason: "legacy-completion-unvalidated" },
      );
    } finally {
      runner.close();
    }
  } finally {
    rmSync(join(f.path, ".."), { recursive: true, force: true });
  }
});

test("native effect gate rejects bypass, changed result/operation and revoked authority", async () => {
  const f = fixture();
  let forward = 0,
    revoked = false;
  const review = {
    version: 1 as const,
    epoch: randomUUID(),
    approvedAt: Date.now(),
    expiresAt: Date.now() + 60000,
    profileId: "fixture",
    modelDigest: "a".repeat(64),
    validator,
    assignments: [f.assignment],
  };
  const input = {
    assignment: f.assignment,
    claim: f.claim,
    crmOperationId: randomUUID(),
    inputDigest: digest("12 + 30"),
    resultDigest: digest({ summary: "42" }),
    result: { summary: "42" },
  };
  const broker = await launchAssignmentServiceBroker({
    current: () => review,
    authorize: async (review, binding) => {
      checkAssignmentNativeAction(
        review,
        [
          {
            assignmentDigest: digest(f.assignment),
            inputDigest: input.inputDigest,
            resultDigest: input.resultDigest,
            evidenceReference: "Arithmetic fixture",
            reviewedAt: review.approvedAt,
          },
        ],
        binding,
      );
      if (revoked) throw Error("Revoked");
    },
    validate: async (_review, value) => {
      assert.equal(value.result.summary, "42");
      return f.receipt(value);
    },
    forward: async () => {
      forward++;
      return Response.json({});
    },
  });
  try {
    const client = nativeAssignmentServiceClient(broker.environment)!;
    const execute = (raw: unknown) =>
      client.execute(raw, AbortSignal.timeout(3000));
    const write = {
      kind: "write",
      assignmentId: f.assignment.assignmentId,
      runId: f.claim.runId,
      leaseId: f.claim.leaseId,
      crmOperationId: input.crmOperationId,
      result: input.result,
    };
    const effect = (op = write) =>
      execute({ kind: "assignment", epoch: review.epoch, input: op });
    await assert.rejects(effect());
    assert.equal(forward, 0);
    const validation = await execute({
      kind: "validate",
      epoch: review.epoch,
      input,
    });
    assert.equal(validation.ok, true);
    await assert.rejects(effect({ ...write, result: { summary: "41" } }));
    await assert.rejects(effect({ ...write, crmOperationId: randomUUID() }));
    assert.equal(forward, 0);
    assert.equal((await effect()).ok, true);
    assert.equal(forward, 1);
    assert.equal(
      (
        await execute({
          kind: "assignment",
          epoch: review.epoch,
          input: {
            kind: "complete",
            assignmentId: f.assignment.assignmentId,
            runId: f.claim.runId,
            leaseId: f.claim.leaseId,
            crmOperationId: input.crmOperationId,
            operationId: randomUUID(),
            resultDigest: input.resultDigest,
            expiresAt: f.claim.expiresAt,
          },
        })
      ).ok,
      true,
    );
    assert.equal(forward, 2);
    revoked = true;
    await assert.rejects(effect());
    assert.equal(forward, 2);
  } finally {
    await broker.close();
    f.cleanup();
  }
});

test("native finalization IPC requires separate status scope and current per-wire admission", async () => {
  const f = fixture();
  let approved = false,
    revoked = false,
    changeDuringCheck = false,
    forwarded = 0;
  const review = {
    version: 1 as const,
    epoch: randomUUID(),
    approvedAt: Date.now(),
    expiresAt: Date.now() + 60000,
    profileId: "fixture",
    modelDigest: "a".repeat(64),
    validator,
    assignments: [f.assignment],
  };
  const input = {
    kind: "finalize" as const,
    assignmentId: f.assignment.assignmentId,
    runId: f.claim.runId,
    leaseId: f.claim.leaseId,
    crmOperationId: randomUUID(),
    operationId: randomUUID(),
    resultDigest: "b".repeat(64),
    expiresAt: f.claim.expiresAt,
  };
  const broker = await launchAssignmentServiceBroker({
    current: () => ({ ...review, completeTask: approved }),
    authorize: async (_review, binding) => {
      checkAssignmentNativeAction(_review, [], binding);
      assert.equal(binding.claim?.runId, input.runId);
      assert.equal(binding.claim?.leaseId, input.leaseId);
      assert.equal(binding.crmOperationId, input.crmOperationId);
      assert.equal(
        binding.request?.url,
        "https://mcp.bittrees.org/v1/crm-assignments",
      );
      assert.equal(binding.request?.operationId, input.operationId);
      if (revoked) throw Error("Revoked");
      if (changeDuringCheck) approved = false;
    },
    forward: async () => {
      forwarded++;
      return Response.json({});
    },
  });
  try {
    const client = nativeAssignmentServiceClient(broker.environment)!;
    const call = (op: unknown = input) =>
      client.execute(
        { kind: "assignment", epoch: review.epoch, input: op },
        AbortSignal.timeout(3000),
      );
    await assert.rejects(call(), /Native enrollment unavailable/);
    assert.equal(forwarded, 0);
    approved = true;
    revoked = true;
    await assert.rejects(call(), /Native enrollment unavailable/);
    assert.equal(forwarded, 0);
    revoked = false;
    changeDuringCheck = true;
    await assert.rejects(call(), /Native enrollment unavailable/);
    assert.equal(forwarded, 0);
    changeDuringCheck = false;
    approved = true;
    assert.equal((await call()).ok, true);
    assert.equal(forwarded, 1);
    const { expiresAt, ...rest } = input;
    assert.equal((await call({ ...rest, kind: "finalization" })).ok, true);
    assert.equal(forwarded, 2);
  } finally {
    await broker.close();
    f.cleanup();
  }
});
