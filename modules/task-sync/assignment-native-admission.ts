import { z } from "zod";
import type { AssignmentBinding } from "./assignment-runner.js";
import type { assignmentServiceReview } from "./assignment-service-native.js";
import { digest } from "./proof-contract.js";
import { exactOutcomeCriteria } from "./assignment-exact-validator.js";
/** Exact native admission metadata only. The fixed gateway and real Roles/source
 * handlers independently authorize each protected read or effect. */
export function checkAssignmentNativeAction(
  review: z.infer<typeof assignmentServiceReview>,
  criteria: z.infer<typeof exactOutcomeCriteria>,
  b: AssignmentBinding,
  now = Date.now(),
) {
  if (!review.assignments.some((a) => digest(a) === digest(b.assignment)))
    throw Error("Assignment outside approved scope");
  const reconcile = [
    "read-completion",
    "finalize",
    "read-finalization",
  ].includes(b.action);
  if (
    b.action !== "claim" &&
    (!b.claim ||
      b.claim.assignmentDigest !== digest(b.assignment) ||
      (!reconcile && b.claim.expiresAt <= now))
  )
    throw Error("Current exact assignment claim required");
  if (
    ["finalize", "read-finalization"].includes(b.action) &&
    review.completeTask !== true
  )
    throw Error("Separate source status approval required");
  if (b.action === "infer" || b.action === "validate") {
    if (
      b.request ||
      !criteria.some(
        (c) =>
          c.assignmentDigest === digest(b.assignment) &&
          c.inputDigest === b.inputDigest,
      )
    )
      throw Error("Exact approved source input required");
    return;
  }
  const r = b.request;
  if (!r) throw Error("Exact typed assignment request required");
  const url = new URL(r.url);
  if (
    url.href !== r.url ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error("Canonical assignment request required");
  if (
    ["finalize", "read-finalization"].includes(b.action) &&
    r.url === "https://mcp.bittrees.org/v1/crm-assignments"
  ) {
    if (r.method !== "POST" || !z.uuid().safeParse(r.operationId).success)
      throw Error("Exact finalization wire required");
    return;
  }
  if (b.action === "claim") {
    if (
      r.url !==
        "https://workflow.bittrees.org/api/task-assignments/" +
          b.assignment.assignmentId +
          "/claim" ||
      r.method !== "POST" ||
      !z.uuid().safeParse(r.operationId).success ||
      r.bodyDigest !== digest({ assignment: b.assignment })
    )
      throw Error("Exact assignment claim request required");
    return;
  }
  const task =
    "https://crm.bittrees.org/api/automation/tasks/" + b.assignment.taskId;
  if (b.action === "read") {
    if (
      r.url !== task ||
      r.method !== "GET" ||
      r.operationId !== null ||
      r.bodyDigest !== digest(null)
    )
      throw Error("Exact source task read required");
    return;
  }
  const id = url.pathname.split("/").at(-1);
  if (!z.uuid().safeParse(id).success)
    throw Error("Original operation required");
  if (
    (b.action === "write" || b.action === "read-receipt") &&
    id !== b.crmOperationId
  )
    throw Error("Original CRM result operation changed");
  const mutating = ["write", "complete", "finalize"].includes(b.action);
  const target =
    b.action === "write" || b.action === "read-receipt"
      ? task + "/results/" + id
      : b.action === "finalize" || b.action === "read-finalization"
        ? task + "/finalizations/" + id
        : "https://workflow.bittrees.org/api/task-runs/" +
          b.claim!.runId +
          "/completions/" +
          id;
  if (
    r.url !== target ||
    r.method !== (mutating ? "PUT" : "GET") ||
    r.operationId !== (mutating ? id : null) ||
    (!mutating && r.bodyDigest !== digest(null))
  )
    throw Error("Exact original assignment operation required");
}
