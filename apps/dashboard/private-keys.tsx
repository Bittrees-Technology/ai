import React, { useEffect, useRef, useState } from "react";
import { PrivateKeyPanelState, type KeyAction } from "./private-key-state.js";
const labels: Record<KeyAction, string> = {
  create: "Set up device key",
  replace: "Replace device key",
  resume: "Finish key setup",
  remove: "Remove key",
  revoke: "Disable key locally",
  cleanup: "Retry key cleanup",
};
const descriptions: Record<KeyAction, string> = {
  create:
    "Create a key in this Mac’s Keychain. This does not pair a browser or enable private tasks.",
  replace:
    "Stop using the selected key and create a new one. The previous key stays on this Mac until you remove it; other devices must review the new key.",
  resume:
    "Finish the saved setup attempt using its original key. A missing key will not be silently replaced.",
  remove:
    "Disable this key and remove its secret from this Mac. History encrypted to it may become unreadable. This does not revoke a remote device or delete remote copies.",
  revoke:
    "Stop using this key locally while retaining it in Keychain. This does not confirm remote revocation.",
  cleanup:
    "Retry previously requested key removal. Cleanup can run even when the remote connection has expired.",
};
export function PrivateKeyPanel({
  api,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
}) {
  const mounted = useRef(false);
  const [controller] = useState(
    () =>
      new PrivateKeyPanelState(api, (s) => {
        if (mounted.current) setState({ ...s });
      }),
  );
  const [state, setState] = useState(controller.state),
    [ack, setAck] = useState(false);
  useEffect(() => {
    mounted.current = true;
    void controller.refresh();
    const hide = () => {
      controller.hide();
      setAck(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("keydown", escape);
    return () => {
      mounted.current = false;
      controller.hide();
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("keydown", escape);
    };
  }, [controller]);
  useEffect(() => {
    setAck(false);
    if (!state.review) return;
    const timer = setTimeout(
      () => controller.hide(),
      Math.max(0, state.review.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [state.review, controller]);
  const status = state.status,
    selected = status?.state.slots.find(
      (v) => v.state === "active" || v.state === "preparing",
    );
  const prepare = (action: KeyAction, keyId?: string) => {
    setAck(false);
    void controller.prepare(action, keyId);
  };
  return (
    <article
      className="remote-panel private-key-panel"
      aria-labelledby="private-key-title"
    >
      <div className="row">
        <h3 id="private-key-title">This Mac’s private key</h3>
        <button disabled={state.busy} onClick={() => void controller.refresh()}>
          Refresh saved keys
        </button>
      </div>
      <p>
        A device key protects private messages between paired devices. A saved
        key alone does not enable private task access.
      </p>
      {state.error && <p role="alert">{state.error}</p>}
      {state.notice && <p role="status">{state.notice}</p>}
      {!status ? (
        <p>
          {state.busy
            ? "Checking saved keys…"
            : "Refresh to check this Mac’s saved keys."}
        </p>
      ) : (
        <>
          {!status.available ? (
            <p>
              Key management is unavailable in this build. Use a reviewed
              packaged Mac build for native key access.
            </p>
          ) : !status.canSetup ? (
            <p>
              New key setup is off in this development build. Existing keys can
              still be disabled or removed.
            </p>
          ) : null}
          <p>
            <strong>
              {selected?.state === "active"
                ? "Device key saved"
                : selected?.state === "preparing"
                  ? "Key setup needs attention"
                  : "No selected device key"}
            </strong>
          </p>
          {status.state.needsFreshPairing && (
            <p>
              Restored or deleted key records require fresh pairing. This build
              cannot complete that recovery yet.
            </p>
          )}
          {status.canSetup && !status.state.needsFreshPairing && (
            <div className="row">
              <button
                disabled={state.busy || !!status.state.pendingKeyDeletionCount}
                onClick={() => prepare(selected ? "replace" : "create")}
              >
                {labels[selected ? "replace" : "create"]}
              </button>
              {selected?.state === "preparing" && (
                <button
                  disabled={state.busy}
                  onClick={() => prepare("resume", selected.id)}
                >
                  Finish key setup
                </button>
              )}
            </div>
          )}
          {status.state.pendingKeyDeletionCount > 0 && (
            <div>
              <p>
                {status.state.pendingKeyDeletionCount} key removal{" "}
                {status.state.pendingKeyDeletionCount === 1 ? "needs" : "need"}{" "}
                cleanup.
              </p>
              <button
                disabled={state.busy || !status.available}
                onClick={() => prepare("cleanup")}
              >
                Retry key cleanup
              </button>
            </div>
          )}
          <ul className="private-key-list">
            {status.state.slots
              .filter((v) => v.state !== "deleted")
              .map((slot) => (
                <li key={slot.id}>
                  <div>
                    <strong>Key {slot.keyEpoch}</strong>
                    <span>
                      {" "}
                      —{" "}
                      {(
                        {
                          active: "Saved",
                          preparing: "Setup unfinished",
                          retired: "Disabled locally",
                          deleting: "Removal unfinished",
                        } as Record<string, string>
                      )[slot.state] ?? "Needs review"}
                    </span>
                  </div>
                  <div className="row">
                    {["active", "preparing"].includes(slot.state) && (
                      <button
                        disabled={state.busy || !status.available}
                        onClick={() => prepare("revoke", slot.id)}
                      >
                        Disable key {slot.keyEpoch} locally
                      </button>
                    )}
                    <button
                      disabled={state.busy || !status.available}
                      onClick={() => prepare("remove", slot.id)}
                    >
                      Remove key {slot.keyEpoch}
                    </button>
                  </div>
                </li>
              ))}
          </ul>
        </>
      )}
      {state.review && (
        <section className="private-key-review" aria-label="Review key change">
          <h4>{labels[state.review.action]}</h4>
          <p>{descriptions[state.review.action]}</p>
          {state.review.binding && (
            <dl>
              <dt>Account</dt>
              <dd>{state.review.binding.ownerId}</dd>
              <dt>Device</dt>
              <dd>{state.review.binding.deviceId}</dd>
            </dl>
          )}
          <p>
            Recovery for these device keys is not available yet. The existing
            storage recovery kit does not include these keys.
          </p>
          <label>
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />{" "}
            I understand this change and the recovery limits.
          </label>
          <div className="row">
            <button
              disabled={state.busy || !ack}
              onClick={() => void controller.confirm(ack)}
            >
              Confirm {labels[state.review.action].toLowerCase()}
            </button>
            <button
              disabled={state.busy}
              onClick={() => {
                controller.hide();
                setAck(false);
              }}
            >
              Cancel key review
            </button>
          </div>
        </section>
      )}
    </article>
  );
}
