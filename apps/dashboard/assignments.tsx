import React, { useEffect, useState } from "react";
const holdReasons: Record<string, string> = {
  "completion-unconfirmed":
    "Workflows completion could not be confirmed. Further attempts are blocked.",
  "source-finalization-unconfirmed":
    "The CRM status update could not be confirmed. Further attempts are blocked.",
  "source-finalization-approval-unavailable":
    "Updating the CRM task status needs current owner approval.",
  "validation-rejected":
    "Independent validation did not accept this result. No new result write or completion is allowed.",
  "validation-required":
    "An independent workflow validator is required before work can complete.",
  "native-unavailable": "The native connection is unavailable.",
  "model-changed": "The local model no longer matches the approved version.",
  "source-or-authority":
    "Current source access or permission could not be confirmed.",
  "attempt-budget": "The allowed attempts have been used.",
  "inference-unconfirmed":
    "The model result is unconfirmed. Another model call is blocked.",
  "invalid-model-result": "The model result did not pass validation.",
};
export function AssignmentStatus({
  api,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
}) {
  const [state, setState] = useState<any>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = () =>
      api("/v1/workflows/assignments")
        .then((value) => {
          if (active) {
            setState(value);
            setError("");
          }
        })
        .catch(() => {
          if (active) setError("Assignment status is unavailable.");
        });
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  async function control(action: "pause" | "resume") {
    try {
      setState(await api("/v1/workflows/assignments/" + action, "POST", {}));
      setError("");
    } catch {
      setError("Assignment control could not be confirmed.");
    }
  }
  if (!state)
    return (
      <section aria-label="CRM assignments">
        <h3>CRM assignments</h3>
        <p>{error || "Loading assignment status…"}</p>
      </section>
    );
  return (
    <section aria-label="CRM assignments">
      <h3>CRM assignments</h3>
      <p>
        {state.phase === "disabled"
          ? "A native assignment connection needs owner approval."
          : "State: " + state.phase}
      </p>
      {state.hold && (
        <p role="status">
          {holdReasons[state.hold] || "This assignment is held for review."}
        </p>
      )}
      {state.failure === "MODEL_UNAVAILABLE" && (
        <p>The approved local model is unavailable.</p>
      )}
      {error && <p role="alert">{error}</p>}
      {state.phase !== "disabled" && (
        <button
          onClick={() =>
            void control(state.phase === "paused" ? "resume" : "pause")
          }
        >
          {state.phase === "paused"
            ? "Resume approved assignments"
            : "Pause assignments"}
        </button>
      )}
      {state.assignments.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Task</th>
              <th>Workflow</th>
              <th>Progress</th>
              <th>Last receipt</th>
              <th>Validation evidence</th>
            </tr>
          </thead>
          <tbody>
            {state.assignments.map((item: any) => (
              <tr key={item.assignmentId}>
                <td>
                  {item.taskId} · revision {item.taskRevision}
                </td>
                <td>
                  {item.workflowId} · revision {item.workflowRevision}
                </td>
                <td>
                  {item.phase === "completed"
                    ? item.sourceFinalized
                      ? "Workflows and CRM complete"
                      : "Result confirmed; CRM status unchanged"
                    : item.phase === "central-completed"
                      ? "Workflows complete; awaiting CRM confirmation"
                      : item.phase === "source-finalization-reconciliation"
                        ? "Checking the original CRM status update"
                        : item.phase || "Awaiting intake"}{" "}
                  · attempts {item.attempts}
                </td>
                <td>{item.lastReceiptId || "Awaiting confirmation"}</td>
                <td>
                  {item.validation
                    ? `${item.validation.validatorId} · checked ${new Date(item.validation.checkedAt).toLocaleString()}`
                    : "Not independently validated"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
