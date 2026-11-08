import React, { useEffect, useState } from "react";
import type { CentralEnrollmentStatus } from "../../modules/workflows/central-enrollment-contract.js";
type View = {
  available: boolean;
  ready?: boolean;
  state?: CentralEnrollmentStatus["state"];
  originalReviewExpired?: boolean;
  message?: string;
};
export function CentralEnrollment({
  api,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
}) {
  const [view, setView] = useState<View>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api("/v1/workflows/central/connection")
      .then((v) => {
        if (active) setView(v);
      })
      .catch(() => {
        if (active) setError("Central enrollment status is unavailable.");
      });
    return () => {
      active = false;
    };
  }, []);
  async function act(action?: "start" | "poll") {
    setBusy(true);
    setError("");
    try {
      setView(
        await api(
          "/v1/workflows/central/connection",
          action ? "POST" : "GET",
          action ? { action } : undefined,
        ),
      );
    } catch {
      setError(
        "The reply was not confirmed. Refresh this original review before taking another action.",
      );
    } finally {
      setBusy(false);
    }
  }
  const state = view?.state,
    reviewUrl = state && "reviewUrl" in state ? state.reviewUrl : null;
  const expired = view?.originalReviewExpired && state?.status !== "complete";
  return (
    <section aria-label="Central workflow enrollment">
      <h3>Central workflow enrollment</h3>
      {error && <p role="alert">{error}</p>}
      {!view?.available ? (
        <p>
          Native setup is needed before this Mac can request central workflow
          enrollment.
        </p>
      ) : !view.ready ? (
        <p>
          Choose “Connect workflows…” in the Bittrees AI menu to review the
          native connection scope, then refresh here.
        </p>
      ) : (
        <>
          <p>
            {expired
              ? "The original review expired. Its request and evidence are retained for reconciliation."
              : state?.status === "complete"
                ? "An enrollment receipt is recorded. Work permissions and source connections still need approval."
                : state?.status === "pending" || state?.status === "approved"
                  ? "Waiting for the owner review in Roles."
                  : state?.status === "not-started"
                    ? "Ready to request an owner review in Roles."
                    : "Enrollment needs reconciliation."}
          </p>
          {state && "message" in state && state.message && (
            <p role="status">{state.message}</p>
          )}
          {state?.status === "not-started" && !expired && (
            <button disabled={busy} onClick={() => void act("start")}>
              Request review in Roles
            </button>
          )}
          {reviewUrl && !expired && state?.status !== "complete" && (
            <>
              <a href={reviewUrl} target="_blank" rel="noreferrer">
                Open the original Roles review
              </a>
              <p>After approving in Roles, return here to check the review.</p>
              <button disabled={busy} onClick={() => void act("poll")}>
                Check owner approval
              </button>
            </>
          )}
        </>
      )}
      <button disabled={busy} onClick={() => void act()}>
        Refresh enrollment status
      </button>
      <p>
        Enrollment uses this Mac’s existing central identity. It does not start
        tasks or grant work permissions.
      </p>
    </section>
  );
}
