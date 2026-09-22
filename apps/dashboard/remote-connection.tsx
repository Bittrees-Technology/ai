import React, { useEffect, useRef, useState } from "react";
import { RemotePanelState } from "./remote-state.js";
type Api = (
  path: string,
  method?: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<any>;
export function RemoteConnectionPanel({ api }: { api: Api }) {
  const mounted = useRef(false);
  const [controller] = useState(
    () =>
      new RemotePanelState(api, (s) => {
        if (mounted.current) setState({ ...s });
      }),
  );
  const [state, setState] = useState(controller.state);
  const [account, setAccount] = useState("");
  const [controlConfirmed, setControlConfirmed] = useState(false);
  const [removeConfirmed, setRemoveConfirmed] = useState(false);
  useEffect(() => {
    mounted.current = true;
    void controller.refresh();
    const hide = () => {
      controller.hide();
      setAccount("");
      setRemoveConfirmed(false);
      setControlConfirmed(false);
    };
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", hide);
    return () => {
      mounted.current = false;
      controller.hide();
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [controller]);
  useEffect(() => {
    if (!state.pending) return;
    const timer = setTimeout(
      () => controller.hide(),
      Math.max(0, state.pending.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [state.pending, controller]);
  const paired = state.connection?.state === "paired";
  return (
    <article className="remote-panel" aria-labelledby="remote-title">
      <div className="row">
        <h3 id="remote-title">Remote task status</h3>
        <button disabled={state.busy} onClick={() => void controller.refresh()}>
          Refresh connection
        </button>
      </div>
      <p>
        Choose which task statuses you share with ai.bittrees.org. Prompts,
        results, task names and memory stay on this Mac. Sharing is manual.
      </p>
      {state.error && <p role="alert">{state.error}</p>}
      {state.notice && <p role="status">{state.notice}</p>}
      {state.available === null ? (
        <p>Checking this Mac’s connection…</p>
      ) : !state.available ? (
        <p>
          <strong>Remote access is off.</strong> This development app has not
          enabled remote pairing. Local tasks continue to work.
        </p>
      ) : (
        <>
          <p>
            <strong>
              {!state.connection
                ? "Not paired"
                : paired
                  ? "This Mac is paired"
                  : "Pairing needs attention"}
            </strong>
            {state.connection && (
              <>
                {" "}
                · Access expires{" "}
                {new Date(state.connection.expiresAt).toLocaleString()}
              </>
            )}
          </p>
          <p>
            <a href="https://ai.bittrees.org" target="_blank" rel="noreferrer">
              Manage remote access on ai.bittrees.org
            </a>
          </p>
          {!state.connection && (
            <>
              <p>
                Start pairing to request a five-minute code. Approve it in your
                remote account, then return with the account confirmation code.
                Pairing alone does not share task statuses.
              </p>
              <button
                disabled={state.busy}
                onClick={() => void controller.begin()}
              >
                Start pairing
              </button>
              {state.pending && (
                <div className="remote-pairing">
                  <label htmlFor="remote-pairing-code">
                    Pairing details to copy to your remote account
                  </label>
                  <textarea
                    id="remote-pairing-code"
                    readOnly
                    rows={3}
                    value={`${state.pending.id}.${state.pending.approvalCode}`}
                  />
                  <p>
                    Expires at{" "}
                    {new Date(state.pending.expiresAt).toLocaleTimeString()}.
                    Copy these details before leaving this window; they clear
                    when it loses focus.
                  </p>
                </div>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const value = account;
                  setAccount("");
                  void controller.finish(value);
                }}
              >
                <label htmlFor="remote-account">
                  Account confirmation code from your approval
                </label>
                <input
                  id="remote-account"
                  autoComplete="off"
                  spellCheck={false}
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                  maxLength={36}
                />
                <p>
                  Confirm that the account shown on ai.bittrees.org is yours
                  before saving this connection.
                </p>
                <button
                  disabled={
                    state.busy || !/^[0-9a-fA-F-]{36}$/.test(account.trim())
                  }
                >
                  Confirm account and pair this Mac
                </button>
              </form>
            </>
          )}
          {paired && (
            <>
              <fieldset disabled={state.busy}>
                <legend>Remote pause and cancel</legend>
                <p>
                  Permission:{" "}
                  {state.connection?.controls?.replaceAll("_", " ") ||
                    "unavailable"}
                  . This permission lets your remote account pause or cancel
                  shared tasks. It cannot start tasks or read their content.
                </p>
                <p>
                  First approve pause/cancel for this device on ai.bittrees.org,
                  then enable it here within five minutes. Commands are received
                  only when you choose “Check for commands”; background
                  receiving is not active yet.
                </p>
                {state.connection?.controls === "disabled" && (
                  <>
                    <label className="remote-task">
                      <input
                        type="checkbox"
                        checked={controlConfirmed}
                        onChange={(e) => setControlConfirmed(e.target.checked)}
                      />
                      <span>
                        I approved this device in my remote account and allow
                        pause/cancel on this Mac.
                      </span>
                    </label>
                    <button
                      disabled={!controlConfirmed}
                      onClick={() => {
                        setControlConfirmed(false);
                        void controller.controls("enable", true);
                      }}
                    >
                      Enable remote pause/cancel
                    </button>
                  </>
                )}
                {state.connection?.controls === "enabled" && (
                  <button
                    onClick={() => void controller.controls("check", true)}
                  >
                    Check for commands
                  </button>
                )}
                {["enabled", "confirmation_required"].includes(
                  state.connection?.controls || "",
                ) && (
                  <button
                    onClick={() => void controller.controls("disable", true)}
                  >
                    Disable remote pause/cancel
                  </button>
                )}
                {state.connection?.controls === "confirmation_required" && (
                  <p>
                    Permission needs attention. Disable it first, then approve
                    and enable it again.
                  </p>
                )}
              </fieldset>
              {state.connection?.pendingDelivery ? (
                <div>
                  <p>
                    A previous status delivery is waiting for confirmation.
                    Retrying sends the same saved status batch.
                  </p>
                  <button
                    disabled={state.busy}
                    onClick={() => void controller.retry()}
                  >
                    Retry previous delivery
                  </button>
                </div>
              ) : (
                <>
                  <button
                    disabled={state.busy}
                    onClick={() => void controller.loadTasks()}
                  >
                    Choose recent tasks
                  </button>
                  {state.tasksLoaded && !state.tasks.length && (
                    <p>No recent tasks are available to share.</p>
                  )}
                  {state.tasks.length > 0 && (
                    <fieldset disabled={state.busy}>
                      <legend>Review task statuses to share</legend>
                      <p>
                        The descriptions below are for your local review. Only
                        task and device identifiers, state, revision and update
                        time are sent.
                      </p>
                      {state.tasks.map((task) => (
                        <label className="remote-task" key={task.id}>
                          <input
                            type="checkbox"
                            checked={state.selected.includes(task.id)}
                            onChange={() => controller.select(task.id)}
                          />
                          <span>
                            {task.input.prompt?.slice(0, 100) || "Source task"}
                            <small>{task.status.replaceAll("_", " ")}</small>
                          </span>
                        </label>
                      ))}
                      <label className="remote-task">
                        <input
                          type="checkbox"
                          checked={state.reviewed}
                          onChange={(e) => controller.review(e.target.checked)}
                        />
                        <span>
                          Share status for these {state.selected.length}{" "}
                          selected tasks.
                        </span>
                      </label>
                      <button
                        disabled={!state.reviewed || !state.selected.length}
                        onClick={() => void controller.publish()}
                      >
                        Share selected statuses
                      </button>
                    </fieldset>
                  )}
                </>
              )}
              <p>
                Replace the connection key if needed. This does not extend its
                approved access period.
              </p>
              <button
                disabled={state.busy || state.connection?.pendingDelivery}
                onClick={() => void controller.rotate()}
              >
                Replace connection key
              </button>
            </>
          )}
          {state.connection && (
            <div className="remote-removal">
              <p>
                Removing this connection clears this Mac’s saved key and unsent
                status. It does not revoke the remote device or remove status
                already delivered.
              </p>
              <label className="remote-task">
                <input
                  type="checkbox"
                  disabled={state.busy}
                  checked={removeConfirmed}
                  onChange={(e) => setRemoveConfirmed(e.target.checked)}
                />
                <span>
                  I understand remote revocation is a separate action on
                  ai.bittrees.org.
                </span>
              </label>
              <button
                disabled={state.busy || !removeConfirmed}
                onClick={() => {
                  setRemoveConfirmed(false);
                  void controller.forget();
                }}
              >
                Remove connection from this Mac
              </button>
            </div>
          )}
        </>
      )}
    </article>
  );
}
