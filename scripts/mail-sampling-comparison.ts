// Synthetic Mac experiment only. Does not change production prompts or saved profiles.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Ollama } from "../modules/models/ollama.js";
import {
  mailPrompt,
  mailOutputSchema,
  mailResult,
} from "../modules/connectors/mail-drafts.js";
import type { MailTasks } from "../modules/connectors/mail-tasks.js";
type Snapshot = Awaited<ReturnType<MailTasks["validate"]>>;
if (process.platform !== "darwin")
  throw Error("Mac-only synthetic evaluation; Acer is excluded");
const root = fileURLToPath(new URL("../", import.meta.url));
const bytes = readFileSync(
  new URL("./mail-sampling-comparison-cases.json", import.meta.url),
);
const hash = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
const cases = z
  .array(
    z.strictObject({
      id: z.string(),
      body: z.string(),
      criteria: z.string(),
      bodyTruncated: z.boolean(),
    }),
  )
  .length(8)
  .parse(JSON.parse(bytes.toString()));
const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (
  execFileSync(
    "git",
    [
      "status",
      "--porcelain",
      "--",
      "scripts/mail-sampling-comparison.ts",
      "scripts/mail-sampling-comparison-cases.json",
      "modules/connectors/mail-drafts.ts",
      "modules/models/ollama.ts",
    ],
    { cwd: root, encoding: "utf8" },
  ).trim()
)
  throw Error(
    "Commit fixed evaluator, cases and production sources before inference",
  );
const runtime = new Ollama("http://127.0.0.1:11434", 180000);
const pinned = await runtime.pin({
  id: "synthetic-sampling-comparison",
  runtime: "ollama",
  model: "qwen3.5:9b",
  contextTokens: 4096,
  maxOutputTokens: 1000,
  temperature: 0,
});
if (
  pinned.digest !==
  "6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7"
)
  throw Error("Installed original-model digest changed");
const manifest = {
  experiment: "mail-sampling-comparison-2026-09-25",
  sourceHead,
  caseFileHash: hash(bytes),
  comparison:
    "Identical production prompt/profile; fixed-seed production baseline versus author-recommended non-thinking sampling",
  pinned,
  productionPromptHash: hash(
    readFileSync(
      new URL("../modules/connectors/mail-drafts.ts", import.meta.url),
    ),
  ),
  evaluationScriptHash: hash(readFileSync(new URL(import.meta.url))),
};
console.log(
  JSON.stringify({
    ...manifest,
    event: "manifest",
    cases,
    startedAt: new Date().toISOString(),
    limitations:
      "Manual semantic review required; eight synthetic cases, one generation per variant, summary phase only, not independent or blinded. Cases informed by prior exposed failures; these new instances are fixed before inference. Both variants keep thinking disabled and retain the1000-token output budget. One fixed seed per case/variant is a screening study, not a stochastic reliability estimate. Alternating order is not a controlled latency benchmark.",
  }),
);
// Experiment-process-only transport instrumentation. The production adapter still
// enforces prompt capacity, pinned digest, local model and response validation.
// No production source, saved profile or shared runtime setting is changed.
const originalFetch = globalThis.fetch;
let activeSampling: boolean | null = null;
let captured: {
  request: unknown;
  response?: unknown;
  responseSha256?: string;
} | null = null;
globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  if (
    url.origin !== "http://127.0.0.1:11434" ||
    !["/api/tags", "/api/show", "/api/generate"].includes(url.pathname) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw Error("Experiment transport is restricted to the Mac runtime");
  if (url.pathname !== "/api/generate") return originalFetch(input, init);
  if (activeSampling === null || typeof init?.body !== "string")
    throw Error("Generation outside a fixed experiment variant");
  const request = JSON.parse(init.body);
  if (
    request.model !== pinned.profile.model ||
    request.think !== false ||
    request.stream !== false ||
    request.keep_alive !== 0 ||
    request.options?.num_ctx !== 4096 ||
    request.options?.num_predict !== 1000 ||
    request.options?.temperature !== 0 ||
    init.redirect !== "error"
  )
    throw Error("Production request no longer matches the declared experiment");
  request.options.seed = 250925;
  if (activeSampling)
    Object.assign(request.options, {
      temperature: 0.7,
      top_p: 0.8,
      top_k: 20,
      min_p: 0,
      presence_penalty: 1.5,
      repeat_penalty: 1,
    });
  captured = { request };
  const response = await originalFetch(input, {
    ...init,
    body: JSON.stringify(request),
  });
  const reader = response.body?.getReader();
  if (!reader) throw Error("Missing runtime response body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1024 * 1024) {
        await reader.cancel();
        throw Error("Runtime response exceeded the unchanged 1 MiB bound");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks);
  captured.responseSha256 = hash(body);
  captured.response = JSON.parse(body.toString("utf8"));
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
try {
  for (let index = 0; index < cases.length; index++) {
    const scenario = cases[index]!;
    const message = {
      id: "b".repeat(64),
      mode: "plain",
      from: "Jordan <jordan@example.invalid>",
      subject: "Selected correspondence",
      date: "2026-09-25",
      truncatedMetadata: [],
      sourceVersion: "c".repeat(64),
      attachmentsIncluded: false,
      text: scenario.body,
      bodyAvailable: true,
      bodyTruncated: scenario.bodyTruncated,
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
      projectionHash: hash(JSON.stringify(message)),
    } as Snapshot;
    const baseline = mailPrompt(
      source,
      "Summarize only the selected email: who requested or promised what, preserving conditions and uncertainty.",
      "summarize",
    );
    // Paired order alternates without changing either prompt after seeing outputs.
    for (const variant of index % 2
      ? ["author-sampling", "baseline"]
      : ["baseline", "author-sampling"]) {
      const prompt = baseline;
      activeSampling = variant === "author-sampling";
      captured = null;
      const format = mailOutputSchema("summarize"),
        began = Date.now();
      let raw: string | null = null;
      try {
        raw = await runtime.generate(pinned, prompt, undefined, format);
        const result = mailResult(source, raw, "summarize");
        console.log(
          JSON.stringify({
            ...manifest,
            event: "result",
            scenario,
            variant,
            prompt,
            promptHash: hash(prompt),
            format,
            raw,
            transport: captured,
            result,
            elapsedMs: Date.now() - began,
            structure: "valid",
            semanticReview: "pending",
          }),
        );
      } catch (error) {
        console.log(
          JSON.stringify({
            ...manifest,
            event: "result",
            scenario,
            variant,
            prompt,
            promptHash: hash(prompt),
            format,
            raw,
            transport: captured,
            elapsedMs: Date.now() - began,
            structure: "invalid",
            error: String(error),
            semanticReview: "pending",
          }),
        );
        process.exitCode = 1;
      }
    }
  }
} finally {
  activeSampling = null;
  globalThis.fetch = originalFetch;
}
