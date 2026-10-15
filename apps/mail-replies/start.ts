// Dedicated, opt-in local text-generation service. Never shares the companion API token.
import express from "express";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { Ollama } from "../../modules/models/ollama.js";
import { generateScopedReply } from "../../modules/connectors/mail-auto-reply.js";
const config = z
  .strictObject({
    token: z.string().regex(/^[a-f0-9]{64}$/),
    model: z.string().min(1).max(200),
  })
  .parse(JSON.parse(readFileSync(process.argv[2] || "", "utf8")));
const runtime = new Ollama(),
  app = express();
let busy = false;
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  const got = Buffer.from(req.headers.authorization || ""),
    expected = Buffer.from("Bearer " + config.token);
  if (
    req.headers.origin ||
    req.headers.host !== "127.0.0.1:43129" ||
    got.length !== expected.length ||
    !timingSafeEqual(got, expected)
  )
    return res.status(403).json({ error: "Denied" });
  next();
});
app.use(express.json({ limit: "48kb", strict: true }));
const profile = {
  id: "mail-replies",
  runtime: "ollama" as const,
  model: config.model,
  contextTokens: 32768,
  maxOutputTokens: 1500,
  temperature: 0,
};
app.get("/health", async (_req, res) => {
  try {
    await runtime.pin(profile, AbortSignal.timeout(5000));
    res.json({ ready: true, protocol: "mail-scoped-reply-v1" });
  } catch {
    res.status(503).json({ ready: false });
  }
});
app.post("/reply", async (req, res) => {
  if (busy) return res.status(429).json({ error: "Busy" });
  busy = true;
  try {
    const signal = AbortSignal.timeout(120000),
      model = await runtime.pin(profile, signal);
    res.json(
      await generateScopedReply(req.body, (prompt, format) =>
        runtime.generate(model, prompt, signal, format),
      ),
    );
  } catch {
    res.status(422).json({ error: "No safe reply available" });
  } finally {
    busy = false;
  }
});
app.listen(43129, "127.0.0.1");
