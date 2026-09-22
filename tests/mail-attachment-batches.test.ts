import test from "node:test";
import assert from "node:assert/strict";
import {
  attachmentPlan,
  fitsLocalPrompt,
  summarizeAttachmentParts,
} from "../modules/connectors/mail-attachment-batches.js";
const model = {
  profile: {
    id: "p",
    runtime: "ollama" as const,
    model: "synthetic",
    contextTokens: 4096,
    maxOutputTokens: 1000,
    temperature: 0,
  },
  digest: "a".repeat(64),
};
function source(text: string): any {
  return {
    grantId: "a".repeat(64),
    mailbox: "fixture@bittrees.org",
    wallet: "0x" + "1".repeat(40),
    folder: "INBOX",
    scopes: ["metadata", "attachment"],
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    policyRevision: "mail-ai-selected-v2",
    projectionHash: "c".repeat(64),
    message: {
      id: "b".repeat(64),
      mode: "attachment-text",
      from: "sender",
      subject: "subject",
      date: "date",
      truncatedMetadata: [],
      sourceVersion: "d".repeat(64),
      attachmentsIncluded: true,
      attachment: {
        id: "1.2",
        filename: "notes.txt",
        contentType: "text/plain",
        supported: true,
        encodedBytes: Buffer.byteLength(text),
        text,
        bytes: Buffer.byteLength(text),
        truncated: false,
      },
    },
  };
}
const answer = (id: string) =>
  JSON.stringify({
    summary: [{ text: "Part summary", evidence: [id] }],
    reply: null,
  });
test("Attachment planning preserves full 32 KiB and Unicode/escaped data within actual runtime bounds", () => {
  for (const text of ["x".repeat(32768), '😀漢\n"\\'.repeat(2500)]) {
    const plan = attachmentPlan(source(text), "Summarize", model)!;
    assert.ok(plan.length > 1);
    assert.equal(plan.map((p) => p.section.text).join(""), text);
    assert.equal(new Set(plan.map((p) => p.section.id)).size, plan.length);
    for (const part of plan)
      assert.equal(fitsLocalPrompt(model, part.prompt), true);
  }
  assert.equal(attachmentPlan(source("Small file"), "Summarize", model), null);
  assert.throws(
    () => attachmentPlan(source("x".repeat(10000)), "x".repeat(32000), model),
    /CAPACITY/,
  );
});
test("Part summaries cite only their own source range and expose complete coverage without claiming synthesis", async () => {
  const s = source("x".repeat(9000)),
    plan = attachmentPlan(s, "Summarize", model)!;
  let call = 0,
    checks = 0;
  const result = await summarizeAttachmentParts(
    s,
    "Summarize",
    model,
    async (prompt) => {
      assert.equal(prompt, plan[call]!.prompt);
      return answer(plan[call++]!.section.id);
    },
    async () => {
      checks++;
    },
    new AbortController().signal,
  );
  assert.equal(call, plan.length);
  assert.equal(checks, plan.length + 1);
  assert.equal(result.mail.summary.length, plan.length);
  assert.equal(result.mail.coverage.allPartsProcessed, true);
  assert.equal(result.mail.coverage.crossPartSynthesis, false);
  assert.equal(result.mail.summary.at(-1)!.citations[0]!.attachmentId, "1.2");
  assert.match(result.text, /Cross-part/);
  await assert.rejects(
    summarizeAttachmentParts(
      s,
      "Summarize",
      model,
      async () => answer("attachment-offset-999999"),
      async () => {},
      new AbortController().signal,
    ),
    /INVALID_OUTPUT/,
  );
});
test("Revocation or cancellation between parts stops inference and never returns partial output", async () => {
  for (const mode of ["revoked", "cancelled"]) {
    let calls = 0,
      checks = 0;
    const abort = new AbortController();
    await assert.rejects(
      summarizeAttachmentParts(
        source("x".repeat(10000)),
        "Summarize",
        model,
        async (prompt) => {
          calls++;
          const section = JSON.parse(
            prompt.split("File data:\n")[1]!.split("\nUser request:")[0]!,
          ).section;
          if (mode === "cancelled") abort.abort();
          return answer(section.id);
        },
        async () => {
          if (++checks === 2) throw Error("revoked");
        },
        abort.signal,
      ),
    );
    assert.equal(calls, 1);
  }
});

test("Attachment parts prefer complete records while preserving exact bytes", () => {
  const text = Array.from(
    { length: 40 },
    (_, i) =>
      `Record ${i}: Estimated cost EUR 500. Approval is pending and no payment is authorized.\n`,
  ).join("");
  const plan = attachmentPlan(source(text), "Summarize", model)!;
  assert.ok(plan.length > 1);
  assert.equal(plan.map((p) => p.section.text).join(""), text);
  for (const p of plan.slice(0, -1)) {
    assert.match(p.section.text, /\n$/);
    assert.ok(fitsLocalPrompt(model, p.prompt));
  }
});
