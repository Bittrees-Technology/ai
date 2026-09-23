import React, { useEffect, useId, useRef, useState } from "react";
import {
  PrivatePermissionPanelState,
  emptyPermissionForm,
  type PermissionChoices,
  type PermissionForm,
} from "./private-permission-state.js";
function Choices({ choices }: { choices: PermissionChoices }) {
  return (
    <ul className="private-permission-summary">
      <li>
        Incoming text tasks:{" "}
        <strong>{choices.receiveTasks ? "Allowed" : "Off"}</strong>
      </li>
      <li>
        Outgoing text tasks:{" "}
        <strong>{choices.sendTasks ? "Allowed" : "Off"}</strong>
      </li>
      <li>
        Acceptance receipts:{" "}
        <strong>{choices.sendReceipts ? "Allowed" : "Off"}</strong>
      </li>
      <li>
        Results for new incoming tasks:{" "}
        <strong>{choices.sendResults ? "Allowed" : "Off"}</strong>
      </li>
    </ul>
  );
}
export function PrivatePermissionPanel({
  api,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
}) {
  const labelId = useId();
  const [, render] = useState(0),
    ref = useRef<PrivatePermissionPanelState | null>(null);
  if (!ref.current)
    ref.current = new PrivatePermissionPanelState(api, () =>
      render((n) => n + 1),
    );
  const c = ref.current,
    state = c.state,
    status = state.status,
    review = state.review;
  const [form, setForm] = useState(emptyPermissionForm),
    [ack, setAck] = useState(false);
  const conceal = () => {
    c.hide();
    setAck(false);
    setForm(emptyPermissionForm());
  };
  const change = (patch: Partial<PermissionForm>) => {
    c.hide();
    setAck(false);
    setForm((v) => ({ ...v, ...patch }));
  };
  useEffect(() => {
    void c.refresh();
    const blur = () => conceal(),
      visibility = () => {
        if (document.hidden) conceal();
      },
      escape = (e: KeyboardEvent) => {
        if (e.key === "Escape") conceal();
      };
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", escape);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", blur);
      window.removeEventListener("keydown", escape);
      document.removeEventListener("visibilitychange", visibility);
      c.hide();
    };
  }, [c]);
  useEffect(() => {
    setAck(false);
    if (!review) return;
    const timer = window.setTimeout(
      () => conceal(),
      Math.max(0, review.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [review?.id]);
  const canSetup =
    status?.available &&
    status.canSetup &&
    status.hasSelectedKey &&
    !status.needsFreshPairing &&
    status.peers.length > 0;
  const valid =
    form.peerId &&
    (form.receiveTasks || form.sendTasks) &&
    (!form.receiveTasks || form.modelProfileId);
  return (
    <section
      className="private-key-panel private-peer-panel private-permission-panel"
      aria-label="Private task permissions"
    >
      <div className="row">
        <h3>Private task permissions</h3>
        <button
          disabled={state.busy}
          onClick={() => {
            setForm(emptyPermissionForm());
            void c.refresh();
          }}
        >
          Refresh saved choices
        </button>
      </div>
      <p>
        Choose what a reviewed device may do. Text tasks do not grant access to
        connected apps, memory, tools or publishing. Private task delivery is
        not active in this build.
      </p>
      <p>
        Complete a check in Verify a private device before reviewing new
        permissions. Each device checks the other separately.
      </p>
      {state.error && <p role="alert">{state.error}</p>}
      {state.notice && <p role="status">{state.notice}</p>}
      {!status ? (
        <p>
          {state.busy
            ? "Checking saved choices…"
            : "Refresh to check saved choices."}
        </p>
      ) : (
        <>
          {!status.available || !status.canSetup ? (
            <p>
              New permissions are off in this development build. Saved
              permissions can still be revoked when these controls are
              available.
            </p>
          ) : status.needsFreshPairing ? (
            <p>
              Restored keys need fresh pairing before new permissions can be
              reviewed.
            </p>
          ) : !status.hasSelectedKey || !status.peers.length ? (
            <p>
              Set up this Mac’s key and review the other device first, then
              refresh saved choices.
            </p>
          ) : null}
          <ul className="private-key-list">
            {status.grants.map((g) => (
              <li key={g.id}>
                <strong>
                  {g.state === "revoked"
                    ? "Revoked locally"
                    : g.state === "expired"
                      ? "Expired"
                      : g.state === "needs-review"
                        ? "Fresh review required"
                        : "Choices saved; connection not checked"}
                </strong>
                <p className="private-peer-code">{g.choices.peerId}</p>
                <Choices choices={g.choices} />
                <p>Expires {new Date(g.choices.expiresAt).toLocaleString()}</p>
                {g.state !== "revoked" && (
                  <button
                    disabled={state.busy}
                    onClick={() => void c.revoke(g.choices.peerId)}
                  >
                    Review permission revocation for {g.choices.peerId}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {status.grants.length === 0 && (
            <p>No private task permissions saved.</p>
          )}
          {canSetup && !review && (
            <fieldset disabled={state.busy} className="private-permission-form">
              <legend>Choose permissions for one device</legend>
              <label className="private-peer-text-label">
                <span id={`${labelId}-device`}>Reviewed device</span>
                <select
                  aria-labelledby={`${labelId}-device`}
                  value={form.peerId}
                  onChange={(e) => change({ peerId: e.target.value })}
                >
                  <option value="">Choose a device</option>
                  {status.peers.map((p) => (
                    <option key={p.peerId} value={p.peerId}>
                      {p.peerId}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={form.receiveTasks}
                  onChange={(e) =>
                    change(
                      e.target.checked
                        ? { receiveTasks: true }
                        : {
                            receiveTasks: false,
                            sendReceipts: false,
                            sendResults: false,
                            modelProfileId: null,
                          },
                    )
                  }
                />
                Allow this device to submit text tasks to this Mac
              </label>
              {form.receiveTasks && (
                <label className="private-peer-text-label">
                  <span id={`${labelId}-model`}>
                    Local model for incoming tasks
                  </span>
                  <select
                    aria-labelledby={`${labelId}-model`}
                    value={form.modelProfileId ?? ""}
                    onChange={(e) =>
                      change({ modelProfileId: e.target.value || null })
                    }
                  >
                    <option value="">Choose a local model</option>
                    {status.profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.model} ({p.id})
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={form.sendTasks}
                  onChange={(e) => change({ sendTasks: e.target.checked })}
                />
                Allow this Mac to send text tasks to this device
              </label>
              <label>
                <input
                  type="checkbox"
                  disabled={!form.receiveTasks}
                  checked={form.sendReceipts}
                  onChange={(e) =>
                    change(
                      e.target.checked
                        ? { sendReceipts: true }
                        : { sendReceipts: false, sendResults: false },
                    )
                  }
                />
                Return acceptance receipts for new incoming tasks
              </label>
              <label>
                <input
                  type="checkbox"
                  disabled={!form.receiveTasks || !form.sendReceipts}
                  checked={form.sendResults}
                  onChange={(e) => change({ sendResults: e.target.checked })}
                />
                Share results for new incoming tasks
              </label>
              <p>
                Receipts require incoming tasks. Results include a receipt and
                require both choices. Changing a permission does not release
                results from older tasks.
              </p>
              <label className="private-peer-text-label">
                <span id={`${labelId}-duration`}>Permission duration</span>
                <select
                  aria-labelledby={`${labelId}-duration`}
                  value={form.minutes}
                  onChange={(e) =>
                    change({ minutes: Number(e.target.value) as 15 | 60 })
                  }
                >
                  <option value={15}>15 minutes</option>
                  <option value={60}>1 hour</option>
                </select>
              </label>
              <p>
                The paired-device connection may expire sooner. The review shows
                the exact expiry.
              </p>
              <button disabled={!valid} onClick={() => void c.prepare(form)}>
                Review permission choices
              </button>
            </fieldset>
          )}
        </>
      )}
      {review && (
        <section
          className="private-key-review"
          aria-label="Review task permission change"
        >
          <h4>
            {review.action === "grant"
              ? "Review permission choices"
              : "Revoke task permissions on this Mac"}
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
          {review.choices ? (
            <>
              <Choices choices={review.choices} />
              {review.model && <p>Local model: {review.model}</p>}
              <p>
                Permission expires{" "}
                {new Date(review.choices.expiresAt).toLocaleString()}
              </p>
              <p className="private-peer-code">
                Reviewed fingerprint: {review.fingerprint}
              </p>
              <p>
                These choices apply to new tasks only. They do not allow
                connected-app access, memories, tools or publishing. Saving them
                does not start delivery.
              </p>
            </>
          ) : (
            <p>
              Stop future task admission and further sending under this
              permission. Already accepted local work continues unless you
              cancel it separately. Prior copies and exports are unchanged.
            </p>
          )}
          <label>
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            {review.action === "grant"
              ? "I approve exactly these choices, this device and this expiry."
              : "I understand the limits of revoking this permission."}
          </label>
          <div className="row">
            <button
              disabled={state.busy || !ack}
              onClick={async () => {
                await c.confirm(ack);
                setForm(emptyPermissionForm());
              }}
            >
              {review.action === "grant"
                ? "Save permission choices"
                : "Revoke task permissions"}
            </button>
            <button onClick={conceal}>Cancel permission review</button>
          </div>
        </section>
      )}
    </section>
  );
}
