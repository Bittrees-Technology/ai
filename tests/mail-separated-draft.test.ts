import test from "node:test";
import assert from "node:assert/strict";
import {
  separatedMailDraft,
  mailResult,
} from "../modules/connectors/mail-drafts.js";
import type { MailTasks } from "../modules/connectors/mail-tasks.js";
type Snapshot = Awaited<ReturnType<MailTasks["validate"]>>;
const source: Snapshot = {
  grantId: "a".repeat(64),
  mailbox: "alex@example.invalid",
  wallet: "0x" + "1".repeat(40),
  folder: "INBOX",
  scopes: ["metadata", "plain"],
  expiresAt: "2099-01-01T00:00:00Z",
  policyRevision: "mail-ai-selected-v1",
  message: {
    id: "m",
    sourceVersion: "v",
    mode: "plain",
    from: "Sam",
    subject: "Review",
    date: "2026-09-22",
    truncatedMetadata: [],
    bodyAvailable: true,
    attachmentsIncluded: false,
    bodyTruncated: false,
    text: "I will send my draft Thursday. Could you review it?",
  },
  projectionHash: "synthetic",
};
const summary = JSON.stringify({
  summary: [
    { text: "Sender will send a draft Thursday.", evidence: ["body-1"] },
  ],
  reply: null,
});
const reply = JSON.stringify({
  text: "I can review it Saturday.",
  evidence: ["body-1"],
});
test("separate Mail generation isolates user instructions from summary and validates the combined result", async () => {
  const prompts: string[] = [];
  let validations = 0;
  const raw = await separatedMailDraft(
    source,
    "USER_ONLY_SENTINEL: review Saturday",
    async (prompt, format) => {
      prompts.push(prompt);
      assert.equal(format.type, "object");
      return prompts.length === 1 ? summary : reply;
    },
    async () => {
      validations++;
    },
  );
  assert.equal(prompts.length, 2);
  assert.equal(validations, 3);
  assert.ok(!prompts[0]!.includes("USER_ONLY_SENTINEL"));
  assert.ok(prompts[1]!.includes("USER_ONLY_SENTINEL"));
  const result = mailResult(source, raw, "draft");
  assert.equal(result.mail.reply?.text, "I can review it Saturday.");
  assert.equal(result.mail.sent, false);
  assert.equal(result.mail.savedToMail, false);
});
test("Mail revocation, cancellation and invalid stage output prevent completion without retries", async () => {
  for (const failAt of [1, 2, 3]) {
    let validations = 0,
      generations = 0;
    await assert.rejects(
      separatedMailDraft(
        source,
        "Review Saturday",
        async () => (++generations === 1 ? summary : reply),
        async () => {
          if (++validations === failAt) throw Error("SOURCE_DENIED");
        },
      ),
      /SOURCE_DENIED/,
    );
    assert.equal(generations, failAt - 1);
  }
  let generations = 0;
  await assert.rejects(
    separatedMailDraft(
      source,
      "Review",
      async () => {
        generations++;
        return "invalid";
      },
      async () => {},
    ),
    /INVALID_OUTPUT/,
  );
  assert.equal(generations, 1);
  generations = 0;
  await assert.rejects(
    separatedMailDraft(
      source,
      "Review",
      async () =>
        ++generations === 1
          ? summary
          : JSON.stringify({ text: "x", evidence: ["invented-section"] }),
      async () => {},
    ),
    /INVALID_OUTPUT/,
  );
  assert.equal(generations, 2);
  const abort = new AbortController();
  generations = 0;
  await assert.rejects(
    separatedMailDraft(
      source,
      "Review",
      async () => {
        generations++;
        abort.abort();
        return summary;
      },
      async () => {},
      abort.signal,
    ),
  );
  assert.equal(generations, 1);
});
