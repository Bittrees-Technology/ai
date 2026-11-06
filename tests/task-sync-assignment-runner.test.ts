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
    const receipts = new Map<
      string,
      { operationId: string; resultDigest: string }
    >();
    const host: ConstructorParameters<typeof AssignmentRunner>[2] = {
      async authorize(binding) {
        assert.deepEqual(binding.assignment, assignment);
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
      if (mode === "revoked" || mode === "changed") {
        await assert.rejects(
          run(),
          mode === "revoked" ? /revoked/ : /assignment changed/,
        );
        assert.equal(receipts.size, 0);
        assert.equal(generations, mode === "changed" ? 0 : 1);
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
