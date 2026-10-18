import React, { useEffect, useState } from "react";
/** Displays the generic sync runner; project mappings and task sequences remain workflow data. */
export function TaskSyncStatus({
  api,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
}) {
  const [state, setState] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      api("/v1/workflows/task-sync")
        .then((v) => {
          if (active) {
            setState(v);
            setError("");
          }
        })
        .catch(() => {
          if (active) setError("Task synchronization status is unavailable.");
        });
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  async function control(action: "pause" | "resume") {
    setBusy(true);
    try {
      setState(await api("/v1/workflows/task-sync/" + action, "POST", {}));
      setError("");
    } catch {
      setError(
        "This change could not be confirmed. Refresh before trying again.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function review(action: "enroll" | "activate") {
    setBusy(true);
    try {
      await api("/v1/workflows/task-sync/" + action, "POST", {});
      setState(await api("/v1/workflows/task-sync"));
      setError("");
    } catch {
      setError(
        "The owner review could not be prepared. Your permissions have not changed.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (!state?.configured)
    return state?.reviewReady ? (
      <section aria-label="Connect task synchronization">
        <h3>Task synchronization</h3>
        <p>
          {state.enrolled
            ? "This Mac is enrolled. Synchronization waits for a finalized, time-limited permission."
            : "Connect this Mac to your Roles account to review the synchronization permission."}
        </p>
        {error && <p role="alert">{error}</p>}
        {!state.enrolled && (
          <button
            disabled={
              busy ||
              ["pending", "approved"].includes(state.ownerReview?.status)
            }
            onClick={() => void review("enroll")}
          >
            Connect this Mac in Roles
          </button>
        )}
        {state.enrolled && state.activationReady && (
          <button
            disabled={
              busy ||
              ["pending", "approved"].includes(state.ownerReview?.status)
            }
            onClick={() => void review("activate")}
          >
            Review one-hour permission
          </button>
        )}
        {state.ownerReview && (
          <>
            <p role="status">
              {state.ownerReview.status === "complete"
                ? "Owner review confirmed"
                : state.ownerReview.status === "expired"
                  ? "Review expired. Start again when ready."
                  : "Waiting for your review in Roles"}
            </p>
            {["pending", "approved"].includes(state.ownerReview.status) && (
              <a
                href={state.ownerReview.reviewUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open Roles review
              </a>
            )}
            {state.ownerReview.message && <p>{state.ownerReview.message}</p>}
          </>
        )}
      </section>
    ) : error ? (
      <p role="status">{error}</p>
    ) : null;
  const phase = state.progress?.state;
  const label =
    phase === "finished"
      ? "Synchronization complete"
      : phase === "expired"
        ? "Permission expired"
        : phase === "held"
          ? "Needs review"
          : state.running
            ? "Synchronizing"
            : state.enabled
              ? "Ready to synchronize"
              : "Paused";
  return (
    <section aria-label="Task synchronization">
      <h3>Task synchronization</h3>
      <p role="status">
        {label} · {state.completedImports} of {state.total} imports confirmed
      </p>
      <p>
        These receipts confirm tasks were saved to the destination. They do not
        mean the work described in those tasks is complete.
      </p>
      {state.expiresAt && (
        <p>Permission ends {new Date(state.expiresAt).toLocaleString()}.</p>
      )}
      {state.progress?.message && <p>{state.progress.message}</p>}
      {error && <p role="alert">{error}</p>}
      {state.enabled ? (
        <button disabled={busy} onClick={() => void control("pause")}>
          Pause synchronization
        </button>
      ) : (
        !["finished", "expired", "held"].includes(phase) && (
          <button disabled={busy} onClick={() => void control("resume")}>
            Resume synchronization
          </button>
        )
      )}
      <details>
        <summary>Confirmed imports</summary>
        <ul>
          {state.receipts?.slice(-10).map((r: any) => (
            <li key={r.sourceId}>
              {r.sourceId} ·{" "}
              {r.state === "unchanged" ? "Already current" : "Saved"} ·{" "}
              {new Date(r.receivedAt).toLocaleString()}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
