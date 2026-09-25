import React, { useEffect, useMemo, useRef, useState } from "react";
import { ResumeOfferPanelState } from "./resume-offer-state.js";
import type {
  ResumePermissionStatus,
  ResumeTaskScope,
} from "./resume-permission-state.js";
export function ResumeOffers({
  api,
  permissions,
  taskId,
  taskRevision,
  status,
}: ResumeTaskScope & {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
  permissions: ResumePermissionStatus;
}) {
  const [, render] = useState(0),
    [ack, setAck] = useState(false);
  const urls = useRef(new Set<string>());
  const c = useMemo(
    () =>
      new ResumeOfferPanelState(api, { taskId, taskRevision, status }, () =>
        render((v) => v + 1),
      ),
    [api, taskId, taskRevision, status, permissions.revision],
  );
  const available = () => document.hasFocus() && !document.hidden;
  useEffect(() => {
    const clear = () => {
      c.hide();
      setAck(false);
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current.clear();
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
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current.clear();
      window.removeEventListener("blur", clear);
      window.removeEventListener("keydown", escape);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [c]);
  useEffect(() => {
    setAck(false);
  }, [c.review?.id, c]);
  const download = (wire: unknown, id: string) => {
    if (!available()) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(wire)], { type: "application/json" }),
    );
    urls.current.add(url);
    const link = document.createElement("a");
    link.href = url;
    link.download = `bittrees-resume-offer-${id}.json`;
    link.rel = "noopener";
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      urls.current.delete(url);
    }, 1000);
  };
  const grants = permissions.grants.filter(
      (g) =>
        g.state === "saved" &&
        g.choices.taskId === taskId &&
        g.choices.taskRevision === taskRevision,
    ),
    offers = c.status?.offers.filter((e) => e.choices.taskId === taskId) ?? [],
    r = c.review;
  return (
    <section className="resume-offers" aria-label="Encrypted resume offers">
      <h4>Encrypted resume offers</h4>
      <p>
        Download an encrypted invitation for the paired browser. It contains the
        task and model identities, with no task text.
      </p>
      <p className="hint">
        Browser import and remote resume controls are not available yet.
        Downloading does not send anything or resume this task.
      </p>
      <button
        disabled={c.busy}
        onClick={() => {
          setAck(false);
          void c.refresh();
        }}
      >
        Refresh resume offers
      </button>
      {c.error && <p role="alert">{c.error}</p>}
      {c.notice && <p role="status">{c.notice}</p>}
      {c.status && !r && (
        <>
          {(!grants.length || status !== "paused") && (
            <p>
              Save permission for this paused task above before creating an
              offer.
            </p>
          )}
          {status === "paused" &&
            grants.map((g) => (
              <div key={g.id}>
                <p className="resume-identity">
                  Paired browser: {g.choices.peerId}
                </p>
                <button
                  disabled={
                    c.busy ||
                    !c.status?.canSetup ||
                    !permissions.canSetup ||
                    g.choices.expiresAt <= Date.now()
                  }
                  onClick={() => {
                    setAck(false);
                    void c.create(g.id, permissions);
                  }}
                >
                  Review new resume offer
                </button>
              </div>
            ))}
          <h5>Saved offers</h5>
          {!offers.length && <p>No resume offers saved.</p>}
          {offers.map((e) => (
            <article key={e.id} aria-label="Saved resume offer">
              <p className="resume-identity">Offer {e.id}</p>
              <p>
                {e.state === "preparing"
                  ? "Preparation interrupted; review to continue."
                  : e.state === "ready"
                    ? "Encrypted offer saved; access will be checked again."
                    : e.state === "stopped"
                      ? "Further downloads stopped."
                      : e.state === "locked"
                        ? "Restored offer locked."
                        : "Offer expired."}
              </p>
              <p>Opening deadline: {new Date(e.expiresAt).toLocaleString()}</p>
              <div className="actions">
                {["ready", "preparing"].includes(e.state) && (
                  <button
                    disabled={
                      c.busy ||
                      !c.status?.canSetup ||
                      status !== "paused" ||
                      e.choices.taskRevision !== taskRevision ||
                      e.expiresAt <= Date.now()
                    }
                    onClick={() => {
                      setAck(false);
                      void c.prepare(e.id, "reveal");
                    }}
                  >
                    Review resume offer download
                  </button>
                )}
                {e.state !== "stopped" && (
                  <button
                    disabled={c.busy}
                    onClick={() => {
                      setAck(false);
                      void c.prepare(e.id, "stop");
                    }}
                  >
                    Review stopping offer downloads
                  </button>
                )}
              </div>
            </article>
          ))}
        </>
      )}
      {r && (
        <article
          className="resume-review"
          aria-label="Review encrypted resume offer"
        >
          <h5>
            {r.action === "stop"
              ? "Stop further downloads"
              : "Review encrypted download"}
          </h5>
          <dl className="resume-choices">
            <dt>Task</dt>
            <dd>
              {r.choices.taskId} (revision {r.choices.taskRevision})
            </dd>
            <dt>Model identity</dt>
            <dd>{r.choices.modelDigest}</dd>
            <dt>Paired browser</dt>
            <dd>{r.choices.peerId}</dd>
            <dt>Browser fingerprint</dt>
            <dd>{r.fingerprint}</dd>
            <dt>Opening deadline</dt>
            <dd>{new Date(r.offerExpiresAt).toLocaleString()}</dd>
            <dt>Resume permission ends</dt>
            <dd>{new Date(r.choices.expiresAt).toLocaleString()}</dd>
          </dl>
          <p>
            {r.action === "stop"
              ? "Downloaded copies remain. Revoke the separate resume permission to remove access."
              : "Only this paired browser can open the encrypted file. It still needs to review its own permission."}
          </p>
          <label className="resume-ack">
            <input
              type="checkbox"
              checked={ack}
              disabled={c.busy}
              onChange={(e) => setAck(e.target.checked)}
            />
            I reviewed this resume offer and this exact action.
          </label>
          <div className="actions">
            <button
              disabled={c.busy || !ack}
              onClick={() => void c.confirm(ack, available, download)}
            >
              {r.action === "stop"
                ? "Stop reviewed offer downloads"
                : "Download reviewed resume offer"}
            </button>
            <button
              disabled={c.busy}
              onClick={() => {
                c.discard();
                setAck(false);
              }}
            >
              Cancel offer review
            </button>
          </div>
        </article>
      )}
    </section>
  );
}
