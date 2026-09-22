// Synthetic only: this probes local generation, not source authorization or live mail.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Ollama } from "../modules/models/ollama.js";
import {
  attachmentPlan,
  summarizeAttachmentParts,
} from "../modules/connectors/mail-attachment-batches.js";
import type { MailTasks } from "../modules/connectors/mail-tasks.js";
const text =
  Array.from(
    { length: 36 },
    (_, i) =>
      `Record ${i + 1}: Project ${i + 1} has a proposed budget of EUR ${(i + 1) * 100}. This is an estimate, not an approved expense. Review is pending; nobody has authorized payment.\n`,
  ).join("") +
  "\nFinal correction: Project 36 was cancelled. Its EUR 3600 estimate is withdrawn, and no payment is authorized.\n";
const request =
  "Summarize this part accurately. Distinguish estimates from approvals, preserve any correction or cancellation, and do not invent payments. Do not infer details from other parts.";
const source = {
  grantId: "a".repeat(64),
  mailbox: "synthetic@example.invalid",
  wallet: "0x" + "1".repeat(40),
  folder: "INBOX",
  scopes: ["metadata", "attachment"],
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  policyRevision: "mail-ai-selected-v2",
  projectionHash: createHash("sha256").update(text).digest("hex"),
  message: {
    id: "b".repeat(64),
    mode: "attachment-text",
    from: "synthetic@example.invalid",
    subject: "Project estimates",
    date: "2026-09-22",
    truncatedMetadata: [],
    sourceVersion: createHash("sha256").update(text).digest("hex"),
    attachmentsIncluded: true,
    attachment: {
      id: "1.2",
      filename: "estimates.txt",
      contentType: "text/plain",
      encodedBytes: Buffer.byteLength(text),
      supported: true,
      text,
      bytes: Buffer.byteLength(text),
      truncated: false,
    },
  },
} as Awaited<ReturnType<MailTasks["validate"]>>;
const runtime = new Ollama(process.env.MAIL_PROBE_ENDPOINT);
const pinned = await runtime.pin({
  id: "synthetic-large-mail",
  runtime: "ollama",
  model: process.env.MAIL_LOCAL_MODEL || "qwen3.5:9b",
  contextTokens: 4096,
  maxOutputTokens: 1000,
  temperature: 0,
});
const plan = attachmentPlan(source, request, pinned)!;
assert.ok(plan.length > 1);
assert.equal(plan.map((p) => p.section.text).join(""), text);
console.log(
  JSON.stringify({
    type: "plan",
    syntheticOnly: true,
    model: pinned,
    request,
    sourceText: text,
    sourceBytes: Buffer.byteLength(text),
    parts: plan.map((p) => ({
      id: p.section.id,
      text: p.section.text,
      promptBytes: Buffer.byteLength(p.prompt),
    })),
  }),
);
let call = 0,
  checks = 0;
const start = Date.now();
try {
  const result = await summarizeAttachmentParts(
    source,
    request,
    pinned,
    async (prompt) => {
      const began = Date.now(),
        index = call++;
      const raw = await runtime.generate(pinned, prompt);
      console.log(
        JSON.stringify({
          type: "part",
          index,
          elapsedMs: Date.now() - began,
          raw,
        }),
      );
      return raw;
    },
    async () => {
      checks++;
    },
    new AbortController().signal,
  );
  console.log(
    JSON.stringify({
      type: "result",
      elapsedMs: Date.now() - start,
      calls: call,
      syntheticValidationCallbacks: checks,
      result,
      manualReviewCriteria: [
        "No estimated expense is described as approved or paid.",
        "Final cancellation and withdrawn EUR 3600 are preserved.",
        "No claim of full cross-part reconciliation.",
      ],
      qualityAcceptance: "requires-manual-review",
      sourceAuthorizationTested: false,
    }),
  );
} catch (e) {
  console.log(
    JSON.stringify({
      type: "failure",
      elapsedMs: Date.now() - start,
      calls: call,
      error: String(e),
    }),
  );
  process.exitCode = 1;
}
