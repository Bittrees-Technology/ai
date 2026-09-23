import React, { useEffect, useRef, useState } from "react";
import { PrivatePeerPanelState } from "./private-peer-state.js";
export function PrivatePeerPanel({
  api,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
}) {
  const [, render] = useState(0);
  const controller = useRef<PrivatePeerPanelState | null>(null);
  if (!controller.current)
    controller.current = new PrivatePeerPanelState(api, () =>
      render((n) => n + 1),
    );
  const c = controller.current,
    state = c.state,
    status = state.status,
    review = state.review;
  const [recipient, setRecipient] = useState(""),
    [incoming, setIncoming] = useState(""),
    [compared, setCompared] = useState(""),
    [ack, setAck] = useState(false);
  const clear = () => {
    c.hide();
    setCompared("");
    setAck(false);
    setIncoming("");
  };
  useEffect(() => {
    void c.refresh();
    const blur = () => clear(),
      visibility = () => {
        if (document.hidden) clear();
      },
      escape = (event: KeyboardEvent) => {
        if (event.key === "Escape") clear();
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
    setCompared("");
    setAck(false);
  }, [review?.id]);
  useEffect(() => {
    const expiry = review?.expiresAt ?? state.invitation?.invitation.expiresAt;
    if (!expiry) return;
    const timer = window.setTimeout(
      () => c.hide(),
      Math.max(0, expiry - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [c, review?.id, state.invitation]);
  const canSetup =
    !!status?.canSetup && status.hasSelectedKey && !status.needsFreshPairing;
  return (
    <section
      className="private-key-panel private-peer-panel"
      aria-label="Other private devices"
    >
      <div className="row">
        <h3>Other private devices</h3>
        <button disabled={state.busy} onClick={() => void c.refresh()}>
          Refresh saved devices
        </button>
      </div>
      <p>
        Compare a device’s public key before trusting it on this Mac. Each
        device reviews the other separately. Saving a key does not grant task or
        app access.
      </p>
      {state.error && <p role="alert">{state.error}</p>}
      {state.notice && <p role="status">{state.notice}</p>}
      {!status ? (
        <p>
          {state.busy
            ? "Checking saved devices…"
            : "Refresh to check saved devices."}
        </p>
      ) : (
        <>
          {!status.available || !status.canSetup ? (
            <p>New device review is off in this development build.</p>
          ) : status.needsFreshPairing ? (
            <p>
              Restored trust needs fresh pairing. Recovery is not available in
              this build yet.
            </p>
          ) : !status.hasSelectedKey ? (
            <p>
              Set up this Mac’s device key first, then refresh saved devices.
            </p>
          ) : null}
          <ul className="private-key-list">
            {status.peers.map((peer) => (
              <li key={peer.peerId}>
                <strong>
                  {peer.revoked ? "Revoked locally" : "Public key saved"} · key{" "}
                  {peer.keyEpoch}
                </strong>
                <p className="private-peer-code">{peer.peerId}</p>
                <p className="private-peer-code">{peer.fingerprint}</p>
                {!peer.revoked && (
                  <button
                    disabled={state.busy}
                    onClick={() => void c.prepare("revoke", peer.peerId)}
                  >
                    Review revocation for {peer.peerId}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {status.peers.length === 0 && <p>No device keys saved here.</p>}
          {canSetup && !review && !state.invitation && (
            <div className="private-peer-forms">
              <label>
                Other device ID
                <input
                  value={recipient}
                  disabled={state.busy}
                  onChange={(e) => {
                    c.hide();
                    setRecipient(e.target.value);
                  }}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <button
                disabled={state.busy || !recipient.trim()}
                onClick={() => void c.invite(recipient)}
              >
                Create invitation for this device
              </button>
              <label>
                Invitation from the other device
                <textarea
                  rows={5}
                  value={incoming}
                  disabled={state.busy}
                  onChange={(e) => {
                    c.hide();
                    setIncoming(e.target.value);
                  }}
                  spellCheck={false}
                />
              </label>
              <button
                disabled={state.busy || !incoming.trim()}
                onClick={() => void c.prepare("approve", incoming)}
              >
                Review incoming invitation
              </button>
            </div>
          )}
        </>
      )}
      {state.invitation && (
        <section
          className="private-key-review"
          aria-label="This Mac’s invitation"
        >
          <h4>This Mac’s invitation</h4>
          <p>
            Share this public invitation with the intended device. Compare the
            full fingerprint below on both trusted screens, or over a separately
            trusted channel. The invitation expires within five minutes.
          </p>
          <label>
            Public invitation
            <textarea
              rows={6}
              readOnly
              value={JSON.stringify(state.invitation.invitation)}
              spellCheck={false}
            />
          </label>
          <p>Full fingerprint</p>
          <p className="private-peer-code">{state.invitation.fingerprint}</p>
          <button onClick={clear}>Hide invitation</button>
        </section>
      )}
      {review && (
        <section
          className="private-key-review"
          aria-label="Review device trust"
        >
          <h4>
            {review.action === "approve"
              ? "Compare the other device"
              : "Revoke device trust on this Mac"}
          </h4>
          <dl>
            {review.binding && (
              <>
                <dt>Account</dt>
                <dd>{review.binding.ownerId}</dd>
                <dt>This Mac</dt>
                <dd>{review.binding.deviceId}</dd>
              </>
            )}
            <dt>Other device</dt>
            <dd>{review.peerId}</dd>
          </dl>
          {review.replaces && (
            <p>
              This replaces saved key {review.replaces.keyEpoch}. Confirm the
              key change directly with the other device.
            </p>
          )}
          <p>Full fingerprint</p>
          <p className="private-peer-code">{review.fingerprint}</p>
          {review.action === "approve" ? (
            <>
              <p>
                Compare all 64 characters with the fingerprint shown by the
                other trusted device. Copying the value from this received
                invitation alone does not verify it.
              </p>
              <label className="private-peer-text-label">
                Fingerprint from the other trusted device
                <input
                  value={compared}
                  onChange={(e) => {
                    setCompared(e.target.value);
                    setAck(false);
                  }}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            </>
          ) : (
            <p>
              This stops trusting the saved public key locally. It does not
              revoke remote permissions or erase copies on another device.
            </p>
          )}
          <label>
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            {review.action === "approve"
              ? "I independently compared the full fingerprint and approve this public key."
              : "I understand this revokes trust on this Mac only."}
          </label>
          <div className="row">
            <button
              disabled={
                state.busy ||
                !ack ||
                (review.action === "approve" &&
                  compared.replace(/\s/g, "").toLowerCase() !==
                    review.fingerprint)
              }
              onClick={() => void c.confirm(ack, compared)}
            >
              {review.action === "approve"
                ? "Save reviewed device key"
                : "Revoke trust locally"}
            </button>
            <button onClick={clear}>Cancel device review</button>
          </div>
        </section>
      )}
    </section>
  );
}
