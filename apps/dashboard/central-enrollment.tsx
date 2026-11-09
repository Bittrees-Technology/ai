import React, { useEffect, useRef, useState } from "react";
import type { CentralEnrollmentStatus } from "../../modules/workflows/central-enrollment-contract.js";

type View = {
  available: boolean;
  ready?: boolean;
  state?: CentralEnrollmentStatus["state"];
  originalReviewExpired?: boolean;
};
type NativeReview = { postMessage: (body: null) => Promise<boolean> };
const connection = "/v1/workflows/central/connection";

export function CentralEnrollment({
  api,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
}) {
  const [view, setView] = useState<View>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [rolesOpened, setRolesOpened] = useState(false);
  const active = useRef(false);
  const inFlight = useRef(false);
  const nativeReview = (
    window as Window & {
      webkit?: {
        messageHandlers?: { reviewWorkflowEnrollment?: NativeReview };
      };
    }
  ).webkit?.messageHandlers?.reviewWorkflowEnrollment;
  useEffect(() => {
    active.current = true;
    void api(connection).then(
      (result) => {
        if (active.current) setView(result);
      },
      () => {
        if (active.current) setError("Could not check the Mac connection.");
      },
    );
    return () => {
      active.current = false;
    };
  }, []);

  async function act(action: "review" | "start" | "poll" | "status") {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      if (action === "review") {
        if (!(await nativeReview?.postMessage(null)) || !active.current) return;
        const current: View = await api(connection);
        if (!active.current) return;
        setView(current);
        if (
          !current.available ||
          !current.ready ||
          current.originalReviewExpired ||
          current.state?.status !== "not-started"
        )
          return;
        action = "start";
      }
      const result =
        action === "status"
          ? await api(connection)
          : await api(connection, "POST", { action });
      if (active.current) setView(result);
    } catch {
      if (active.current)
        setError(
          "The app could not confirm the last step. Check its status before continuing.",
        );
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  const state = view?.state;
  const complete = state?.status === "complete";
  const expired = view?.originalReviewExpired || state?.status === "expired";
  const reviewUrl = state && "reviewUrl" in state ? state.reviewUrl : null;
  const waiting = state?.status === "pending" || state?.status === "approved";
  const readyToConfirm = rolesOpened || state?.status === "approved";
  const step = complete || (waiting && readyToConfirm) ? 3 : waiting ? 2 : 1;
  const button = (label: string, action: Parameters<typeof act>[0]) => (
    <button
      type="button"
      className="primary"
      disabled={busy}
      onClick={() => void act(action)}
    >
      {label}
    </button>
  );

  return (
    <section
      className="connection-setup"
      aria-labelledby="workflow-connection-title"
      aria-busy={busy}
    >
      <h3 id="workflow-connection-title">Connect this Mac to Workflows</h3>
      <ol className="connection-steps" aria-label="Connection steps">
        {["Review this Mac", "Approve in Roles", "Confirm connection"].map(
          (label, index) => (
            <li
              key={label}
              aria-current={index + 1 === step ? "step" : undefined}
            >
              {label}
            </li>
          ),
        )}
      </ol>
      {busy ? (
        <p role="status">Working on the connection…</p>
      ) : error ? (
        <>
          <p role="alert">{error}</p>
          {button("Check connection status", "status")}
        </>
      ) : !view ? (
        <p role="status">Checking the Mac connection…</p>
      ) : complete ? (
        <p role="status">
          This Mac is registered. CRM access and task permissions are set up
          separately.
        </p>
      ) : expired || state?.status === "held" || state?.status === "failed" ? (
        <>
          <p role="status">
            {expired
              ? "The Roles review expired."
              : "This request needs attention."}{" "}
            The original request is saved.
          </p>
          {button("Check connection status", "status")}
        </>
      ) : !view.available ? (
        <>
          <p>
            Workflow setup is unavailable. Open the installed Bittrees AI app
            with a current setup window.
          </p>
          {button("Check connection status", "status")}
        </>
      ) : !view.ready ? (
        <>
          <p>Review this Mac and the scope of its connection request.</p>
          {nativeReview ? (
            button("Review this Mac", "review")
          ) : (
            <>
              <p>
                In the Bittrees AI menu, choose{" "}
                <strong>Set up Workflows…</strong> to continue in the Mac app.
              </p>
              {button("Check connection status", "status")}
            </>
          )}
        </>
      ) : state?.status === "not-started" ? (
        <>
          <p>This Mac is ready to send its connection request to Roles.</p>
          {button("Request review in Roles", "start")}
        </>
      ) : waiting && reviewUrl ? (
        <>
          <p>
            Approve this Mac in Roles, then return here to confirm the
            connection.
          </p>
          <a
            className={readyToConfirm ? undefined : "primary"}
            href={reviewUrl}
            target="_blank"
            rel="noreferrer"
            onClick={() => setRolesOpened(true)}
          >
            {readyToConfirm ? "Reopen Roles review" : "Open Roles review"}
          </a>
          <div>
            {readyToConfirm ? (
              button("Confirm connection", "poll")
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => void act("poll")}
              >
                Already approved? Confirm connection
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <p>The connection status is unclear. Check the saved request.</p>
          {button("Check connection status", "status")}
        </>
      )}
    </section>
  );
}
