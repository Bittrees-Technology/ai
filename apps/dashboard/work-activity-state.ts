export const workLanes = [
  ["backlog", "Backlog"],
  ["ready", "Ready"],
  ["running", "In progress"],
  ["review", "Review"],
  ["blocked", "Blocked"],
  ["done", "Done"],
] as const;
export type WorkLane = (typeof workLanes)[number][0];
export function researchLane(state: string): WorkLane {
  switch (state) {
    case "running":
      return "running";
    case "complete":
      return "done";
    case "queued":
      return "ready";
    case "paused":
      return "backlog";
    default:
      return "blocked";
  }
}
export function centralLane(status: any, now = Date.now()): WorkLane {
  if (status.progress?.state === "held") return "blocked";
  if (!status.enabled) return "backlog";
  if (status.currentJob?.completionPending) return "review";
  const until = Date.parse(status.currentJob?.leaseUntil);
  if (!Number.isFinite(until) || until <= now) return "blocked";
  return status.running ? "running" : "ready";
}
export function centralRunUrl(workflowId: string, runId: string) {
  return (
    "https://workflow.bittrees.org/?workflow=" +
    encodeURIComponent(workflowId) +
    "&run=" +
    encodeURIComponent(runId)
  );
}
