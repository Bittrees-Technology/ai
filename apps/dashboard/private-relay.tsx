import { PrivateTaskDeliveryPanel } from "./private-task-delivery.js";
import React, { useEffect, useRef, useState } from "react";
import {
  PrivateRelayPanelState,
  type RelayAction,
  type RelayRecord,
} from "./private-relay-state.js";
const labels: Record<RelayAction, string> = {
  accept: "Save connection",
  stop: "Stop on this Mac",
  reconcile: "Check remote permission",
  revoke: "Revoke remote permission",
  remove: "Remove saved credential",
  cleanup: "Check requested cleanup",
};
const descriptions: Record<RelayAction, string> = {
  accept:
    "Save a separate credential in this Mac’s Keychain for the approval below. This does not enable automatic message delivery or permission to run tasks.",
  stop: "Stop using this connection on this Mac and keep its credential for possible remote revocation. This works without a network connection.",
  reconcile:
    "Check the current permission at ai.bittrees.org. An interrupted, stopped or restored connection stays disabled after this check.",
  revoke:
    "Stop this connection on the Mac, then ask ai.bittrees.org to revoke its permission. If the response is lost, the Mac stays stopped and remote revocation remains unconfirmed until checked again.",
  remove:
    "Stop this connection and remove its credential from this Mac. Remote permission, encrypted message history and other devices are unchanged. Revoke remotely first if you want that permission removed too.",
  cleanup:
    "Check up to 20 records where local credential removal was already requested. Continue with the next batch if one remains. This does not revoke remote permissions.",
};
function recordLabel(r: RelayRecord) {
  if (r.permission?.state === "revoked") return "Remote permission revoked";
  if (r.phase === "deleted") return "Credential removed locally";
  if (r.phase === "deleting") return "Credential cleanup needed";
  if (r.locked || r.phase === "stopped") return "Stopped on this Mac";
  if (r.phase !== "active") return "Connection setup needs attention";
  if (r.permission && r.permission.expiresAt <= Date.now())
    return "Saved permission expired";
  return "Connection saved on this Mac";
}
export function PrivateRelayPanel({
  api,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
}) {
  const mounted = useRef(false);
  const [controller] = useState(
    () =>
      new PrivateRelayPanelState(api, (s) => {
        if (mounted.current) setState({ ...s });
      }),
  );
  const [state, setState] = useState(controller.state),
    [approval, setApproval] = useState(""),
    [ack, setAck] = useState(false),
    [deliveryOpen, setDeliveryOpen] = useState(false);
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
    const timeout = setTimeout(
      () => controller.hide(),
      Math.max(0, state.review.expiresAt - Date.now()),
    );
    return () => clearTimeout(timeout);
  }, [state.review, controller]);
  const status = state.status;
  const prepare = (action: RelayAction, record?: RelayRecord) => {
    setAck(false);
    void controller.prepare(action, record, approval);
  };
  return (
    <article
      className="remote-panel private-relay-panel"
      aria-labelledby="private-relay-title"
    >
      <div className="row">
        <h3 id="private-relay-title">Private message connection</h3>
        <button disabled={state.busy} onClick={() => void controller.refresh()}>
          Refresh saved connections
        </button>
      </div>
      <p>
        This Mac uses its own permission to exchange encrypted messages through
        ai.bittrees.org. Its local AI runs separately from the Acer news server.
      </p>
      <p>
        Automatic message delivery is not enabled in this build. Device keys,
        paired browsers and permission to run tasks are separate settings.
      </p>
      {state.error && <p role="alert">{state.error}</p>}
      {state.notice && <p role="status">{state.notice}</p>}
      {!status ? (
        <p>
          {state.busy
            ? "Checking saved connections…"
            : "Refresh to check this Mac’s saved connections."}
        </p>
      ) : (
        <>
          {!status.available ? (
            <p>
              Native credential controls are unavailable in this build. Use a
              reviewed packaged Mac build to manage saved credentials.
            </p>
          ) : !status.canSetup ? (
            <p>
              New connection setup is off in this development build. Existing
              connections can still be stopped or removed.
            </p>
          ) : (
            <div className="private-relay-approval">
              <label htmlFor="relay-approval">
                Approval ID from ai.bittrees.org
              </label>
              <input
                id="relay-approval"
                value={approval}
                maxLength={36}
                onChange={(e) => {
                  setApproval(e.target.value);
                  if (state.review) controller.hide();
                }}
                placeholder="Paste the approval ID for this Mac"
                disabled={state.busy}
              />
              <button
                disabled={
                  state.busy || !/^[0-9a-f-]{36}$/i.test(approval.trim())
                }
                onClick={() => prepare("accept")}
              >
                Review connection approval
              </button>
            </div>
          )}
          {status.state.items.length === 0 && (
            <p>No private message connection is saved on this Mac.</p>
          )}
          <div className="private-relay-records">
            {status.state.items.map((record, index) => (
              <section
                key={record.id}
                aria-label={`Saved connection ${index + 1}`}
              >
                <h4>{recordLabel(record)}</h4>
                {["accepting", "storing"].includes(record.phase) && (
                  <p>
                    Setup was interrupted. Check the remote permission; this
                    record cannot become active automatically. Revoke the old
                    permission before creating a new approval.
                  </p>
                )}
                <details>
                  <summary>Connection details</summary>
                  <dl>
                    <dt>Local record</dt>
                    <dd>{record.id}</dd>
                    {record.permission && (
                      <>
                        <dt>Permission</dt>
                        <dd>{record.permission.id}</dd>
                        <dt>Expires</dt>
                        <dd>
                          {new Date(
                            record.permission.expiresAt,
                          ).toLocaleString()}
                        </dd>
                        <dt>Mac registration</dt>
                        <dd>{record.permission.endpointId}</dd>
                      </>
                    )}
                  </dl>
                </details>
                {status.available && (
                  <div className="row">
                    {!["deleting", "deleted"].includes(record.phase) && (
                      <>
                        <button
                          disabled={state.busy || !status.canCheckRemote}
                          onClick={() => prepare("reconcile", record)}
                        >
                          Check remote permission
                        </button>
                        {!record.locked && (
                          <button
                            disabled={state.busy}
                            onClick={() => prepare("stop", record)}
                          >
                            Stop on this Mac
                          </button>
                        )}
                        <button
                          disabled={state.busy || !status.canCheckRemote}
                          onClick={() => prepare("revoke", record)}
                        >
                          Revoke remote permission
                        </button>
                        <button
                          disabled={state.busy}
                          onClick={() => prepare("remove", record)}
                        >
                          Remove saved credential
                        </button>
                      </>
                    )}
                  </div>
                )}
              </section>
            ))}
          </div>
          {status.available &&
            status.state.items.some((r) =>
              ["deleting", "deleted"].includes(r.phase),
            ) && (
              <button disabled={state.busy} onClick={() => prepare("cleanup")}>
                {state.cleanupAfter
                  ? "Check next cleanup batch"
                  : "Check requested cleanup"}
              </button>
            )}
        </>
      )}
      {state.review && (
        <section
          className="private-relay-review"
          role="region"
          aria-label="Review connection change"
        >
          <h4>{labels[state.review.action]}</h4>
          <p>{descriptions[state.review.action]}</p>
          {state.review.permission && (
            <dl>
              <dt>Permission</dt>
              <dd>{state.review.permission.id}</dd>
              <dt>Mac registration</dt>
              <dd>{state.review.permission.endpointId}</dd>
              <dt>Owner</dt>
              <dd>{state.review.permission.ownerId}</dd>
              <dt>Permission expires</dt>
              <dd>
                {new Date(state.review.permission.expiresAt).toLocaleString()}
              </dd>
            </dl>
          )}
          <label>
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />{" "}
            I reviewed this connection and understand what will change.
          </label>
          <div className="row">
            <button
              disabled={!ack || state.busy}
              onClick={() => void controller.confirm(ack)}
            >
              Confirm {labels[state.review.action].toLowerCase()}
            </button>
            <button
              onClick={() => {
                controller.hide();
                setAck(false);
              }}
            >
              Cancel review
            </button>
          </div>
        </section>
      )}
      {status?.available && !deliveryOpen && (
        <button
          disabled={state.busy || !!state.review}
          onClick={() => setDeliveryOpen(true)}
        >
          Open private task delivery
        </button>
      )}
      {deliveryOpen && (
        <PrivateTaskDeliveryPanel
          api={api}
          onClose={() => setDeliveryOpen(false)}
        />
      )}
    </article>
  );
}
