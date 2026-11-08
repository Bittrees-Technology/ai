import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Vault } from "../modules/storage/vault.js";
import { digest } from "../modules/task-sync/proof-contract.js";
import { AssignmentRunner } from "../modules/task-sync/assignment-runner.js";

for (const mode of [
  "success",
  "revoked",
  "lost-write",
  "lost-inference",
  "changed",
  "revoked-in-queue",
] as const) {
  test("REST assignment: " + mode, async () => {
    const dir = mkdtempSync(join(tmpdir(), "assignment-run-"));
    const assignment = {
      assignmentId: randomUUID(),
      taskId: randomUUID(),
      taskRevision: 1,
      projectId: randomUUID(),
      workflowId: "review",
      workflowRevision: 1,
      principal: "agent:" + randomUUID(),
    };
    const path = join(dir, "state.sqlite");
    const vault = new Vault(randomBytes(32));
    const signal = new AbortController().signal;
    const runId = randomUUID();
    const calls: string[] = [];
    let generations = 0;
    let enteredModelTurn = false;
    const receipts = new Map<
      string,
      { operationId: string; resultDigest: string }
    >();
    const host: ConstructorParameters<typeof AssignmentRunner>[2] = {
      validator: () => ({ id: "fixture-review", revision: "a".repeat(64) }),
      async validate(input) {
        assert.equal(input.inputDigest, digest("Review the task."));
        assert.equal(input.result.summary, "Review completed");
        return {
          accepted: true,
          validatorId: "fixture-review",
          validatorRevision: "a".repeat(64),
          assignmentDigest: digest(input.assignment),
          inputDigest: input.inputDigest,
          resultDigest: input.resultDigest,
          crmOperationId: input.crmOperationId,
          checkedAt: Date.now(),
          expiresAt: Math.min(Date.now() + 10000, input.claim.expiresAt),
        };
      },
      async modelTurn(_signal, work) {
        enteredModelTurn = true;
        return work();
      },
      async authorize(binding) {
        assert.deepEqual(binding.assignment, assignment);
        if (binding.action === "infer") {
          assert.equal(enteredModelTurn, true);
          if (mode === "revoked-in-queue")
            throw Error("Roles authority revoked");
        }
        if (mode === "revoked" && binding.action === "write")
          throw Error("Roles authority revoked");
      },
      async generate() {
        generations++;
        if (mode === "lost-inference") throw Error("Model response lost");
        return { summary: "Review completed" };
      },
      async request(input, init) {
        const url = new URL(String(input));
        assert.equal(url.protocol, "https:");
        assert.equal(init?.redirect, "error");
        const key = new Headers(init.headers).get("Idempotency-Key");
        calls.push(init.method + " " + url.pathname);
        if (url.pathname.endsWith("/claim")) {
          assert.equal(url.origin, "https://workflow.bittrees.org");
          assert.ok(key);
          return Response.json({
            assignmentDigest: digest(assignment),
            runId,
            leaseId: randomUUID(),
            expiresAt: Date.now() + 30000,
          });
        }
        if (url.pathname.endsWith(assignment.taskId))
          return Response.json({
            assignment:
              mode === "changed"
                ? { ...assignment, taskRevision: 2 }
                : assignment,
            instruction: "Review the task.",
          });
        if (init.method === "GET") return Response.json(receipts.get(url.href));
        assert.equal(init.method, "PUT");
        assert.ok(key && url.pathname.endsWith(key));
        const payload = JSON.parse(String(init.body));
        const receipt = {
          operationId: key,
          resultDigest: payload.resultDigest,
        };
        if (url.origin === "https://crm.bittrees.org") {
          assert.deepEqual(payload.assignment, assignment);
          assert.equal(payload.resultDigest, digest(payload.result));
        } else {
          assert.ok(
            [...receipts.values()].some(
              (r) => r.operationId === payload.crmOperationId,
            ),
          );
        }
        receipts.set(url.href, receipt);
        if (mode === "lost-write" && url.origin === "https://crm.bittrees.org")
          throw Error("CRM committed, response lost");
        return Response.json(receipt);
      },
    };
    let runner = new AssignmentRunner(path, vault, host);
    try {
      const run = () => runner.run(assignment, signal);
      if (
        mode === "revoked" ||
        mode === "changed" ||
        mode === "revoked-in-queue"
      ) {
        await assert.rejects(
          run(),
          mode === "changed" ? /assignment changed/ : /revoked/,
        );
        assert.equal(receipts.size, 0);
        assert.equal(
          runner.status(assignment.assignmentId)?.block?.reason,
          mode === "changed" ? "assignment-changed" : "authority-unavailable",
        );
        assert.equal(generations, mode === "revoked" ? 1 : 0);
      } else {
        if (mode !== "success") {
          await assert.rejects(run(), /lost/);
          runner.close();
          runner = new AssignmentRunner(path, vault, host);
        }
        if (mode === "lost-inference")
          assert.deepEqual(await run(), {
            state: "held",
            reason: "inference-uncertain",
          });
        else {
          assert.deepEqual(await run(), { state: "completed", runId });
          assert.equal(
            runner.status(assignment.assignmentId)?.phase,
            "completed",
          );
          assert.ok(runner.status(assignment.assignmentId)?.lastReceiptId);
          assert.equal(receipts.size, 2);
          const count = calls.length;
          assert.deepEqual(await run(), { state: "completed", runId });
          assert.equal(calls.length, count);
          assert.equal(
            calls.filter((c) => c.startsWith("PUT ") && c.includes("/results/"))
              .length,
            1,
          );
          assert.equal(
            calls.filter((c) => c.startsWith("GET ") && c.includes("/results/"))
              .length,
            1,
          );
        }
        assert.equal(generations, 1);
      }
    } finally {
      runner.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const mode of [
  "lost-central",
  "lost-central-recovery",
  "lost-finalization",
  "revoked-finalization",
  "lost-recovery",
  "wrong-finalization",
] as const) {
  test("durable separately approved CRM finalization: " + mode, async () => {
    const dir = mkdtempSync(join(tmpdir(), "assignment-finalization-"));
    const path = join(dir, "state.sqlite"),
      vault = new Vault(randomBytes(32));
    const assignment = {
      assignmentId: randomUUID(),
      taskId: randomUUID(),
      taskRevision: 7,
      projectId: randomUUID(),
      workflowId: "review",
      workflowRevision: 1,
      principal: "agent:" + randomUUID(),
    };
    let now = Date.now(),
      generated = 0,
      validated = 0,
      revoked = mode === "revoked-finalization",
      central = false,
      finalized = false,
      approved = true;
    const runId = randomUUID(),
      leaseId = randomUUID(),
      calls: string[] = [];
    let centralId: string | undefined,
      writeId: string | undefined,
      summaryDigest: string | undefined;
    const host: ConstructorParameters<typeof AssignmentRunner>[2] = {
      completeTask: () => approved,
      validator: () => ({ id: "fixture", revision: "a".repeat(64) }),
      authorize: async (b) => {
        if (revoked && b.action === "finalize")
          throw Error("revoked source scope");
      },
      validate: async (input) => {
        validated++;
        return {
          accepted: true,
          validatorId: "fixture",
          validatorRevision: "a".repeat(64),
          assignmentDigest: digest(assignment),
          crmOperationId: input.crmOperationId,
          inputDigest: input.inputDigest,
          resultDigest: input.resultDigest,
          checkedAt: now,
          expiresAt: now + 10000,
        };
      },
      generate: async () => {
        generated++;
        return { summary: "Reviewed synthetic evidence" };
      },
      request: async (input, init, binding) => {
        calls.push(binding.action);
        const key = new Headers(init.headers).get("Idempotency-Key"),
          url = new URL(input);
        if (binding.action === "claim")
          return Response.json({
            assignmentDigest: digest(assignment),
            runId,
            leaseId,
            expiresAt: now + 30000,
          });
        if (binding.action === "read")
          return Response.json({
            assignment,
            instruction: "Review synthetic evidence",
          });
        if (binding.action === "write") {
          writeId = key!;
          summaryDigest = digest(JSON.parse(String(init.body)).result);
          return Response.json({
            operationId: writeId,
            resultDigest: summaryDigest,
          });
        }
        if (binding.action === "read-receipt")
          return Response.json({
            operationId: writeId,
            resultDigest: summaryDigest,
          });
        if (binding.action === "complete") {
          assert.equal(central, false);
          central = true;
          centralId = key!;
          if (mode === "lost-central" || mode === "lost-central-recovery")
            throw Error("central committed; reply lost");
          return Response.json({
            operationId: centralId,
            resultDigest: summaryDigest,
          });
        }
        if (binding.action === "read-completion") {
          assert.equal(central, true);
          assert.ok(url.pathname.endsWith(centralId!));
          if (mode === "lost-central-recovery")
            throw Error("central recovery reply lost");
          return Response.json({
            operationId: centralId,
            resultDigest: summaryDigest,
          });
        }
        assert.equal(central, true);
        assert.ok(url.pathname.endsWith(centralId!));
        if (binding.action === "finalize") {
          assert.equal(key, centralId);
          assert.equal(finalized, false);
          finalized = true;
          if (mode === "lost-finalization" || mode === "lost-recovery")
            throw Error("source committed; reply lost");
        } else {
          assert.equal(binding.action, "read-finalization");
          assert.equal(init.method, "GET");
          assert.equal(finalized, true);
          if (mode === "lost-recovery") throw Error("recovery reply lost");
        }
        return Response.json({
          taskId: assignment.taskId,
          taskVersion: mode === "wrong-finalization" ? 99 : 8,
          status: "Done",
          operationId: centralId,
          replayed: binding.action === "read-finalization",
        });
      },
    };
    let runner = new AssignmentRunner(path, vault, host, () => now);
    const run = () => runner.run(assignment, new AbortController().signal);
    try {
      await assert.rejects(
        run(),
        mode === "revoked-finalization"
          ? /revoked/
          : mode === "wrong-finalization"
            ? /mismatch/
            : /lost/,
      );
      assert.equal(generated, 1);
      assert.equal(validated, 1);
      runner.close();
      runner = new AssignmentRunner(path, vault, host, () => now);
      now += 40000; // original workflow lease and validator receipt have expired
      revoked = false;
      if (mode === "revoked-finalization") {
        approved = false;
        assert.deepEqual(await run(), {
          state: "held",
          reason: "source-finalization-approval-unavailable",
        });
        approved = true;
      }
      if (mode === "lost-recovery" || mode === "lost-central-recovery") {
        await assert.rejects(run(), /lost/);
        runner.close();
        runner = new AssignmentRunner(path, vault, host, () => now);
        const count = calls.length;
        assert.deepEqual(await run(), {
          state: "held",
          reason:
            mode === "lost-central-recovery"
              ? "completion-unconfirmed"
              : "source-finalization-unconfirmed",
        });
        assert.equal(calls.length, count);
      } else if (mode === "wrong-finalization")
        await assert.rejects(run(), /mismatch/);
      else {
        assert.deepEqual(await run(), { state: "completed", runId });
        assert.equal(
          runner.status(assignment.assignmentId)?.sourceFinalized,
          true,
        );
      }
      assert.equal(generated, 1);
      assert.equal(validated, 1);
      assert.equal(calls.filter((v) => v === "complete").length, 1);
      assert.equal(calls.filter((v) => v === "write").length, 1);
      assert.equal(
        calls.filter((v) => v === "finalize").length,
        mode === "lost-central-recovery" ? 0 : 1,
      );
    } finally {
      runner.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
