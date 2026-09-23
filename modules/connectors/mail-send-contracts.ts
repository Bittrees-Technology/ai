import { createHash } from "node:crypto";
import { z } from "zod";
export const mailSendVersion = "mail-ai-send-v1" as const;
export const mailSendOrigin = "https://mail.bittrees.org";
export const mailSendAudience = "https://ai.bittrees.org";
export const mailSendId = z
  .string()
  .regex(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
export const mailSendDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const scalar = (v: string) =>
  !Array.from(v).some((c) => c.length === 1 && /[\ud800-\udfff]/.test(c));
export const mailSendAddress = z
  .string()
  .max(254)
  .refine((v) => {
    if (!/^[\x21-\x7e]+$/.test(v)) return false;
    const p = v.split("@");
    if (p.length !== 2) return false;
    const [local, domain] = p as [string, string];
    return (
      local.length <= 64 &&
      /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(
        local,
      ) &&
      domain.length <= 253 &&
      domain.includes(".") &&
      domain
        .split(".")
        .every((x) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(x))
    );
  });
export const mailSendIdentitySchema = z.strictObject({
  wallet: z.string().regex(/^0x[a-f0-9]{40}$/),
  mailbox: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}@bittrees\.org$/),
});
const attachment = z.strictObject({
  filename: z
    .string()
    .min(1)
    .max(120)
    .refine(
      (v) =>
        scalar(v) &&
        v === v.trim() &&
        v !== "." &&
        v !== ".." &&
        Buffer.byteLength(v) <= 240 &&
        !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069/\\]/.test(v),
    ),
  contentType: z.literal("application/octet-stream"),
  content: z
    .string()
    .max(1398104)
    .refine(
      (v) =>
        v.length % 4 === 0 &&
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          v,
        ) &&
        Buffer.from(v, "base64").toString("base64") === v,
    ),
});
const fields = {
  from: mailSendAddress,
  to: z.array(mailSendAddress).max(20),
  cc: z.array(mailSendAddress).max(20),
  bcc: z.array(mailSendAddress).max(20),
  subject: z
    .string()
    .refine(
      (v) =>
        scalar(v) &&
        Array.from(v).length <= 200 &&
        !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(v),
    ),
  text: z
    .string()
    .refine(
      (v) =>
        scalar(v) &&
        !!v.trim() &&
        Buffer.byteLength(v) <= 24000 &&
        !/[\x00-\x08\x0b-\x1f\x7f]/.test(v),
    ),
  attachments: z.array(attachment).max(4),
  reply: z
    .strictObject({
      folder: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/)
        .refine((v) => v === v.trim()),
      id: mailSendDigestSchema,
      version: mailSendDigestSchema,
    })
    .nullable(),
};
function validMessage(m: {
  to: string[];
  cc: string[];
  bcc: string[];
  attachments: { content: string }[];
}) {
  const recipients = [...m.to, ...m.cc, ...m.bcc];
  return (
    recipients.length > 0 &&
    recipients.length <= 20 &&
    new Set(recipients.map((v) => v.toLowerCase())).size ===
      recipients.length &&
    m.attachments.reduce(
      (n, f) => n + Buffer.from(f.content, "base64").length,
      0,
    ) <= 1048576
  );
}
export const mailSendDraftSchema = z.strictObject(fields).refine(validMessage);
export const mailSendEnvelopeSchema = z
  .strictObject({
    contractVersion: z.literal(mailSendVersion),
    operationId: mailSendId,
    ...fields,
  })
  .refine(validMessage);
export type MailSendEnvelope = z.infer<typeof mailSendEnvelopeSchema>;
export function mailSendCanonical(raw: unknown) {
  const m = mailSendEnvelopeSchema.parse(raw);
  return JSON.stringify([
    m.contractVersion,
    m.operationId,
    m.from,
    m.to,
    m.cc,
    m.bcc,
    m.subject,
    m.text,
    m.attachments.map((f) => [f.filename, f.contentType, f.content]),
    m.reply === null ? null : [m.reply.folder, m.reply.id, m.reply.version],
  ]);
}
export const mailSendDigest = (raw: unknown) =>
  createHash("sha256").update(mailSendCanonical(raw)).digest("hex");
const time = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const mailSendReceiptSchema = z
  .strictObject({
    contractVersion: z.literal(mailSendVersion),
    operationId: mailSendId,
    digest: mailSendDigestSchema,
    state: z.enum(["uncertain", "accepted", "partially_accepted", "rejected"]),
    recordedAt: time,
    completedAt: time.nullable(),
    recipientCount: z.number().int().min(1).max(20),
    accepted: z.array(z.number().int().min(0).max(19)).max(20),
    refused: z.array(z.number().int().min(0).max(19)).max(20),
    historical: z.literal(true),
    delivery: z.literal("unverified"),
    sentCopy: z.enum(["not_attempted", "unverified", "saved", "unavailable"]),
  })
  .refine((r) => {
    const a = r.accepted,
      b = r.refused;
    if (r.completedAt !== null && r.completedAt < r.recordedAt) return false;
    if (
      [a, b].some((v) =>
        v.some((n, i) => n >= r.recipientCount || (i > 0 && v[i - 1]! >= n)),
      ) ||
      a.some((n) => b.includes(n))
    )
      return false;
    if (r.state === "uncertain" && (a.length || b.length)) return false;
    if (
      r.state !== "uncertain" &&
      (r.completedAt === null || a.length + b.length !== r.recipientCount)
    )
      return false;
    if (
      (r.state === "accepted" && (b.length || a.length !== r.recipientCount)) ||
      (r.state === "partially_accepted" && (!a.length || !b.length)) ||
      (r.state === "rejected" && (a.length || b.length !== r.recipientCount))
    )
      return false;
    return (
      a.length ? ["unverified", "saved", "unavailable"] : ["not_attempted"]
    ).includes(r.sentCopy);
  });
export type MailSendReceipt = z.infer<typeof mailSendReceiptSchema>;
export function matchingMailReceipt(m: MailSendEnvelope, r: MailSendReceipt) {
  return (
    r.operationId === m.operationId &&
    r.digest === mailSendDigest(m) &&
    r.recipientCount === m.to.length + m.cc.length + m.bcc.length
  );
}
export const mailSendGrantSchema = z.strictObject({
  token: mailSendDigestSchema,
  grantId: mailSendDigestSchema,
  ...mailSendIdentitySchema.shape,
  audience: z.literal(mailSendAudience),
  operationId: mailSendId,
  digest: mailSendDigestSchema,
  recipientCount: z.number().int().min(1).max(20),
  expiresAt: z.iso.datetime(),
  previouslySubmitted: z.boolean(),
});
export const mailSendObservationSchema = z
  .strictObject({
    operationId: mailSendId,
    digest: mailSendDigestSchema,
    sourceSubmission: z.enum(["not_submitted", "reserved"]),
    receipt: mailSendReceiptSchema.nullable(),
  })
  .refine((v) => v.receipt === null || v.sourceSubmission === "reserved");
