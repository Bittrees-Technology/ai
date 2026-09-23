import React, { useEffect, useState } from "react";

type Run = {
  id: string;
  outcome: string | null;
  model?: { profile?: { model?: string } } | null;
};
/** Mount with a task/revision key so previous history is absent on the first render. */
export function TaskRuns({
  taskId,
  sourceBound,
  status,
  api,
  onError,
}: {
  taskId: string;
  sourceBound?: boolean;
  status: string;
  api: (path: string) => Promise<any>;
  onError: (error: unknown) => void;
}) {
  const [state, setState] = useState<{
    items: Run[];
    error: boolean;
    loading: boolean;
  }>({ items: [], error: false, loading: true });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (sourceBound) return;
    let active = true;
    setState({ items: [], error: false, loading: true });
    api("/v1/requests/" + taskId + "/runs")
      .then((data) => {
        if (!active) return;
        if (!Array.isArray(data?.items)) throw Error("LOCAL_INVALID_RESPONSE");
        setState({ items: data.items, error: false, loading: false });
      })
      .catch((error) => {
        if (!active) return;
        setState({ items: [], error: true, loading: false });
        onError(error);
      });
    return () => {
      active = false;
    };
  }, [taskId, sourceBound, refresh, api]);
  return (
    <section aria-label="Run history">
      <h3>Run history</h3>
      {sourceBound ? (
        <p className="hint">
          Run history is not shown here for connected-app tasks.
        </p>
      ) : state.loading ? (
        <p role="status">Loading run history…</p>
      ) : state.error ? (
        <>
          <p role="status">Run history is unavailable. Try refreshing it.</p>
          <button onClick={() => setRefresh((value) => value + 1)}>
            Refresh run history
          </button>
        </>
      ) : state.items.length ? (
        state.items.map((run) => (
          <div key={run.id}>
            <p>
              {run.outcome === "invalid_model_output"
                ? "Answer rejected"
                : (run.outcome ?? "Running")}{" "}
              · {run.model?.profile?.model ?? "Model not started"}
            </p>
            {run.outcome === "invalid_model_output" && (
              <p className="hint">
                The model’s answer did not meet the required format or evidence
                rules. Start a fresh draft with another model or a revised
                request. No draft result was saved.
              </p>
            )}
          </div>
        ))
      ) : (
        <p className="hint">
          {["failed", "cancelled", "expired", "completed"].includes(status)
            ? "No model run history to show here."
            : "No model run history yet."}
        </p>
      )}
    </section>
  );
}
