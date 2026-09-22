import { z } from "zod";
import { modelProfileSchema } from "../contracts/index.js";
const modelSchema = z.object({
  name: z.string().min(1),
  digest: z.string().min(32),
  size: z.number().positive(),
  remote_model: z.string().optional(),
  remote_host: z.string().optional(),
});
export type ModelProfile = z.infer<typeof modelProfileSchema>;
export interface PinnedModel {
  profile: ModelProfile;
  digest: string;
}
export class ModelError extends Error {
  constructor(
    public code:
      | "MODEL_UNAVAILABLE"
      | "MODEL_CHANGED"
      | "REMOTE_MODEL_DENIED"
      | "INVALID_OUTPUT"
      | "CAPACITY",
  ) {
    super(code);
  }
}
export class Ollama {
  private endpoint: URL;
  constructor(
    endpoint = "http://127.0.0.1:11434",
    private timeoutMs = 120_000,
  ) {
    const u = new URL(endpoint);
    if (
      u.protocol !== "http:" ||
      u.hostname !== "127.0.0.1" ||
      u.username ||
      u.password ||
      u.pathname !== "/" ||
      u.search ||
      u.hash
    )
      throw new Error("Only a literal loopback model endpoint is permitted");
    this.endpoint = u;
  }
  private async call(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const controller = AbortSignal.any([
      AbortSignal.timeout(this.timeoutMs),
      ...(signal ? [signal] : []),
    ]);
    let r: Response;
    try {
      r = await fetch(new URL(path, this.endpoint), {
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
              headers: { "Content-Type": "application/json" },
            }),
        redirect: "error",
        signal: controller,
      });
    } catch (e) {
      if (controller.aborted) throw controller.reason;
      throw new ModelError("MODEL_UNAVAILABLE");
    }
    if (!r.ok) {
      await r.body?.cancel();
      throw new ModelError("MODEL_UNAVAILABLE");
    }
    if (!r.body) throw new ModelError("INVALID_OUTPUT");
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1024 * 1024) throw new ModelError("CAPACITY");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new ModelError("INVALID_OUTPUT");
    }
  }
  async listModels(signal?: AbortSignal) {
    const parsed = z
      .object({ models: z.array(modelSchema).max(1000) })
      .safeParse(await this.call("/api/tags", undefined, signal));
    if (!parsed.success) throw new ModelError("INVALID_OUTPUT");
    return parsed.data.models.filter(
      (m) => !m.remote_model && !m.remote_host && !m.name.endsWith("-cloud"),
    );
  }
  async pin(raw: unknown, signal?: AbortSignal): Promise<PinnedModel> {
    const profile = modelProfileSchema.parse(raw);
    if (profile.runtime !== "ollama") throw new ModelError("MODEL_UNAVAILABLE");
    const model = (await this.listModels(signal)).find(
      (m) => m.name === profile.model,
    );
    if (!model) throw new ModelError("MODEL_UNAVAILABLE");
    const info = (await this.call(
      "/api/show",
      { model: profile.model },
      signal,
    )) as Record<string, unknown>;
    if (!info || typeof info !== "object")
      throw new ModelError("INVALID_OUTPUT");
    if (info.remote_model || info.remote_host)
      throw new ModelError("REMOTE_MODEL_DENIED");
    return { profile: structuredClone(profile), digest: model.digest };
  }
  async capabilities(model: PinnedModel, signal?: AbortSignal) {
    await this.verify(model, signal);
    const info = (await this.call(
      "/api/show",
      { model: model.profile.model },
      signal,
    )) as Record<string, unknown>;
    if (info.remote_model || info.remote_host)
      throw new ModelError("REMOTE_MODEL_DENIED");
    return {
      generate: true,
      embed:
        Array.isArray(info.capabilities) &&
        info.capabilities.includes("embedding"),
      tools: false,
    };
  }
  private async verify(model: PinnedModel, signal?: AbortSignal) {
    const current = (await this.listModels(signal)).find(
      (m) => m.name === model.profile.model,
    );
    if (!current || current.digest !== model.digest)
      throw new ModelError("MODEL_CHANGED");
  }
  async generate(
    model: PinnedModel,
    prompt: string,
    signal?: AbortSignal,
    format?: "json" | Record<string, unknown>,
  ): Promise<string> {
    // Internal caller-supplied schema; snapshot it before any asynchronous work.
    const encodedFormat =
      format === undefined ? undefined : JSON.stringify(format);
    if (encodedFormat !== undefined && Buffer.byteLength(encodedFormat) > 16384)
      throw new ModelError("CAPACITY");
    const outputFormat =
      encodedFormat === undefined ? undefined : JSON.parse(encodedFormat);
    if (
      !prompt ||
      prompt.length > 32000 ||
      Buffer.byteLength(prompt) >
        model.profile.contextTokens - model.profile.maxOutputTokens - 256
    )
      throw new ModelError("CAPACITY");
    await this.verify(model, signal);
    const info = (await this.call(
      "/api/show",
      { model: model.profile.model },
      signal,
    )) as Record<string, unknown>;
    if (info.remote_model || info.remote_host)
      throw new ModelError("REMOTE_MODEL_DENIED");
    const output = z
      .object({
        response: z.string().min(1).max(128000),
        done: z.literal(true),
      })
      .safeParse(
        await this.call(
          "/api/generate",
          {
            model: model.profile.model,
            prompt,
            ...(outputFormat === undefined ? {} : { format: outputFormat }),
            stream: false,
            think: false,
            keep_alive: 0,
            options: {
              num_ctx: model.profile.contextTokens,
              num_predict: model.profile.maxOutputTokens,
              temperature: model.profile.temperature,
            },
          },
          signal,
        ),
      );
    if (!output.success) throw new ModelError("INVALID_OUTPUT");
    await this.verify(model, signal);
    return output.data.response;
  }
  async embed(model: PinnedModel, input: string, signal?: AbortSignal) {
    if (input.length > 32000) throw new ModelError("CAPACITY");
    const caps = await this.capabilities(model, signal);
    if (!caps.embed) throw new ModelError("INVALID_OUTPUT");
    const result = z
      .object({
        embeddings: z
          .array(z.array(z.number().finite()).min(1).max(16384))
          .length(1),
      })
      .safeParse(
        await this.call(
          "/api/embed",
          { model: model.profile.model, input, truncate: false, keep_alive: 0 },
          signal,
        ),
      );
    if (!result.success) throw new ModelError("INVALID_OUTPUT");
    await this.verify(model, signal);
    return result.data.embeddings[0]!;
  }
}
