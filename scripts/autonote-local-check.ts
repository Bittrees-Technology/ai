// Synthetic-only manual local-model check; never contacts a source app or publishes.
import { randomUUID, createHash } from "node:crypto";
import { Ollama } from "../modules/models/ollama.js";
import {
  sourcePrompt,
  sourceResult,
} from "../modules/connectors/source-tasks.js";
const meeting = {
  id: randomUUID(),
  title: "Synthetic planning meeting",
  language: "en",
  version: 1,
  segments: [
    {
      id: "s1",
      start: 0,
      end: 15,
      speaker: "Alex",
      text: "We agreed to review the prototype. I will prepare a draft plan. We have not set a deadline.",
    },
  ],
};
const source = {
  contractVersion: "1.0.0" as const,
  grantId: randomUUID(),
  subjectId: randomUUID(),
  workspaceId: randomUUID(),
  policyRevision: "autonote-ai-transcript-v1" as const,
  meeting,
  projectionHash: createHash("sha256")
    .update(JSON.stringify(meeting))
    .digest("hex"),
  publication: {
    mode: "autonote_review_only" as const,
    directCrm: false as const,
  },
};
const runtime = new Ollama();
const pinned = await runtime.pin({
  id: "synthetic-autonote-check",
  runtime: "ollama",
  model: "qwen3:1.7b",
  contextTokens: 4096,
  maxOutputTokens: 1000,
  temperature: 0,
});
const began = Date.now();
const raw = await runtime.generate(
  pinned,
  sourcePrompt(
    source,
    "Summarize the agreement and proposed action. Return JSON only.",
  ),
);
const result = sourceResult(source, raw);
console.log(
  JSON.stringify(
    {
      model: pinned.profile.model,
      digest: pinned.digest,
      elapsedMs: Date.now() - began,
      result,
    },
    null,
    2,
  ),
);
