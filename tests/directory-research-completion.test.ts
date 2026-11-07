import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { DirectoryResearchCompletion } from "../modules/research/directory-research-completion.js";
import { Vault } from "../modules/storage/vault.js";
import { canonical } from "../modules/contracts/canonical-json.js";
import { digest } from "../modules/task-sync/proof-contract.js";

test("completion recovery preserves encrypted evidence, operation ID and durable attempt budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "directory-completion."));
  const scopeDigest = "a".repeat(64),
    originalValidationRunId = randomUUID();
  const input = {
    title: "Fixture",
    instruction: canonical({
      kind: "cryptodirectory-research",
      scopeDigest,
      originalValidationRunId,
    }),
  };
  const binding = {
    scopeDigest,
    originalValidationRunId,
    connectionId: randomUUID(),
    workflowId: "fixture",
    job: {
      id: randomUUID(),
      runId: randomUUID(),
      leaseId: randomUUID(),
      leaseUntil: new Date(Date.now() + 60000).toISOString(),
      stepIndex: 0,
      input,
      inputHash: digest(input),
    },
  };
  const vault = new Vault(randomBytes(32)),
    path = join(root, "journal.sqlite");
  const result = {
    scopeDigest,
    receipts: Array.from({ length: 9 }, () => ({
      originalReceiptId: randomUUID(),
      lastRecordedRetryReceiptId: randomUUID(),
      sourceHash: "b".repeat(64),
      model: "fixture",
      modelDigest: "sha256:" + "c".repeat(64),
      answer: { secret: "private-research-answer" },
    })),
  };
  const operations: string[] = [];
  let journal: DirectoryResearchCompletion | undefined;
  const send = async (raw: unknown) => {
    const args = raw as { operationId: string };
    operations.push(args.operationId);
    throw Error("Lost response");
  };
  try {
    assert.throws(
      () =>
        new DirectoryResearchCompletion(
          path,
          vault,
          {
            ...binding,
            job: { ...binding.job, inputHash: "d".repeat(64) },
          },
          send,
        ),
      /reviewed directory scope/,
    );
    journal = new DirectoryResearchCompletion(path, vault, binding, send);
    await assert.rejects(
      journal.run(result, new AbortController().signal),
      /Lost response/,
    );
    journal.close();
    journal = new DirectoryResearchCompletion(path, vault, binding, send);
    await assert.rejects(
      journal.run(undefined, new AbortController().signal),
      /Lost response/,
    );
    await assert.rejects(
      journal.run(undefined, new AbortController().signal),
      /budget exhausted/,
    );
    assert.equal(operations.length, 2);
    assert.equal(operations[0], operations[1]);
    const db = new Database(path, { readonly: true });
    try {
      const row = db
        .prepare("SELECT record FROM directory_research_completion")
        .get() as { record: Buffer };
      assert.equal(
        row.record.includes(Buffer.from("private-research-answer")),
        false,
      );
      const saved = vault.open<{ attempts: number; result: unknown }>(
        row.record,
        "directory-completion:" + scopeDigest,
      );
      assert.equal(saved.attempts, 2);
      assert.deepEqual(saved.result, result);
    } finally {
      db.close();
    }
  } finally {
    journal?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
