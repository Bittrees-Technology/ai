import React, { useEffect, useRef, useState } from "react";
import type {
  ExecutionControls,
  ExecutionLimits,
} from "../companion/execution-limits.js";
type State = ReturnType<ExecutionControls["admission"]>;
const messages: Record<State["reason"], string> = {
  ready: "Ready to start queued tasks.",
  busy: "Waiting for a running task to release a slot.",
  paused: "New tasks are paused. Running tasks continue.",
  low_memory: "Queued tasks are waiting for more free memory.",
  memory_unknown:
    "Queued tasks are waiting because free memory could not be read.",
};
export function ExecutionSettings({
  api,
  status,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
  status: State;
}) {
  const [saved, setSaved] = useState(status),
    [draft, setDraft] = useState(status.limits),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [needsReload, setNeedsReload] = useState(false),
    [notice, setNotice] = useState("");
  const epoch = useRef(0);
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  // Polling updates availability, but never overwrites an unsaved settings form.
  const current = status.revision >= saved.revision ? status : saved;
  const changedElsewhere = status.revision > saved.revision;
  function change<K extends keyof ExecutionLimits>(
    key: K,
    value: ExecutionLimits[K],
  ) {
    setDraft((old) => ({ ...old, [key]: value }));
    setConfirmed(false);
    setNotice("");
  }
  async function request(save: boolean) {
    const n = ++epoch.current;
    setBusy(true);
    setNotice("");
    try {
      const next: State = await api(
        "/v1/device/execution",
        save ? "PUT" : "GET",
        save
          ? { expectedRevision: saved.revision, limits: draft, confirmed: true }
          : undefined,
      );
      if (n !== epoch.current) return;
      setNeedsReload(false);
      setSaved(next);
      setDraft(next.limits);
      setConfirmed(false);
      setNotice(
        save
          ? "Limits saved for new tasks. Running tasks keep their original time limit."
          : "Current limits loaded.",
      );
    } catch {
      if (n === epoch.current) {
        setNeedsReload(true);
        setNotice(
          save
            ? "The save could not be confirmed. Load current limits before trying again; your queued and running tasks are retained."
            : "Limits could not be loaded. Check that the companion is running.",
        );
      }
    } finally {
      if (n === epoch.current) setBusy(false);
    }
  }
  return (
    <section aria-label="Local execution limits" className="execution-settings">
      <h3>Local execution limits</h3>
      <p role="status">
        {messages[current.reason]} {current.activeTasks} active.
      </p>
      <p>
        These settings apply only to this Mac. Acer news processing stays
        separate.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (confirmed && !busy && !changedElsewhere && !needsReload)
            void request(true);
        }}
      >
        <fieldset disabled={busy}>
          <label>
            Tasks at once
            <input
              type="number"
              min="1"
              max="4"
              step="1"
              required
              value={draft.parallelTasks}
              onChange={(e) => change("parallelTasks", Number(e.target.value))}
            />
          </label>
          <label>
            Time limit per task (seconds)
            <input
              type="number"
              min="1"
              max="1800"
              step="1"
              required
              value={draft.maxTaskSeconds}
              onChange={(e) => change("maxTaskSeconds", Number(e.target.value))}
            />
          </label>
          <label>
            Minimum free memory (GiB)
            <input
              type="number"
              min="0"
              max="1024"
              step="1"
              required
              value={draft.minFreeMemoryGiB}
              onChange={(e) =>
                change("minFreeMemoryGiB", Number(e.target.value))
              }
            />
          </label>
          <p>
            Zero disables the memory check. This is a check before starting each
            task, not a memory reservation or a hard limit on Ollama. Model
            context and output size remain in Models.
          </p>
          <label className="execution-checkbox">
            <input
              type="checkbox"
              checked={draft.pauseNewTasks}
              onChange={(e) => change("pauseNewTasks", e.target.checked)}
            />
            Pause new tasks
          </label>
          <p>
            Running tasks keep their saved limits. Lowering the task count waits
            for them to finish. A timed-out task cannot save a late result; its
            slot stays occupied until the pending call returns. Queued deadlines
            still expire while waiting.
          </p>
          <label className="execution-checkbox">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            Apply these limits to new tasks on this Mac.
          </label>
          {changedElsewhere && (
            <p role="status">
              Limits changed since this form was loaded. Load current limits
              before saving.
            </p>
          )}
          <div className="actions">
            <button
              disabled={!confirmed || changedElsewhere || needsReload}
              type="submit"
            >
              Save limits
            </button>
            <button type="button" onClick={() => void request(false)}>
              Load current limits
            </button>
          </div>
        </fieldset>
      </form>
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
