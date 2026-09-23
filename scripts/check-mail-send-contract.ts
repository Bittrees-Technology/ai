/** Compare the public client DTO with an explicitly pinned private Mail source; do not copy source. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  mailSendCanonical,
  mailSendDigest,
  mailSendEnvelopeSchema,
  mailSendReceiptSchema,
  mailSendVersion,
  matchingMailReceipt,
} from "../modules/connectors/mail-send-contracts.js";
const source = resolve(process.env.MAIL_REPO || ""),
  expected = process.env.MAIL_SOURCE_COMMIT,
  output = process.env.MAIL_CONTRACT_OUTPUT;
assert.ok(
  process.env.MAIL_REPO &&
    expected &&
    /^[a-f0-9]{40}$/.test(expected) &&
    output,
  "MAIL_REPO, MAIL_SOURCE_COMMIT and MAIL_CONTRACT_OUTPUT are required",
);
const git = (...args: string[]) =>
  execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
assert.equal(git("rev-parse", "HEAD"), expected);
assert.equal(git("status", "--porcelain"), "", "Private source must be clean");
const dir = await mkdtemp(join(tmpdir(), "mail-contract-"));
try {
  const { build } = createRequire(join(source, "package.json"))("esbuild");
  await build({
    entryPoints: [join(source, "lib/ai-mail-send-contract.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: join(dir, "source.mjs"),
  });
  const actual = await import(pathToFileURL(join(dir, "source.mjs")).href);
  const base = {
    contractVersion: mailSendVersion,
    operationId: randomUUID(),
    from: "fixture@bittrees.org",
    to: ["one@example.org"],
    cc: ["two@example.org"],
    bcc: ["hidden@example.org"],
    subject: "Exact 🐦 subject",
    text: "Exact text\nwith trailing spaces  ",
    attachments: [
      {
        filename: "fixture.bin",
        contentType: "application/octet-stream",
        content: Buffer.from([0, 1, 255]).toString("base64"),
      },
    ],
    reply: null,
  };
  const valid = [
    base,
    { ...base, to: [], cc: [], bcc: ["only@example.org"] },
    {
      ...base,
      subject: "🐦".repeat(200),
      text: "\t".repeat(23999) + "x",
      reply: {
        folder: "Sent Items",
        id: "a".repeat(64),
        version: "b".repeat(64),
      },
    },
    {
      ...base,
      attachments: [
        {
          filename: "full.bin",
          contentType: "application/octet-stream",
          content: Buffer.alloc(1048576, 7).toString("base64"),
        },
      ],
    },
    {
      ...base,
      attachments: [
        {
          filename: "empty.bin",
          contentType: "application/octet-stream",
          content: "",
        },
      ],
    },
  ];
  for (const v of valid) {
    assert.deepEqual(
      mailSendEnvelopeSchema.parse(v),
      actual.reviewedMail(v, v.from),
    );
    assert.equal(mailSendCanonical(v), actual.reviewedMailCanonical(v, v.from));
    assert.equal(mailSendDigest(v), await actual.reviewedMailDigest(v, v.from));
  }
  const invalid = [
    { ...base, approved: true },
    { ...base, cc: undefined },
    { ...base, to: [], cc: [], bcc: [] },
    { ...base, to: ["Name <x@example.org>"] },
    { ...base, cc: ["ONE@example.org"] },
    { ...base, subject: "\ud800" },
    { ...base, text: "\ufeff" },
    { ...base, text: "x\r\n" },
    {
      ...base,
      reply: { folder: "../x", id: "a".repeat(64), version: "b".repeat(64) },
    },
    {
      ...base,
      attachments: [
        {
          filename: "../x",
          contentType: "application/octet-stream",
          content: "eA==",
        },
      ],
    },
    {
      ...base,
      attachments: [
        { filename: "x", contentType: "text/html", content: "eA==" },
      ],
    },
    {
      ...base,
      attachments: [
        {
          filename: "x",
          contentType: "application/octet-stream",
          content: "eB==",
        },
      ],
    },
    {
      ...base,
      attachments: [
        {
          filename: "x",
          contentType: "application/octet-stream",
          content: Buffer.alloc(1048577).toString("base64"),
        },
      ],
    },
  ];
  for (const v of invalid) {
    assert.equal(mailSendEnvelopeSchema.safeParse(v).success, false);
    assert.throws(() => actual.reviewedMail(v, base.from));
  }
  const receipt = {
    contractVersion: mailSendVersion,
    operationId: base.operationId,
    digest: mailSendDigest(base),
    state: "accepted",
    recordedAt: 1000,
    completedAt: 1001,
    recipientCount: 3,
    accepted: [0, 1, 2],
    refused: [],
    historical: true,
    delivery: "unverified",
    sentCopy: "saved",
  };
  const receipts = [
    receipt,
    {
      ...receipt,
      state: "uncertain",
      completedAt: null,
      accepted: [],
      sentCopy: "not_attempted",
    },
    {
      ...receipt,
      state: "partially_accepted",
      accepted: [0, 2],
      refused: [1],
      sentCopy: "unverified",
    },
    {
      ...receipt,
      state: "rejected",
      accepted: [],
      refused: [0, 1, 2],
      sentCopy: "not_attempted",
    },
  ];
  for (const r of receipts) {
    const parsed = mailSendReceiptSchema.parse(r);
    assert.ok(matchingMailReceipt(mailSendEnvelopeSchema.parse(base), parsed));
    assert.deepEqual(
      parsed,
      await actual.reviewedMailReceipt(r, base, base.from),
    );
  }
  for (const delta of [
    { delivery: "delivered" },
    { accepted: [0, 1, 1] },
    { completedAt: 999 },
    { sentCopy: "not_attempted" },
    { extra: true },
  ]) {
    const r = { ...receipt, ...delta };
    assert.equal(mailSendReceiptSchema.safeParse(r).success, false);
    await assert.rejects(actual.reviewedMailReceipt(r, base, base.from));
  }
  for (const delta of [
    { digest: "f".repeat(64) },
    { operationId: randomUUID() },
    { recipientCount: 4, accepted: [0, 1, 2, 3] },
  ]) {
    const r = mailSendReceiptSchema.parse({ ...receipt, ...delta });
    assert.equal(
      matchingMailReceipt(mailSendEnvelopeSchema.parse(base), r),
      false,
    );
    await assert.rejects(actual.reviewedMailReceipt(r, base, base.from));
  }
  const sha = (bytes: Buffer) =>
    createHash("sha256").update(bytes).digest("hex");
  await writeFile(
    output,
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        runtime: process.version,
        privateSourceCommit: expected,
        sourceContractSha256: sha(
          await readFile(join(source, "lib/ai-mail-send-contract.ts")),
        ),
        clientContractSha256: sha(
          await readFile(
            new URL(
              "../modules/connectors/mail-send-contracts.ts",
              import.meta.url,
            ),
          ),
        ),
        validEnvelopes: valid.length,
        rejectedEnvelopes: invalid.length,
        validReceipts: receipts.length,
        rejectedReceipts: 8,
        checks: [
          "Actual clean private source and independent public client agree on exact parsing, canonical bytes and digests.",
          "All recipient groups, Bcc-only, Unicode, reply version, empty and full one-MiB attachments preserved.",
          "Invalid fields/normalization/attachment limits and mismatched receipts rejected by both.",
        ],
        limits: [
          "Contract interoperability only. Combined source HTTP/queue/SMTP and companion review UI acceptance remain open.",
          "Private source was bundled only in a disposable directory and not copied into the public repository.",
          "No source deployment, actual mail, personal data, Keychain, installed app, model or Acer change.",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Actual private Mail/client contracts match: 5 valid and 13 rejected envelopes; 4 valid and 8 rejected receipts.",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
