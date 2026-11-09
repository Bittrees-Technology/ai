import React, { useEffect, useRef, useState } from "react";
import type { CentralEnrollmentStatus } from "../../modules/workflows/central-enrollment-contract.js";

type View = {
  available: boolean;
  ready?: boolean;
  state?: CentralEnrollmentStatus["state"];
  originalReviewExpiresAt?: number;
  originalReviewExpired?: boolean;
  reconciliation?: CentralEnrollmentStatus["reconciliation"];
  replacementReviewReady?: CentralEnrollmentStatus["replacementReviewReady"];
  recoveryReviewExpiresAt?: number;
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
    [rolesOpened, setRolesOpened] = useState(false),
    [now, setNow] = useState(Date.now);
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

  const state = view?.state;
  const complete = state?.status === "complete";
  const waiting = state?.status === "pending" || state?.status === "approved";
  const deadline = waiting
    ? Math.min(
        view?.originalReviewExpiresAt ?? Infinity,
        Date.parse(state.expiresAt) || Infinity,
      )
    : Infinity;
  const expired =
    view?.originalReviewExpired ||
    state?.status === "expired" ||
    now >= deadline;
  const displayDeadline = view?.recoveryReviewExpiresAt ?? deadline;
  useEffect(() => {
    if (!Number.isFinite(displayDeadline)) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, displayDeadline - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [displayDeadline]);

  async function act(
    action: "review" | "start" | "poll" | "status" | "reconcile",
  ) {
    if (inFlight.current) return;
    if (action === "poll" && (expired || Date.now() >= deadline)) {
      setNow(Date.now());
      return;
    }
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
      // A local status read without active consent cannot supersede a known
      // expired request. Keep the existing review visible for reconciliation.
      if (active.current && action === "start") setRolesOpened(false);
      if (active.current && (action !== "status" || result.ready || !expired))
        setView(result);
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

  const reviewUrl = state && "reviewUrl" in state ? state.reviewUrl : null;
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
      ) : view.reconciliation === "not-committed" ? (
        <>
          <p role="status">
            Roles confirmed the original enrollment did not complete. The Mac
            saved the outcome with the original request.
          </p>
          {view.replacementReviewReady ? (
            button("Request a new review in Roles", "start")
          ) : view.recoveryReviewExpiresAt &&
            now < view.recoveryReviewExpiresAt ? (
            <p>
              A separate native review becomes available when this review
              closes.
            </p>
          ) : nativeReview ? (
            button("Review this Mac for a new request", "review")
          ) : null}
        </>
      ) : expired || state?.status === "held" || state?.status === "failed" ? (
        <>
          <p role="status">
            {expired
              ? "The connection review expired."
              : "This request needs attention."}{" "}
            The original request is saved.
          </p>
          {button("Check connection status", "status")}
          {expired && view.ready && state && "expiresAt" in state
            ? button("Check original enrollment outcome", "reconcile")
            : null}
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
