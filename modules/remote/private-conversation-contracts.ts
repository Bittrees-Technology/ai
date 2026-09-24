import { z } from "zod";
import { privateEnvelopeLimit } from "./private-envelope.js";
const uuid = z.uuid().regex(/^[a-f0-9-]+$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** Directions are absolute, avoiding inversion between the Mac and browser UI.
 * These choices are separate from pairing, relay, tasks and source permissions. */
export const conversationPermissionsSchema = z
  .strictObject({
    messagesToMac: z.boolean(),
    messagesToBrowser: z.boolean(),
    questionsToBrowser: z.boolean(),
    answersToMac: z.boolean(),
  })
  .refine(
    (p) =>
      (p.messagesToMac || p.messagesToBrowser || p.questionsToBrowser) &&
      (!p.answersToMac || p.questionsToBrowser),
  );
/** Opaque thread reference and current Mac-issued permission identity.
 * Neither value is an authority token or a local Inbox/conversation selector. */
export const conversationScopeSchema = z.strictObject({
  conversationRef: uuid,
  permissionId: uuid,
});
const text = z
  .string()
  .min(1)
  .max(32000)
  .refine((value) => value.trim().length > 0);
const message = z
  .strictObject({
    version: z.literal(1),
    type: z.literal("conversation.message"),
    scope: conversationScopeSchema,
    id: uuid,
    parentId: uuid.nullable(),
    content: text,
  })
  .refine((m) => m.parentId !== m.id);
const question = z.strictObject({
  version: z.literal(1),
  type: z.literal("conversation.question"),
  scope: conversationScopeSchema,
  id: uuid,
  taskId: uuid,
  taskRevision: positive,
  content: text,
  deadline: positive,
});
const answer = z
  .strictObject({
    version: z.literal(1),
    type: z.literal("conversation.answer"),
    scope: conversationScopeSchema,
    id: uuid,
    taskId: uuid,
    questionId: uuid,
    expectedRevision: positive,
    content: text,
    confirmed: z.literal(true),
  })
  .refine((m) => m.id !== m.questionId);
/** This parser validates framing only. Receivers must authenticate the envelope,
 * both identities, current separate consent, exact parent/task and source access
 * before atomically consuming replay state and appending to the existing Inbox. */
export const conversationContentSchema = z
  .union([message, question, answer])
  .refine(
    (v) =>
      new TextEncoder().encode(JSON.stringify(v)).length <=
      privateEnvelopeLimit,
  );
export type ConversationContent = z.infer<typeof conversationContentSchema>;
/** Offers carry no task text, source labels or local IDs. Explicitly opening an
 * authenticated offer does not grant access; each endpoint reviews its own choice. */
export const conversationOfferSchema = z
  .strictObject({
    version: z.literal(1),
    type: z.literal("conversation.offer"),
    scope: conversationScopeSchema,
    permissions: conversationPermissionsSchema,
    issuedAt: positive,
    expiresAt: positive,
  })
  .refine(
    (o) => o.expiresAt > o.issuedAt && o.expiresAt - o.issuedAt <= 86400000,
  );
/** This acknowledges Inbox acceptance only, never execution or reading. */
export const conversationReceiptSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("conversation.received"),
  scope: conversationScopeSchema,
  acceptedId: uuid,
  acceptedType: z.enum([
    "conversation.message",
    "conversation.question",
    "conversation.answer",
  ]),
  operationId: uuid,
  acceptedAt: positive,
});
