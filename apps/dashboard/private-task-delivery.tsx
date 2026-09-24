import React, { useEffect, useRef, useState } from "react";
import {
  PrivateTaskDeliveryState,
  deliveryLabels,
  deliveryDescriptions,
  type DeliveryAction,
} from "./private-task-delivery-state.js";
export function PrivateTaskDeliveryPanel({
  api,
  onClose,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
  onClose: () => void;
}) {
  const mounted = useRef(false),
    [, render] = useState(0);
  const [controller] = useState(
    () =>
      new PrivateTaskDeliveryState(api, () => {
        if (mounted.current) render((n) => n + 1);
      }),
  );
  const [connection, setConnection] = useState(""),
    [ack, setAck] = useState(false);
  const s = controller.state,
    review = s.review,
    active = controller.activeConnections();
  const hide = () => {
    controller.hide();
    setAck(false);
    setConnection("");
  };
  useEffect(() => {
    mounted.current = true;
    void controller.refresh();
    const blur = () => hide(),
      visibility = () => {
        if (document.hidden) hide();
      },
      escape = (e: KeyboardEvent) => {
        if (e.key === "Escape") hide();
      };
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("keydown", escape);
    return () => {
      mounted.current = false;
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("keydown", escape);
      controller.hide();
    };
  }, [controller]);
  useEffect(() => {
    setAck(false);
    if (!review) return;
    const timer = setTimeout(hide, Math.max(0, review.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [review]);
  const selected = active.some((r) => r.id === connection) ? connection : "";
  const prepare = (action: DeliveryAction, targetId?: string) => {
    setAck(false);
    void controller.prepare(action, selected, targetId);
  };
  return (
    <section
      className="private-task-delivery"
      aria-label="Private task delivery"
    >
      <div className="row">
        <h4>Private task delivery</h4>
        <button onClick={onClose}>Close task delivery</button>
      </div>
      <p>
        Check and send one message at a time. Task permissions and this Mac’s
        local model remain separate. Acer news processing is unchanged.
      </p>
      <button disabled={s.busy} onClick={() => void controller.refresh()}>
        Refresh private task history
      </button>
      <p role="status">{s.notice}</p>
      <p role="alert">{s.error}</p>
      {s.snapshot && !review && (
        <>
          {!s.snapshot.tasks.enabled && (
            <p>
              Private task dispatch is disabled on this Mac. Saved history and
              stopping reply retries remain available.
            </p>
          )}
          <label>
            Connection for private delivery
            <select
              value={selected}
              disabled={s.busy}
              onChange={(e) => setConnection(e.target.value)}
            >
              <option value="">Choose an active connection</option>
              {active.map((r) => (
                <option key={r.id} value={r.id}>
                  Mac {r.binding!.deviceId} · connection {r.id}
                </option>
              ))}
            </select>
          </label>
          {!active.length && (
            <p>
              No active connection is available. Review the saved connection and
              separate task permissions before delivery.
            </p>
          )}
          <button
            disabled={s.busy || !selected}
            onClick={() => prepare("check")}
          >
            Review checking for a task
          </button>
          <h4>Tasks accepted on this Mac</h4>
          <p>
            This is saved acceptance history, not current permission or
            completed work.
          </p>
          {!s.snapshot.tasks.acceptedTasks.length && (
            <p>No private tasks have been accepted locally.</p>
          )}
          <ul aria-label="Accepted private tasks">
            {s.snapshot.tasks.acceptedTasks.map((t) => (
              <li key={t.operationId}>
                <p>Task {t.taskId}</p>
                <p className="private-delivery-identifier">
                  Browser {t.peerId}. Operation {t.operationId}.
                </p>
                <p>Accepted {new Date(t.acceptedAt).toLocaleString()}</p>
                <button
                  disabled={s.busy || !selected}
                  onClick={() => prepare("accepted", t.operationId)}
                >
                  Review acceptance reply
                </button>
                <button
                  disabled={s.busy || !selected}
                  onClick={() => prepare("result", t.operationId)}
                >
                  Review result preparation
                </button>
              </li>
            ))}
          </ul>
          <h4>Saved encrypted replies</h4>
          {!s.snapshot.tasks.responses.length && (
            <p>
              No reply has been prepared. Preparing a reply will not send it.
            </p>
          )}
          <ul aria-label="Saved private replies">
            {s.snapshot.tasks.responses.map((r) => (
              <li key={r.id}>
                <p>
                  {r.kind === "accepted" ? "Acceptance" : "Result"} ·{" "}
                  {r.state === "stopped"
                    ? "Retries stopped"
                    : r.locked
                      ? "Saved record locked"
                      : r.state === "preparing"
                        ? "Preparation incomplete"
                        : "Prepared for delivery"}
                </p>
                <p className="private-delivery-identifier">
                  Reply {r.id}. Operation {r.operationId}. Browser {r.peerId}.
                </p>
                <p>
                  Version {r.revision}. Sending attempts {r.attempts}. Delivery
                  deadline {new Date(r.expiresAt).toLocaleString()}.
                </p>
                <p>
                  {r.delivery
                    ? `Last relay confirmation: ${r.delivery.state === "stored" ? "stored for delivery" : r.delivery.state === "received" ? "destination acknowledged delivery" : "message removed"}. Recorded ${new Date(r.delivery.observedAt).toLocaleString()}. Browser authentication or reading is not confirmed.`
                    : "No relay acknowledgement is saved."}
                  {r.attempts > (r.delivery?.attempt ?? 0) &&
                    " The latest sending attempt is unconfirmed. Review before retrying the original reply."}
                </p>
                {r.state === "pending" && !r.locked && (
                  <button
                    disabled={s.busy || !selected || r.expiresAt <= Date.now()}
                    onClick={() => prepare("send", r.id)}
                  >
                    Review sending this reply
                  </button>
                )}
                {r.state !== "stopped" && (
                  <button
                    disabled={s.busy}
                    onClick={() => prepare("stop", r.id)}
                  >
                    Review stopping this reply
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {review && (
        <section
          className="private-relay-review"
          aria-label="Review private task delivery"
        >
          <h4>{deliveryLabels[review.action]}</h4>
          <p>{deliveryDescriptions[review.action]}</p>
          <dl>
            {review.connection && (
              <>
                <dt>Account</dt>
                <dd>{review.connection.binding!.ownerId}</dd>
                <dt>Mac</dt>
                <dd>{review.connection.binding!.deviceId}</dd>
                <dt>Connection</dt>
                <dd>
                  {review.connection.id}, version {review.connection.revision}
                </dd>
              </>
            )}
            {review.accepted && (
              <>
                <dt>Task</dt>
                <dd>{review.accepted.taskId}</dd>
                <dt>Operation</dt>
                <dd>{review.accepted.operationId}</dd>
                <dt>Browser</dt>
                <dd>{review.accepted.peerId}</dd>
              </>
            )}
            {review.response && (
              <>
                <dt>Reply</dt>
                <dd>
                  {review.response.id}, version {review.response.revision}
                </dd>
                <dt>Operation</dt>
                <dd>{review.response.operationId}</dd>
                <dt>Browser</dt>
                <dd>{review.response.peerId}</dd>
                <dt>Delivery deadline</dt>
                <dd>{new Date(review.response.expiresAt).toLocaleString()}</dd>
              </>
            )}
            <dt>Review expires</dt>
            <dd>{new Date(review.expiresAt).toLocaleString()}</dd>
          </dl>
          <label className="private-delivery-ack">
            <input
              type="checkbox"
              checked={ack}
              disabled={s.busy}
              onChange={(e) => setAck(e.target.checked)}
            />
            I reviewed this exact task delivery action.
          </label>
          <div className="row">
            <button
              disabled={s.busy || !ack}
              onClick={() => void controller.confirm(ack)}
            >
              Confirm {deliveryLabels[review.action].toLowerCase()}
            </button>
            <button disabled={s.busy} onClick={hide}>
              Cancel task delivery review
            </button>
          </div>
        </section>
      )}
    </section>
  );
}
