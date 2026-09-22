// Synthetic compatibility probe; literal Mac loopback only, no source apps.
import { Ollama } from "../modules/models/ollama.js";
const runtime = new Ollama("http://127.0.0.1:11434");
const schema = {
  type: "object",
  properties: { answer: { type: "string", enum: ["ready"] } },
  required: ["answer"],
  additionalProperties: false,
};
for (const model of [
  "qwen3:1.7b",
  "qwen3.5:9b",
  "huihui_ai/qwen3.5-abliterated:9b",
]) {
  const pinned = await runtime.pin({
    id: "synthetic-format-check",
    runtime: "ollama",
    model,
    contextTokens: 4096,
    maxOutputTokens: 100,
    temperature: 0,
  });
  for (const format of ["json", schema] as const) {
    const began = Date.now();
    try {
      const raw = await runtime.generate(
        pinned,
        'Return only JSON: {"answer":"ready"}',
        undefined,
        format,
      );
      console.log(
        JSON.stringify({
          model,
          digest: pinned.digest,
          format,
          elapsedMs: Date.now() - began,
          raw,
        }),
      );
    } catch (error) {
      console.log(
        JSON.stringify({
          model,
          digest: pinned.digest,
          format,
          elapsedMs: Date.now() - began,
          error: String(error),
        }),
      );
    }
  }
}
