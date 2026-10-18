import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { cloudModel, keyInput } from "./cloud-connection.js";
import { OpenRouter } from "./openrouter.js";
const input = z.discriminatedUnion("action", [
  keyInput.extend({ action: z.literal("check") }),
  keyInput.extend({
    action: z.literal("generate"),
    operationId: z.uuid(),
    prompt: z.string().min(1).max(30000),
  }),
]);
async function json(
  request: typeof fetch,
  path: string,
  key: string,
  signal: AbortSignal,
) {
  const r = await request("https://openrouter.ai/api/v1/" + path, {
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    headers: { authorization: "Bearer " + key },
  });
  if (!r.ok) {
    await r.body?.cancel();
    throw Error("OpenRouter account check unavailable");
  }
  if (!r.body) throw Error("Missing account receipt");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of r.body) {
    bytes += chunk.length;
    if (bytes > 2_000_000) throw Error("Account receipt too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
export async function cloudReadiness(
  key: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
) {
  const k = await json(request, "key", key, signal);
  if (k.data?.limit !== 0 || k.data?.limit_reset != null)
    return {
      ready: false,
      reason: "The dedicated key must have a zero-dollar lifetime cap.",
    };
  const credits = await json(request, "credits", key, signal);
  const amounts = z
    .object({
      total_credits: z.number().finite(),
      total_usage: z.number().finite(),
    })
    .safeParse(credits.data);
  const balance = amounts.success
    ? amounts.data.total_credits - amounts.data.total_usage
    : NaN;
  if (!Number.isFinite(balance) || balance < 0)
    return {
      ready: false,
      reason:
        "OpenRouter account balance is negative or unavailable. No inference was sent.",
    };
  const catalog = await json(request, "endpoints/zdr", key, signal);
  const endpoint = catalog.data?.find(
    (e: any) =>
      e.model_id === cloudModel &&
      e.tag === "phala" &&
      e.status === 0 &&
      e.pricing?.prompt != null &&
      e.pricing?.completion != null &&
      ["prompt", "completion", "request"].every(
        (p) => Number(e.pricing?.[p] ?? 0) === 0,
      ),
  );
  if (!endpoint)
    return {
      ready: false,
      reason:
        "The pinned free zero-retention provider is unavailable. No fallback is allowed.",
    };
  if (k.data?.free_model_daily_requests?.remaining === 0)
    return { ready: false, reason: "Free daily allowance is exhausted." };
  return {
    ready: true,
    reason:
      "Pinned free model and zero-retention provider eligible; live inference still requires task consent.",
    model: cloudModel,
    provider: "phala",
    balanceUSD: balance,
  };
}
export function cloudHelper(token: string, request: typeof fetch = fetch) {
  if (!/^[a-f0-9]{64}$/.test(token))
    throw Error("Strong helper token required");
  let busy = false;
  let last = 0;
  const seen = new Set<string>();
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    const actual = Buffer.from(req.headers.authorization ?? ""),
      expected = Buffer.from("Bearer " + token);
    if (
      req.method !== "POST" ||
      req.url !== "/cloud" ||
      req.headers.origin ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      res.writeHead(403).end("{}");
      return;
    }
    if (busy || Date.now() - last < 1000) {
      res.writeHead(429).end("{}");
      return;
    }
    busy = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      let text = "";
      for await (const c of req) {
        text += c;
        if (Buffer.byteLength(text) > 40000) throw Error("Request too large");
      }
      const i = input.parse(JSON.parse(text));
      last = Date.now();
      if (i.action === "generate") {
        if (seen.has(i.operationId) || seen.size >= 10000)
          throw Error("Operation requires reconciliation");
        seen.add(i.operationId);
      }
      const readiness = await cloudReadiness(
        i.apiKey,
        controller.signal,
        request,
      );
      if (i.action === "check") {
        res.end(JSON.stringify(readiness));
        return;
      }
      if (!readiness.ready) {
        res.end(JSON.stringify({ error: readiness.reason }));
        return;
      }
      const result = await new OpenRouter(request).generate(
        {
          model: cloudModel,
          prompt: i.prompt,
          apiKey: i.apiKey,
          provider: "phala",
          authorization: {
            networkAllowed: true,
            dataExportAllowed: true,
            additionalSpendingUSD: 0,
          },
        },
        controller.signal,
      );
      res.end(JSON.stringify(result));
    } catch {
      if (!res.destroyed)
        res.end(
          JSON.stringify({
            error:
              "Cloud request could not be confirmed. No automatic retry or paid fallback.",
          }),
        );
    } finally {
      clearTimeout(timeout);
      busy = false;
    }
  });
}
