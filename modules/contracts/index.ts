import { z } from "zod";

export const contractVersion = "1.0.0";
export const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9:_-]+$/);
export const timestamp = z.iso.datetime();
export const taskStatus = z.enum([
  "queued",
  "running",
  "awaiting_input",
  "awaiting_approval",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);
export const sourceApp = z.enum([
  "local",
  "crm",
  "autonote",
  "roles",
  "mail",
  "news",
  "mcp",
]);
export const authoritySchema = z.strictObject({
  userId: id,
  subjectId: id,
  tenantId: id,
  deviceId: id,
  agentId: id.optional(),
  sourceApp,
  grantId: id,
  policyRevision: id,
});
export const sourceRefSchema = z.strictObject({
  app: sourceApp,
  tenantId: id,
  resourceId: id,
  revision: id,
});
export const sourceBindingSchema = z
  .strictObject({
    authority: authoritySchema,
    refs: z.array(sourceRefSchema).min(1).max(100),
    expiresAt: timestamp,
    projectionHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine(
    (b) =>
      ["crm", "autonote", "mail"].includes(b.authority.sourceApp) &&
      (!["autonote", "mail"].includes(b.authority.sourceApp) ||
        b.refs.length === 1) &&
      b.refs.every(
        (r) =>
          r.app === b.authority.sourceApp &&
          r.tenantId === b.authority.tenantId,
      ) &&
      new Set(b.refs.map((r) => r.resourceId)).size === b.refs.length,
  );
export type SourceBinding = z.infer<typeof sourceBindingSchema>;
export const requestSchema = z.strictObject({
  conversationId: id,
  kind: z.enum(["query", "summarize", "draft"]),
  prompt: z.string().min(1).max(32_000),
  modelProfileId: id,
  memoryIds: z
    .array(id)
    .max(8)
    .refine((ids) => new Set(ids).size === ids.length)
    .optional(),
  sourceRefs: z.array(sourceRefSchema).max(100).default([]),
  dependencies: z.array(id).max(32).default([]),
  priority: z.enum(["normal", "high"]).default("normal"),
  deadline: timestamp.optional(),
  tags: z.array(z.string().min(1).max(40)).max(16).default([]),
});
// Authority is constructed by authentication/source adapters, never accepted in a request body.
export const inboxMessageSchema = z.strictObject({
  conversationId: id,
  recipientInboxId: id,
  requestId: id.optional(),
  type: z.enum(["query", "reply", "clarification", "notification"]),
  content: z.string().min(1).max(32_000),
  replyToId: id.optional(),
  replyExpected: z.boolean().default(false),
  replyDueAt: timestamp.optional(),
});
export const inboxSchema = z.strictObject({
  id,
  tenantId: id,
  ownerId: id,
  ownerType: z.enum(["user", "agent", "manager"]),
  teamId: id.optional(),
  memberUserIds: z.array(id).min(1).max(100),
});
export const commandSchema = z.strictObject({
  command: z.enum(["pause", "resume", "cancel"]),
  expectedRevision: z.number().int().positive(),
});
export const connectorManifestSchema = z.strictObject({
  contractVersion: z.literal(contractVersion),
  app: sourceApp,
  origin: z.url(),
  actions: z
    .array(z.enum(["read", "draft", "publish", "send", "explain_access"]))
    .max(6),
  authentication: z.enum(["authorization_code_pkce", "expiring_key"]),
});
// Explicit projection: private free text is never a remote-status field.
export const remoteStatusSchema = z.strictObject({
  id,
  deviceId: id,
  status: taskStatus,
  revision: z.number().int().positive(),
  updatedAt: timestamp,
  errorCode: z
    .enum([
      "MODEL_UNAVAILABLE",
      "AUTHORITY_EXPIRED",
      "CONFLICT",
      "CAPACITY",
      "INTERNAL",
    ])
    .optional(),
});
export const errorSchema = z.strictObject({
  error: z.enum([
    "INVALID_INPUT",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "STALE_CLAIM",
    "EXPIRED",
    "CAPACITY",
    "INTERNAL",
    "MODEL_UNAVAILABLE",
    "MODEL_CHANGED",
    "REMOTE_MODEL_DENIED",
    "INVALID_OUTPUT",
    "CONNECTION_REQUIRED",
    "CONNECTION_EXPIRED",
    "CONNECTION_BUSY",
    "INVALID_CONNECTION",
    "SOURCE_UNAVAILABLE",
    "SOURCE_DENIED",
    "SOURCE_CONFLICT",
    "SOURCE_CAPACITY",
    "INVALID_SOURCE",
    "IMPORT_BUSY",
    "UNSUPPORTED_FILE",
    "INVALID_ARTIFACT",
    "CHANGED_ARTIFACT",
    "REVIEW_EXPIRED",
    "REVIEW_MISMATCH",
    "RUNTIME_REJECTED",
    "UNSUPPORTED_ARCHITECTURE",
    "DOWNLOAD_DENIED",
  ]),
  correlationId: id,
});
export const modelProfileSchema = z.strictObject({
  id,
  runtime: z.enum(["ollama", "lmstudio"]),
  model: z.string().min(1).max(200),
  contextTokens: z.number().int().min(256).max(131072),
  maxOutputTokens: z.number().int().min(1).max(8192),
  temperature: z.number().min(0).max(2),
});
export const schemas = {
  authority: authoritySchema,
  sourceBinding: sourceBindingSchema,
  request: requestSchema,
  sourceRef: sourceRefSchema,
  inbox: inboxSchema,
  message: inboxMessageSchema,
  command: commandSchema,
  connectorManifest: connectorManifestSchema,
  remoteStatus: remoteStatusSchema,
  error: errorSchema,
  modelProfile: modelProfileSchema,
};
export type Authority = z.infer<typeof authoritySchema>;
export type TaskInput = z.infer<typeof requestSchema>;
export type TaskStatus = z.infer<typeof taskStatus>;
