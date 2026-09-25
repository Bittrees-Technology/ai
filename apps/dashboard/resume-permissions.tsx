import React, { useEffect, useId, useMemo, useState } from "react";
import {
  ResumePermissionPanelState,
  emptyResumeForm,
  type ResumeChoices,
  type ResumeTaskScope,
} from "./resume-permission-state.js";
function Choices({ choices }: { choices: ResumeChoices }) {
  return (
    <dl className="resume-choices">
      <dt>Task</dt>
      <dd>
        {choices.taskId} (revision {choices.taskRevision})
      </dd>
      <dt>Paired browser</dt>
      <dd>
        {choices.peerId} (key {choices.peerKeyEpoch})
      </dd>
      <dt>Model identity</dt>
      <dd>{choices.modelDigest}</dd>
      <dt>Permission ends</dt>
      <dd>{new Date(choices.expiresAt).toLocaleString()}</dd>
    </dl>
  );
}
export function ResumePermissions({
  api,
  taskId,
  taskRevision,
  status: taskStatus,
}: ResumeTaskScope & {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
}) {
  const id = useId();
  const [, render] = useState(0);
  const c = useMemo(
    () =>
      new ResumePermissionPanelState(
        api,
        { taskId, taskRevision, status: taskStatus },
        () => render((v) => v + 1),
      ),
    [api, taskId, taskRevision, taskStatus],
  );
  const [form, setForm] = useState(emptyResumeForm);
  const [ack, setAck] = useState(false);
  const available = () => document.hasFocus() && !document.hidden;
  useEffect(() => {
    const clear = () => {
      c.hide();
      setAck(false);
      setForm(emptyResumeForm());
    };
    const visibility = () => {
      if (document.hidden) clear();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") clear();
    };
    window.addEventListener("blur", clear);
    window.addEventListener("keydown", escape);
    document.addEventListener("visibilitychange", visibility);
    const timer = setInterval(() => c.expire(), 250);
    return () => {
      clearInterval(timer);
      c.dispose();
      window.removeEventListener("blur", clear);
      window.removeEventListener("keydown", escape);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [c]);
  useEffect(() => {
    setAck(false);
  }, [c.review?.id, c]);
  const change = (patch: Partial<typeof form>) => {
    c.invalidateReview();
    setAck(false);
    setForm((v) => ({ ...v, ...patch }));
  };
  const s = c.status,
    review = c.review;
  const ready =
    s?.available &&
    s.canSetup &&
    s.hasSelectedKey &&
    !s.needsFreshPairing &&
    s.peers.length > 0 &&
    taskStatus === "paused";
  return (
    <section
      className="resume-permissions"
      aria-label="Browser resume permission"
    >
      <h3>Resume from a paired browser</h3>
      <p>
        Allow one paired browser to resume this paused task once, using the
        reviewed local model.
      </p>
      <p className="hint">
        Saving stays on this Mac. Sending this permission and resuming from the
        browser are not available yet.
      </p>
      <button
        disabled={c.busy}
        onClick={() => {
          setAck(false);
          setForm(emptyResumeForm());
          void c.refresh();
        }}
      >
        Refresh resume choices
      </button>
      {c.error && <p role="alert">{c.error}</p>}
      {c.notice && <p role="status">{c.notice}</p>}
      {s && (
        <>
          {taskStatus !== "paused" && (
            <p>
              Pause this task before granting resume permission. Existing
              permissions can still be revoked.
            </p>
          )}
          {!s.canSetup && (
            <p>
              New resume permissions are not enabled on this Mac. Saved
              permissions can still be revoked.
            </p>
          )}
          {s.canSetup &&
            (!s.hasSelectedKey || s.needsFreshPairing || !s.peers.length) && (
              <p>
                Complete private pairing in Connections, then refresh these
                choices.
              </p>
            )}
          {ready && (
            <fieldset disabled={c.busy}>
              <legend>New resume permission</legend>
              <label htmlFor={`${id}-peer`}>Paired browser</label>
              <select
                id={`${id}-peer`}
                value={form.peerId}
                onChange={(e) => change({ peerId: e.target.value })}
              >
                <option value="">Choose a browser</option>
                {s.peers.map((p) => (
                  <option key={p.peerId} value={p.peerId}>
                    {p.peerId}
                  </option>
                ))}
              </select>
              <label htmlFor={`${id}-duration`}>Permission duration</label>
              <select
                id={`${id}-duration`}
                value={form.minutes}
                onChange={(e) =>
                  change({ minutes: Number(e.target.value) as 15 | 60 })
                }
              >
                <option value={15}>15 minutes</option>
                <option value={60}>1 hour</option>
              </select>
              <button
                disabled={!form.peerId}
                onClick={() => {
                  setAck(false);
                  void c.prepare(form);
                }}
              >
                Review resume permission
              </button>
            </fieldset>
          )}
          {s.grants
            .filter((g) => g.choices.taskId === taskId)
            .map((g) => (
              <article key={g.id} aria-label="Saved resume permission">
                <h4>Saved resume permission</h4>
                <p>{g.state.replaceAll("-", " ")}</p>
                <Choices choices={g.choices} />
                {g.state !== "revoked" && (
                  <button
                    disabled={c.busy}
                    onClick={() => {
                      setAck(false);
                      void c.revoke(g.id);
                    }}
                  >
                    Review revocation
                  </button>
                )}
              </article>
            ))}
        </>
      )}
      {review && (
        <article
          aria-label="Review resume permission"
          className="resume-review"
        >
          <h4>
            {review.action === "grant"
              ? "Review one resume"
              : "Review revocation"}
          </h4>
          <Choices choices={review.choices} />
          <p>
            Browser fingerprint:{" "}
            <span className="resume-identity">{review.fingerprint}</span>
          </p>
          <p>
            This review ends {new Date(review.expiresAt).toLocaleTimeString()}.
          </p>
          <label className="resume-ack">
            <input
              type="checkbox"
              checked={ack}
              disabled={c.busy}
              onChange={(e) => setAck(e.target.checked)}
            />
            {review.action === "grant"
              ? "I checked this task, model and paired browser."
              : "I want to revoke this resume permission."}
          </label>
          <div className="actions">
            <button
              disabled={c.busy || !ack}
              onClick={() => void c.confirm(ack, available)}
            >
              {review.action === "grant"
                ? "Save resume permission"
                : "Revoke resume permission"}
            </button>
            <button
              disabled={c.busy}
              onClick={() => {
                c.invalidateReview();
                setAck(false);
              }}
            >
              Cancel resume review
            </button>
          </div>
        </article>
      )}
    </section>
  );
}
