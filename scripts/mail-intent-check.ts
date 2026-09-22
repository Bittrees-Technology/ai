// Synthetic-only Mac probe. No Mail account, source credentials, saving or sending.
import { createHash } from "node:crypto";
import { Ollama } from "../modules/models/ollama.js";
import {
  mailPrompt,
  mailResult,
  mailOutputSchema,
} from "../modules/connectors/mail-drafts.js";
import type { MailTasks } from "../modules/connectors/mail-tasks.js";
type Snapshot = Awaited<ReturnType<MailTasks["validate"]>>;
const cases = [
  {
    id: "receipt-only",
    body: "Please sign the service agreement and return it tomorrow. The fee is EUR 2400.",
    request:
      "Only acknowledge receipt. Do not promise to read, sign, return, pay or follow up.",
    criteria:
      "Acknowledges receipt only; no future action or acceptance of terms.",
  },
  {
    id: "decline-without-reason",
    body: "Can you speak at our launch on 14 October? We can arrange travel.",
    request: "Politely decline. Do not invent a reason or offer another date.",
    criteria:
      "Clearly declines; no invented reason, alternative or future availability.",
  },
  {
    id: "user-question",
    body: "The shipment is ready. We estimate delivery in three days, but have not provided tracking.",
    request:
      "Ask for the tracking number. Do not confirm arrival or promise to be available.",
    criteria: "Asks for tracking; does not assert delivery or availability.",
  },
  {
    id: "conditional-authorization",
    body: "Can you approve the EUR 400 repair? Inspection has not happened yet.",
    request:
      "Say I will approve the repair only if the inspection confirms the quoted fault. Do not approve it now.",
    criteria:
      "Preserves inspection condition and EUR 400 context; no present approval.",
  },
  {
    id: "correction-latest",
    body: "Earlier: We proposed EUR 700 for Friday. Update: Cancel that proposal. The new proposal is EUR 650 for Monday, still awaiting your approval.",
    request: "Decline the latest proposal. Do not accept either price or date.",
    criteria:
      "Summary distinguishes withdrawn and current proposals; reply declines latest without acceptance.",
  },
  {
    id: "portuguese-receipt",
    body: "Pode confirmar a reserva para sexta-feira? O sinal de 100 euros ainda nao foi pago.",
    request:
      "Responda em portugues: apenas confirme que recebeu a mensagem. Nao confirme a reserva nem prometa pagar.",
    criteria:
      "Portuguese receipt acknowledgement; no reservation confirmation or payment promise.",
  },
  {
    id: "sender-versus-user",
    body: "I will send you my draft on Thursday. Could you review it after that?",
    request:
      "Say I can review it on Saturday. Do not say I am sending the draft.",
    criteria:
      "Summary attributes Thursday sending to sender; reply commits user only to Saturday review.",
  },
  {
    id: "no-thanks-request",
    body: "Your support case remains open. We are waiting for the serial number.",
    request:
      "Reply with exactly: The serial number is TEST-482. Do not add a greeting, thanks, promise, or signature.",
    criteria:
      "Reply exactly The serial number is TEST-482.; summary does not attribute supplied serial to sender.",
  },
];
const experimental = process.env.MAIL_INTENT_PROMPT_VARIANT === "candidate";
const baselineInstructions =
  "Reply is an object with text (a short acknowledgement addressed directly to the sender, not a third-person summary of the message) and evidence (an array of exact supplied section IDs). You are drafting for the recipient, replying to the original sender. Thank the sender for their request. Do not ask the sender to carry out their own request. Write the reply as a message to the sender. Do not repeat the sender address, subject, date or summary. Acknowledge the request without promising actions, dates or spending not authorized by the user. ";
const candidateInstructions =
  "Reply is an object with text (the concise reply requested by the user) and evidence (a nonempty array of exact section IDs for the message being answered). Follow the user's intent, language and exact wording; do not force thanks or acknowledgement. In the reply, I is the user/recipient and you is the sender. Preserve who sends, receives, reviews or approves. Acknowledgement only means receipt, without promised review or follow-up. Include only user-authorized commitments, preserving conditions; add no reasons, dates, alternatives or prerequisites. Keep user-supplied reply details out of the source summary. Reply evidence identifies the source request, not proof that user-supplied details were in the source. ";
const runtime = new Ollama("http://127.0.0.1:11434");
const pinned = await runtime.pin({
  id: "synthetic-mail-intent",
  runtime: "ollama",
  model: "qwen3.5:9b",
  contextTokens: 4096,
  maxOutputTokens: 1000,
  temperature: 0,
});
for (const scenario of cases) {
  const message = {
    id: "b".repeat(64),
    mode: "plain",
    from: "Sam <sam@example.invalid>",
    subject: "Selected request",
    date: "2026-09-22",
    truncatedMetadata: [],
    sourceVersion: "c".repeat(64),
    attachmentsIncluded: false,
    text: scenario.body,
    bodyAvailable: true,
    bodyTruncated: false,
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
  const productionPrompt = mailPrompt(source, scenario.request, "draft");
  if (experimental && !productionPrompt.includes(baselineInstructions))
    throw new Error(
      "Baseline prompt changed; re-review experimental comparison",
    );
  const prompt = experimental
      ? productionPrompt.replace(baselineInstructions, candidateInstructions)
      : productionPrompt,
    began = Date.now();
  let raw = "";
  try {
    raw = await runtime.generate(
      pinned,
      prompt,
      undefined,
      process.env.MAIL_INTENT_FORMAT === "schema"
        ? mailOutputSchema("draft")
        : undefined,
    );
    const result = mailResult(source, raw, "draft");
    console.log(
      JSON.stringify({
        outputFormat:
          process.env.MAIL_INTENT_FORMAT === "schema"
            ? mailOutputSchema("draft")
            : null,
        scenario,
        profile: pinned.profile,
        digest: pinned.digest,
        prompt,
        promptHash: createHash("sha256").update(prompt).digest("hex"),
        elapsedMs: Date.now() - began,
        raw,
        result,
        structure: "valid",
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        outputFormat:
          process.env.MAIL_INTENT_FORMAT === "schema"
            ? mailOutputSchema("draft")
            : null,
        scenario,
        profile: pinned.profile,
        digest: pinned.digest,
        prompt,
        elapsedMs: Date.now() - began,
        raw,
        error: String(error),
        structure: "invalid",
      }),
    );
    process.exitCode = 1;
  }
}
