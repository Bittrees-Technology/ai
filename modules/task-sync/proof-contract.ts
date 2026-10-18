import { createHash, randomUUID, sign } from "node:crypto";
import { z } from "zod";
import { canonical } from "../workflows/central-worker.js";
export const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const hex = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z.uuid();
export const taskContent = z.object({
  sourceId: z.string().min(1).max(200),
  projectId: z.string().min(1).max(128),
  title: z.string().min(1).max(200),
  description: z.string().max(3500),
  status: z.enum(["todo", "in-progress", "blocked", "done"]),
  priority: z.enum(["P0", "P1", "P2"]),
  area: z.string().max(200),
  acceptanceCriteria: z.array(z.string().max(3500)).max(40),
  progressNote: z.string().max(3500),
  sourceUrl: z.string().url(),
});
export type SyncTask = {
  content: z.infer<typeof taskContent>;
  fingerprint: string;
  destination: { projectId: string; workspaceId: string };
};
export type SyncIdentity = {
  principal: string;
  credentialId: string;
  tenant: string;
  workspace: string;
  sourceWorkspace: string;
  subject: string;
  leaseId: string;
  runtimeBindingDigest: string;
  activatedAt: number;
  expiresAt: number;
};
const requestSchema = z.strictObject({
  version: z.literal(1),
  source: z.literal("mcp.bittrees.org"),
  audience: z.literal("https://roles.bittrees.org/api/authority/mcp-decision"),
  requestId: uuid,
  operationId: uuid,
  parametersDigest: hex,
  issuedAt: z.int(),
  principal: z.string().regex(/^(agent|service):[a-f0-9-]{36}$/),
  credentialId: hex,
  delegationId: z.null(),
  leaseId: uuid,
  runtimeBindingDigest: hex,
  tenant: z.string(),
  workspace: z.string(),
  project: z.literal("crm"),
  resource: z.string(),
  action: z.enum(["task:read", "task:import"]),
  stage: z.literal("execute"),
});
const importArgs = z.strictObject({
  projectId: uuid,
  operationId: uuid,
  source: z.literal("https://agent.bittrees.org"),
  sourceId: z.string(),
  contentHash: hex,
  title: z.string().max(200),
  description: z.string().max(3500),
  sourceUrl: z.string().url(),
  sourceStatus: taskContent.shape.status,
  sourcePriority: taskContent.shape.priority,
  expectedVersion: z.int().positive().optional(),
});
const parameterSchema = z.discriminatedUnion("tool", [
  z.strictObject({
    tool: z.literal("projects.list"),
    arguments: z.strictObject({}),
  }),
  z.strictObject({
    tool: z.literal("tasks.import_source_status"),
    arguments: z.strictObject({
      projectId: uuid,
      source: z.literal("https://agent.bittrees.org"),
      sourceId: z.string(),
    }),
  }),
  z.strictObject({
    tool: z.literal("tasks.import_source"),
    arguments: importArgs,
  }),
]);
export function activeLease(identity: SyncIdentity, now = Date.now()) {
  if (
    !Number.isFinite(identity.activatedAt) ||
    !Number.isFinite(identity.expiresAt) ||
    identity.activatedAt > now ||
    identity.expiresAt <= now ||
    identity.expiresAt - identity.activatedAt > 3600000
  )
    throw Error("Task-sync lease is inactive or exceeds one hour");
}
export function importOperation(identity: SyncIdentity, task: SyncTask) {
  const h = digest([
    identity.tenant,
    identity.subject,
    task.content.sourceId,
    task.destination,
    task.fingerprint,
  ]);
  return (
    h.slice(0, 8) +
    "-" +
    h.slice(8, 12) +
    "-5" +
    h.slice(13, 16) +
    "-a" +
    h.slice(17, 20) +
    "-" +
    h.slice(20, 32)
  );
}
/** Validate a gateway challenge against independently fetched, owner-reviewed content. Never sign its claims blindly. */
export function validateChallenge(
  raw: unknown,
  identity: SyncIdentity,
  task: SyncTask,
  pinnedImport?: unknown,
  now = Date.now(),
) {
  activeLease(identity, now);
  const v = z
      .strictObject({
        type: z.literal("roles-proof-required"),
        request: requestSchema,
        parameters: parameterSchema,
      })
      .parse(raw),
    r = v.request,
    p = v.parameters;
  for (const k of [
    "principal",
    "credentialId",
    "tenant",
    "workspace",
    "leaseId",
    "runtimeBindingDigest",
  ] as const)
    if (r[k] !== identity[k])
      throw Error("Challenge identity does not match approved device");
  if (Math.abs(now - r.issuedAt) > 15000 || r.parametersDigest !== digest(p))
    throw Error("Stale or mismatched challenge");
  if (
    digest(task.content) !== task.fingerprint ||
    task.destination.workspaceId !== identity.sourceWorkspace
  )
    throw Error("Reviewed content or workspace changed");
  const project = task.destination.projectId;
  if (p.tool === "projects.list") {
    if (r.resource !== "workspace:projects" || r.action !== "task:read")
      throw Error("Unexpected project-list scope");
  } else {
    if (
      p.arguments.projectId !== project ||
      p.arguments.sourceId !== task.content.sourceId ||
      r.resource !== "project:" + project
    )
      throw Error("Unexpected task destination");
    if (p.tool === "tasks.import_source_status") {
      if (r.action !== "task:read") throw Error("Unexpected read scope");
    } else {
      const a = p.arguments,
        c = task.content;
      if (
        r.action !== "task:import" ||
        r.operationId !== importOperation(identity, task) ||
        a.operationId !== r.operationId ||
        a.contentHash !== task.fingerprint ||
        a.title !== c.title ||
        a.description !== c.description ||
        a.sourceUrl !== c.sourceUrl ||
        a.sourceStatus !== c.status ||
        a.sourcePriority !== c.priority
      )
        throw Error("Import differs from reviewed source");
      if (pinnedImport && canonical(pinnedImport) !== canonical(p))
        throw Error("Pending import payload changed; review required");
    }
  }
  return v;
}
export function signChallenges(
  challenges: ReturnType<typeof validateChallenge>[],
  privateKey: string,
  identity: SyncIdentity,
  now = Date.now(),
) {
  activeLease(identity, now);
  if (challenges.length > 3)
    throw Error("Too many workflow signature challenges");
  const proofs = challenges.map((c) => {
    const request = { ...c.request, requestId: randomUUID(), issuedAt: now };
    return {
      request,
      signature: sign(
        null,
        Buffer.from("Bittrees MCP authority request v1\n" + canonical(request)),
        privateKey,
      ).toString("base64"),
    };
  });
  const encoded = Buffer.from(JSON.stringify({ proofs })).toString("base64url");
  if (encoded.length > 16384) throw Error("Signature bundle exceeds limit");
  return encoded;
}
