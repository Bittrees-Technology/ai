import { z } from "zod";
/** Prepared transport only. No credential lookup, account creation or implicit cloud fallback. */
export class OpenRouter {
  constructor(private request: typeof fetch = fetch) {}
  async generate(
    input: {
      model: string;
      prompt: string;
      apiKey: string;
      provider?: "phala";
      authorization: {
        networkAllowed: boolean;
        dataExportAllowed: boolean;
        additionalSpendingUSD: 0;
      };
    },
    signal: AbortSignal,
  ) {
    const a = input.authorization;
    if (
      !a.networkAllowed ||
      !a.dataExportAllowed ||
      a.additionalSpendingUSD !== 0
    )
      throw Error("OpenRouter needs explicit network and data authorization");
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:-]+:free$/.test(input.model))
      throw Error(
        "Only explicitly selected free models are allowed under the current budget",
      );
    if (
      input.prompt.length > 30000 ||
      !input.apiKey ||
      /[\r\n]/.test(input.apiKey)
    )
      throw Error("Invalid OpenRouter request");
    const response = await this.request(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
        headers: {
          authorization: "Bearer " + input.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: input.model,
          messages: [{ role: "user", content: input.prompt }],
          max_tokens: 1500,
          stream: false,
          provider: {
            allow_fallbacks: false,
            ...(input.provider ? { only: [input.provider] } : {}),
            require_parameters: true,
            data_collection: "deny",
            zdr: true,
            max_price: { prompt: 0, completion: 0, request: 0 },
          },
        }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(
        "OpenRouter request not confirmed; no automatic retry or paid fallback",
      );
    }
    if (!response.body) throw Error("Missing OpenRouter receipt");
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        size += r.value.length;
        if (size > 65536) throw Error("OpenRouter response too large");
        chunks.push(r.value);
      }
    } finally {
      await reader.cancel();
    }
    const receipt = z
      .object({
        id: z.string().min(1),
        provider: z.string().optional(),
        model: z.string().min(1),
        choices: z
          .array(
            z.object({
              message: z.object({ content: z.string().min(1).max(16000) }),
            }),
          )
          .min(1)
          .max(1),
      })
      .parse(JSON.parse(Buffer.concat(chunks).toString()));
    if (receipt.model !== input.model)
      throw Error("Unexpected remote model; reconcile provider receipt");
    if (input.provider && receipt.provider?.toLowerCase() !== input.provider)
      throw Error("Unexpected upstream provider; reconcile receipt");
    return {
      upstreamProvider: receipt.provider,
      provider: "openrouter",
      requestId: receipt.id,
      model: receipt.model,
      output: receipt.choices[0]!.message.content,
    };
  }
}
