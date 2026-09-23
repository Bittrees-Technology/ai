import React, { useEffect, useRef, useState } from "react";
import type { TaskFeedback } from "../../modules/storage/task-feedback.js";
type Snapshot = ReturnType<TaskFeedback["read"]>;
type Outcome = "accepted" | "edited" | "rejected";
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
const labels = {
  accepted: "Used as-is",
  edited: "Needed edits",
  rejected: "Not useful",
};

/** One mounted task/revision, current source checks, explicit human feedback only. */
export function TaskQualityReview({
  taskId,
  api,
}: {
  taskId: string;
  api: Api;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [outcome, setOutcome] = useState<Outcome | "">(""),
    [note, setNote] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("Loading your review…");
  const current = useRef<Snapshot | null>(null),
    epoch = useRef(0),
    working = useRef(false),
    mounted = useRef(false);
  const pending = useRef<{ key: string; body: unknown } | null>(null);
  const path = `/v1/requests/${taskId}/quality-review`;
  const clear = () => {
    current.current = null;
    setSnapshot(null);
    setOutcome("");
    setNote("");
    setConfirmed(false);
    pending.current = null;
  };
  const apply = (next: Snapshot, force = false) => {
    if (
      !next ||
      next.taskId !== taskId ||
      !Number.isInteger(next.taskRevision) ||
      !Number.isInteger(next.reviewRevision) ||
      typeof next.runId !== "string" ||
      !Number.isFinite(next.durationMs) ||
      next.durationMs < 0 ||
      (next.review !== null &&
        (!next.review ||
          !Object.hasOwn(labels, next.review.outcome) ||
          typeof next.review.note !== "string" ||
          next.review.note.length > 2000))
    )
      throw Error("Invalid review");
    if (
      force ||
      current.current?.reviewRevision !== next.reviewRevision ||
      current.current?.runId !== next.runId
    ) {
      setOutcome(next.review?.outcome ?? "");
      setNote(next.review?.note ?? "");
      setConfirmed(false);
      pending.current = null;
    }
    current.current = next;
    setSnapshot(next);
    setMessage("");
  };
  async function refresh() {
    if (working.current || document.hidden || !document.hasFocus()) return;
    const generation = ++epoch.current;
    try {
      const next = await api(path);
      if (mounted.current && generation === epoch.current) apply(next);
    } catch {
      if (mounted.current && generation === epoch.current) {
        clear();
        setMessage(
          "Review unavailable. The task must have a completed model run and current source access.",
        );
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    const hide = () => {
      epoch.current++;
      working.current = false;
      setBusy(false);
      clear();
      setMessage("Review hidden. Refresh after returning to this window.");
    };
    const visibility = () => {
      if (document.hidden) hide();
      else void refresh();
    };
    const focus = () => void refresh();
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    window.addEventListener("blur", hide);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      mounted.current = false;
      epoch.current++;
      clearInterval(timer);
      window.removeEventListener("blur", hide);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [taskId, api]);
  async function save(remove = false) {
    if (working.current || !snapshot || (!remove && (!confirmed || !outcome)))
      return;
    const fields = {
        expectedTaskRevision: snapshot.taskRevision,
        runId: snapshot.runId,
        expectedReviewRevision: snapshot.reviewRevision,
        review: remove ? null : { outcome, note },
        confirmed: true,
      },
      key = JSON.stringify(fields);
    if (pending.current?.key !== key)
      pending.current = {
        key,
        body: { ...fields, operationId: crypto.randomUUID() },
      };
    const generation = ++epoch.current;
    working.current = true;
    setBusy(true);
    try {
      const next = await api(path, "PUT", pending.current.body);
      if (mounted.current && generation === epoch.current) {
        apply(next, true);
        setMessage(
          remove ? "Your review was deleted." : "Your review was saved.",
        );
      }
    } catch {
      if (mounted.current && generation === epoch.current)
        setMessage(
          "The save could not be confirmed. Your input is still here. Refresh to check the saved review before changing it; no automatic retry was made.",
        );
    } finally {
      if (mounted.current && generation === epoch.current) {
        working.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <section className="task-quality-review" aria-label="Your quality review">
      <h3>Your review</h3>
      <p className="hint">
        Record how this result worked for you. This does not publish, approve an
        action, verify facts or train the model. Only your latest review of this
        result counts.
      </p>
      {message && <p role="status">{message}</p>}
      <button disabled={busy} onClick={() => void refresh()}>
        Refresh review
      </button>
      {snapshot && (
        <>
          <p className="hint">
            Recorded run duration: {(snapshot.durationMs / 1000).toFixed(1)}{" "}
            seconds. Run {snapshot.runId}.
          </p>
          {snapshot.review && (
            <p>Saved review: {labels[snapshot.review.outcome]}</p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={busy}>
              <legend>How did this result work for you?</legend>
              {Object.entries(labels).map(([value, label]) => (
                <label className="check" key={value}>
                  <input
                    type="radio"
                    name={`quality-${taskId}`}
                    value={value}
                    checked={outcome === value}
                    onChange={() => {
                      setOutcome(value as Outcome);
                      setConfirmed(false);
                    }}
                  />
                  {label}
                </label>
              ))}
              <label>
                Optional review note
                <textarea
                  maxLength={2000}
                  value={note}
                  onChange={(e) => {
                    setNote(e.target.value);
                    setConfirmed(false);
                  }}
                  placeholder="What was useful, missing or wrong?"
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                I reviewed this result.
              </label>
              <button disabled={!confirmed || !outcome}>Save my review</button>
            </fieldset>
          </form>
          {snapshot.review && (
            <button
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Delete your review of this result? The task and model run will stay.",
                  )
                )
                  void save(true);
              }}
            >
              Delete my review
            </button>
          )}
        </>
      )}
    </section>
  );
}
