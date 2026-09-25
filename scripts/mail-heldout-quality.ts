// Synthetic-only Mac quality evaluation. No source credentials, stores or sends.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Ollama } from "../modules/models/ollama.js";
import {
  separatedMailDraft,
  mailResult,
} from "../modules/connectors/mail-drafts.js";
import type { MailTasks } from "../modules/connectors/mail-tasks.js";
type Snapshot = Awaited<ReturnType<MailTasks["validate"]>>;
if (process.platform !== "darwin")
  throw Error("Synthetic evaluation is Mac-only; Acer is excluded");
const root = fileURLToPath(new URL("../", import.meta.url));
const caseBytes = readFileSync(
  new URL("./mail-heldout-cases.json", import.meta.url),
);
const caseFileHash = createHash("sha256").update(caseBytes).digest("hex");
const selectedCases = z
  .array(
    z.strictObject({
      id: z.string(),
      body: z.string(),
      request: z.string(),
      summaryCriteria: z.string(),
      replyCriteria: z.string(),
      bodyTruncated: z.boolean().optional(),
    }),
  )
  .length(12)
  .parse(JSON.parse(caseBytes.toString()));
const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const promptSourceHash = createHash("sha256")
  .update(
    readFileSync(
      new URL("../modules/connectors/mail-drafts.ts", import.meta.url),
    ),
  )
  .digest("hex");
const model = process.env.MAIL_HELDOUT_MODEL ?? "qwen3.5:9b";
const digests: Record<string, string> = {
  "qwen3.5:9b":
    "6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7",
  "huihui_ai/qwen3.5-abliterated:9b":
    "92a443adb124f5e805bbdee23fdb38fcd22a7bf00a1016b53f764e741369c600",
};
if (!digests[model])
  throw Error("Use one of the two reviewed installed Mac models");
const runtime = new Ollama("http://127.0.0.1:11434", 180000);
const pinned = await runtime.pin({
  id: "synthetic-mail-heldout",
  runtime: "ollama",
  model,
  contextTokens: 4096,
  maxOutputTokens: 1000,
  temperature: 0,
});
if (pinned.digest !== digests[model])
  throw Error("Model digest changed; re-review before evaluation");
console.log(
  JSON.stringify({
    experiment: "mail-heldout-production-2026-09-25",
    event: "manifest",
    caseFileHash,
    sourceHead,
    promptSourceHash,
    pinned,
    cases: selectedCases,
    semanticReview: "manual review required; no automated quality acceptance",
    startedAt: new Date().toISOString(),
  }),
);
for (const scenario of selectedCases) {
  const message = {
    id: "b".repeat(64),
    mode: "plain",
    from: "Sam <sam@example.invalid>",
    subject: "Selected correspondence",
    date: "2026-09-25",
    truncatedMetadata: [],
    sourceVersion: "c".repeat(64),
    attachmentsIncluded: false,
    text: scenario.body,
    bodyAvailable: true,
    bodyTruncated: scenario.bodyTruncated ?? false,
  };
  const source = {
    grantId: "a".repeat(64),
    mailbox: "alex@example.invalid",
    wallet: "0x" + "1".repeat(40),
    folder: "INBOX",
    scopes: ["metadata", "plain"],
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    policyRevision: "mail-ai-selected-v1",
    message,
    projectionHash: createHash("sha256")
      .update(JSON.stringify(message))
      .digest("hex"),
  } as Snapshot;
  const began = Date.now(),
    stages: unknown[] = [];
  try {
    const combined = await separatedMailDraft(
      source,
      scenario.request,
      async (prompt, format) => {
        const start = Date.now();
        const raw = await runtime.generate(pinned, prompt, undefined, format);
        stages.push({
          prompt,
          promptHash: createHash("sha256").update(prompt).digest("hex"),
          format,
          raw,
          elapsedMs: Date.now() - start,
        });
        return raw;
      },
      async () => {},
    );
    const result = mailResult(source, combined, "draft");
    const resident = await fetch("http://127.0.0.1:11434/api/ps", {
      signal: AbortSignal.timeout(5000),
    }).then((r) => r.json());
    console.log(
      JSON.stringify({
        experiment: "mail-heldout-production-2026-09-25",
        caseFileHash,
        sourceHead,
        promptSourceHash,
        scenario,
        pinned,
        elapsedMs: Date.now() - began,
        stages,
        result,
        structure: "valid",
        residentAfter: resident,
        semanticReview: "pending",
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        experiment: "mail-heldout-production-2026-09-25",
        caseFileHash,
        sourceHead,
        promptSourceHash,
        scenario,
        pinned,
        elapsedMs: Date.now() - began,
        stages,
        structure: "invalid",
        error: String(error),
        semanticReview: "pending",
      }),
    );
    process.exitCode = 1;
  }
}
