import React, { useEffect, useState } from "react";
const blank = () => ({
  operationId: crypto.randomUUID(),
  name: "",
  description: "",
  mode: "AI draft",
  dueDate: "",
  status: "Open",
});
export function CrmTaskEditor({ api, projectId }: any) {
  const [snapshot, setSnapshot] = useState<any>(null),
    [draft, setDraft] = useState<any>(null),
    [error, setError] = useState(""),
    [syncError, setSyncError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true,
      inFlight = false;
    setSnapshot(null);
    setDraft(null);
    setError("");
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const s = await api(`/v1/crm-projects/${projectId}/tasks`);
        if (current) {
          setSnapshot(s);
          setSyncError("");
        }
      } catch {
        if (current)
          setSyncError(
            "CRM refresh unavailable. Saved drafts remain here; wait and refresh before editing.",
          );
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [projectId]);
  const edit = (patch: any) =>
    setDraft((d: any) => ({
      ...d,
      ...patch,
      operationId: crypto.randomUUID(),
    }));
  const stale =
    draft?.taskId &&
    snapshot &&
    !snapshot.tasks.some(
      (t: any) => t.id === draft.taskId && t.version === draft.version,
    );
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api("/v1/crm-projects/tasks", "POST", { ...draft, projectId });
      setDraft(null);
      setSnapshot(await api(`/v1/crm-projects/${projectId}/tasks`));
    } catch {
      setError(
        "Save could not be confirmed. Your draft is preserved. Retry unchanged for the same operation, or reload the task if CRM has changed.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Synced CRM tasks">
      <h4>CRM tasks</h4>
      <p>
        Tasks are saved directly in CRM. This list checks for changes every 15
        seconds. Editing preserves assignment, sharing and linked records.
      </p>
      {snapshot && (
        <p>
          Last synced: {new Date(snapshot.checkedAt).toLocaleTimeString()}
          {snapshot.truncated ? " · Showing the latest 500 tasks" : ""}
        </p>
      )}
      {syncError && <p role="status">{syncError}</p>}
      {error && <p role="status">{error}</p>}
      <button disabled={busy || !!draft} onClick={() => setDraft(blank())}>
        New CRM task
      </button>
      {snapshot?.tasks.map((t: any) => (
        <div key={t.id}>
          <span>
            {t.name} · {t.status} · {t.mode}
          </span>
          <button
            disabled={busy || !!draft}
            onClick={() =>
              setDraft({
                operationId: crypto.randomUUID(),
                taskId: t.id,
                version: t.version,
                name: t.name,
                description: t.description,
                mode: t.mode,
                dueDate: t.dueDate,
                status: t.status,
              })
            }
          >
            Edit {t.name}
          </button>
        </div>
      ))}
      {snapshot?.tasks.length === 0 && (
        <p>No AI draft or review tasks in this project.</p>
      )}
      {draft && (
        <fieldset disabled={busy}>
          <legend>{draft.taskId ? "Edit CRM task" : "New CRM task"}</legend>
          {stale && (
            <p role="status">
              This task changed in CRM. Copy your draft before cancelling and
              reopening the current task. Saving a stale version will be
              rejected.
            </p>
          )}
          <label>
            Task name
            <input
              value={draft.name}
              maxLength={200}
              onChange={(e) => edit({ name: e.target.value })}
            />
          </label>
          <label>
            Task description
            <textarea
              value={draft.description}
              maxLength={4000}
              onChange={(e) => edit({ description: e.target.value })}
            />
          </label>
          <label>
            Task type
            <select
              value={draft.mode}
              onChange={(e) => edit({ mode: e.target.value })}
            >
              <option>AI draft</option>
              <option>AI review</option>
            </select>
          </label>
          <label>
            Due date
            <input
              type="date"
              value={draft.dueDate}
              onChange={(e) => edit({ dueDate: e.target.value })}
            />
          </label>
          {draft.taskId && (
            <label>
              Task status
              <select
                value={draft.status}
                onChange={(e) => edit({ status: e.target.value })}
              >
                <option>Open</option>
                <option>Done</option>
              </select>
            </label>
          )}
          <button
            disabled={!draft.name.trim() || stale}
            onClick={() => void save()}
          >
            Save task to CRM
          </button>
          <button onClick={() => setDraft(null)}>Cancel edit</button>
        </fieldset>
      )}
    </section>
  );
}
