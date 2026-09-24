import { profileSettingsText } from "./model-profile-settings.js";
import React, { useEffect, useState } from "react";

type Run = {
  id: string;
  outcome: string | null;
  model?: {
    executionLimits?: {
      parallelTasks: number;
      maxTaskSeconds: number;
      minFreeMemoryGiB: number;
    };
    profile?: {
      model?: string;
      contextTokens?: number;
      maxOutputTokens?: number;
      temperature?: number;
    };
  } | null;
};
/** Mount with a task/revision key so previous history is absent on the first render. */
export function TaskRuns({
  taskId,
  sourceBound,
  dependencyUnavailable,
  status,
  api,
  onError,
}: {
  taskId: string;
  sourceBound?: boolean;
  dependencyUnavailable?: boolean;
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
    if (sourceBound || dependencyUnavailable) return;
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
  }, [taskId, sourceBound, dependencyUnavailable, refresh, api]);
  return (
    <section aria-label="Run history">
      <h3>Run history</h3>
      {dependencyUnavailable ? (
        <p>
          History is hidden because a local reference changed or is unavailable.
        </p>
      ) : sourceBound ? (
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
              {run.outcome === "runtime_limit"
                ? "Time limit reached"
                : run.outcome === "clarification_limit"
                  ? "More detail needed"
                  : run.outcome === "invalid_model_output"
                    ? "Answer rejected"
                    : (run.outcome ?? "Running")}{" "}
              · {run.model?.profile?.model ?? "Model not started"}
            </p>
            {run.model?.profile && profileSettingsText(run.model.profile) && (
              <p className="hint">
                Recorded settings: {profileSettingsText(run.model.profile)}
              </p>
            )}
            {run.model?.executionLimits && (
              <p className="hint">
                Saved device limits: {run.model.executionLimits.maxTaskSeconds}s
                per task; {run.model.executionLimits.parallelTasks} task(s) at
                once; {run.model.executionLimits.minFreeMemoryGiB} GiB minimum
                free memory.
              </p>
            )}
            {run.outcome === "runtime_limit" && (
              <p>
                The task exceeded its saved time limit. No result was accepted.
                Review the limit in Device before submitting a new task.
              </p>
            )}
            {run.outcome === "clarification_limit" && (
              <p className="hint">
                The model still needed information after two questions. No
                result was saved. Review your answers and start a clearer
                request.
              </p>
            )}
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
