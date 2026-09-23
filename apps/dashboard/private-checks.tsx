import React, { useEffect, useId, useRef, useState } from "react";
import {
  PrivateCheckPanelState,
  checkActionLabels,
} from "./private-check-state.js";
export function PrivateCheckPanel({
  api,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
}) {
  const [, render] = useState(0),
    ref = useRef<PrivateCheckPanelState | null>(null);
  if (!ref.current)
    ref.current = new PrivateCheckPanelState(api, () => render((n) => n + 1));
  const c = ref.current,
    s = c.state,
    review = s.review;
  const [peer, setPeer] = useState(""),
    [incoming, setIncoming] = useState(""),
    [ack, setAck] = useState(false);
  const labelId = useId(),
    codeLabelId = useId(),
    incomingLabelId = useId();
  const clear = () => {
    c.hide();
    setIncoming("");
    setPeer("");
    setAck(false);
  };
  useEffect(() => {
    void c.refresh();
    const blur = () => clear(),
      visibility = () => {
        if (document.hidden) clear();
      },
      escape = (e: KeyboardEvent) => {
        if (e.key === "Escape") clear();
      };
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("keydown", escape);
      c.hide();
    };
  }, [c]);
  useEffect(() => {
    setAck(false);
    setIncoming("");
  }, [review]);
  useEffect(() => {
    const deadline = review?.expiresAt ?? s.output?.expiresAt;
    if (!deadline) return;
    const timer = window.setTimeout(clear, Math.max(0, deadline - Date.now()));
    return () => window.clearTimeout(timer);
  }, [review, s.output]);
  const enabled =
    s.status?.enabled &&
    s.peers?.canSetup &&
    s.peers.hasSelectedKey &&
    !s.peers.needsFreshPairing;
  return (
    <section
      className="private-key-panel private-peer-panel private-check-panel"
      aria-label="Verify a private device"
    >
      <div className="row">
        <h3>Verify a private device</h3>
        <button
          disabled={s.busy}
          onClick={() => {
            clear();
            void c.refresh();
          }}
        >
          Refresh saved checks
        </button>
      </div>
      <p>
        After comparing and saving each other’s public keys, exchange a check
        and reply. Each device starts its own check. Completing one grants no
        task or app access.
      </p>
      <p>
        Codes expire within five minutes. Transfer them yourself between trusted
        devices; this screen does not send them or read your clipboard.
      </p>
      {s.error && <p role="alert">{s.error}</p>}
      {s.notice && <p role="status">{s.notice}</p>}
      {!s.status ? (
        <p>
          {s.busy
            ? "Loading saved checks…"
            : "Refresh to check saved exchanges."}
        </p>
      ) : !enabled ? (
        <p>
          New checks need enabled device setup, a selected Mac key and a saved
          device key. Restored trust needs fresh pairing.
        </p>
      ) : null}
      {enabled && !review && !s.output && (
        <div className="private-peer-forms">
          <label>
            <span id={labelId}>Device to check</span>
            <select
              aria-labelledby={labelId}
              value={peer}
              disabled={s.busy}
              onChange={(e) => {
                c.hide();
                setPeer(e.target.value);
                setIncoming("");
                setAck(false);
              }}
            >
              <option value="">Choose a saved device</option>
              {s
                .peers!.peers.filter((p) => !p.revoked)
                .map((p) => (
                  <option key={p.peerId} value={p.peerId}>
                    {p.peerId} · key {p.keyEpoch}
                  </option>
                ))}
            </select>
          </label>
          <button
            disabled={s.busy || !peer}
            onClick={() => c.prepare("begin", peer)}
          >
            Review starting a check
          </button>
          <label>
            <span id={incomingLabelId}>Encrypted code from this device</span>
            <textarea
              aria-labelledby={incomingLabelId}
              rows={5}
              spellCheck={false}
              autoComplete="off"
              maxLength={65536}
              value={incoming}
              disabled={s.busy}
              onChange={(e) => {
                c.hide();
                setIncoming(e.target.value);
                setAck(false);
              }}
            />
          </label>
          <div className="row">
            <button
              disabled={s.busy || !peer || !incoming.trim()}
              onClick={() => c.prepare("respond", peer, incoming)}
            >
              Review answering its check
            </button>
            <button
              disabled={s.busy || !peer || !incoming.trim()}
              onClick={() => c.prepare("complete", peer, incoming)}
            >
              Review verifying its reply
            </button>
          </div>
        </div>
      )}
      {review && (
        <section
          className="private-key-review"
          aria-label="Review device check"
        >
          <h4>{checkActionLabels[review.action]}</h4>
          <dl>
            <dt>Other device</dt>
            <dd>{review.peerId}</dd>
            {review.id && (
              <>
                <dt>Saved exchange</dt>
                <dd>{review.id}</dd>
              </>
            )}
            {review.fingerprint && (
              <>
                <dt>Saved fingerprint</dt>
                <dd>{review.fingerprint}</dd>
              </>
            )}
          </dl>
          <p>
            {review.action === "stop"
              ? "Stop further use of this saved exchange on this Mac. This cannot remove codes already shared or revoke completed verification. Revoke device trust separately if needed."
              : review.action === "respond"
                ? "Create an encrypted reply for this saved device. Answering its check does not verify it on this Mac. Start your own check separately."
                : review.action === "complete"
                  ? "Verify the reply against this Mac’s original check. The companion will check the code, current keys and expiry before saving the result."
                  : review.action === "envelope"
                    ? "Reveal the original encrypted code for manual transfer to this device. It contains routing identifiers; share it only with the intended device."
                    : review.action === "resume"
                      ? "Finish preparing this saved exchange using its original identity and deadline. This does not start a new check."
                      : "Create a check for this saved device. Transfer its code, then return here with the device’s encrypted reply."}
          </p>
          <p>Task permissions remain a separate choice.</p>
          <label>
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            I reviewed this device and want to perform this action.
          </label>
          <div className="row">
            <button
              disabled={s.busy || !ack}
              onClick={() => void c.confirm(ack)}
            >
              {checkActionLabels[review.action]}
            </button>
            <button onClick={clear}>Cancel check review</button>
          </div>
        </section>
      )}
      {s.output && (
        <section
          className="private-key-review"
          aria-label="Encrypted exchange code"
        >
          <h4>
            {s.output.role === "challenge"
              ? "Your check for the other device"
              : "Your reply to the other device"}
          </h4>
          <p className="private-peer-code">For {s.output.peerId}</p>
          <p>
            {s.output.role === "challenge"
              ? "On the other device, choose to answer this check. Bring its encrypted reply back here and choose to verify it."
              : "On the other device, choose to verify this reply. To verify that device here, start a separate check on this Mac."}
          </p>
          <label>
            <span id={codeLabelId}>Encrypted code to transfer</span>
            <textarea
              aria-labelledby={codeLabelId}
              rows={6}
              readOnly
              spellCheck={false}
              value={s.output.code}
            />
          </label>
          <button onClick={clear}>Hide encrypted code</button>
        </section>
      )}
      <h4>Saved exchanges</h4>
      <p>
        Recorded results do not establish a current connection. Key changes,
        revocation, expired identity or restored data can invalidate them. Task
        permission checks validate current trust again.
      </p>
      {s.status?.checks.length === 0 && <p>No device checks saved here.</p>}
      <ul className="private-key-list">
        {s.status?.checks.map((r) => (
          <li key={r.id}>
            <strong>
              {r.locked
                ? "Locked after recovery"
                : r.state === "verified"
                  ? "Reply verified previously"
                  : r.state === "stopped"
                    ? "Stopped locally"
                    : r.state === "preparing"
                      ? "Preparation unfinished"
                      : r.role === "challenge"
                        ? "Check awaiting reply"
                        : "Reply prepared"}
            </strong>
            <p className="private-peer-code">{r.peerId}</p>
            <p className="private-peer-code">Exchange {r.id}</p>
            {r.state !== "verified" && r.state !== "stopped" && (
              <>
                <p>
                  Exchange deadline: {new Date(r.expiresAt).toLocaleString()}
                </p>
                <div className="row">
                  {enabled && !r.locked && (
                    <button
                      disabled={s.busy}
                      onClick={() =>
                        c.prepare(
                          r.state === "preparing" ? "resume" : "envelope",
                          r.id,
                        )
                      }
                    >
                      {r.state === "preparing" ? "Review resume" : "Show code"}{" "}
                      for {r.id}
                    </button>
                  )}
                  <button
                    disabled={s.busy}
                    onClick={() => c.prepare("stop", r.id)}
                  >
                    Review stop for {r.id}
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
