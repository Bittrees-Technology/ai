import React, { useEffect, useState } from "react";
export function CentralWorkflows({
  api,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
}) {
  const [state, setState] = useState<any>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [profile, setProfile] = useState(""),
    [enrollment, setEnrollment] = useState<any>();
  const refresh = () => api("/v1/workflows/central").then(setState);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api("/v1/workflows/central")
        .then((s) => {
          if (alive) setState(s);
        })
        .catch(() => {
          if (alive) setError("Workflow connection is unavailable.");
        });
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Unable to update workflow connection.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Central workflows">
      <h2>Workflows on this Mac</h2>
      <p>
        Instructions and ordered steps come from{" "}
        <a
          href="https://workflow.bittrees.org"
          target="_blank"
          rel="noreferrer"
        >
          Bittrees Workflows
        </a>
        . This connection currently runs local text-generation steps.
        Source-changing tasks require their separate connectors and permissions.
      </p>
      {error && <p role="alert">{error}</p>}
      <p>
        {state?.enabled
          ? "Listening for authorized work"
          : state?.configured
            ? "Paused"
            : "Not connected"}{" "}
        · {state?.progress?.state || "Waiting for setup"}
      </p>
      {state?.progress?.message && <p>{state.progress.message}</p>}
      {state?.lastReceipt && (
        <p>
          Last completion:{" "}
          {new Date(state.lastReceipt.completedAt).toLocaleString()}.{" "}
          {state.lastReceipt.followUpQueued
            ? "The next step was queued."
            : "The sequence finished."}
        </p>
      )}
      {state?.configured && (
        <button
          disabled={busy}
          onClick={() =>
            void act(() =>
              api(
                "/v1/workflows/central/" + (state.enabled ? "pause" : "resume"),
                "POST",
                {},
              ),
            )
          }
        >
          {state.enabled ? "Pause this Mac" : "Resume"}
        </button>
      )}
      <details>
        <summary>Connect or review this device</summary>
        <p>
          The private signing key stays encrypted on this Mac. Approval is
          separate from installing the app.
        </p>
        <label>
          Your Roles profile ID
          <input
            value={profile}
            onChange={(e) => {
              setProfile(e.target.value);
              setEnrollment(null);
            }}
          />
        </label>
        <button
          disabled={busy || !profile}
          onClick={() =>
            void act(async () =>
              setEnrollment(
                await api("/v1/workflows/central/enrollment", "POST", {
                  profileId: profile,
                }),
              ),
            )
          }
        >
          Prepare device enrollment
        </button>
        {enrollment && (
          <>
            <p>
              Enrollment proof expires after 30 seconds. Generate a new proof if
              needed.
            </p>
            <textarea
              readOnly
              aria-label="Public device enrollment"
              value={JSON.stringify(enrollment)}
            />
          </>
        )}
        <label>
          Approved connection package
          <input
            type="file"
            accept="application/json,.json"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                void act(async () => {
                  if (file.size > 16000)
                    throw Error("Connection package is too large.");
                  const c = JSON.parse(await file.text());
                  await api("/v1/workflows/central/configure", "POST", {
                    ...c,
                    enabled: false,
                    confirmed: true,
                  });
                });
              e.target.value = "";
            }}
          />
        </label>
        <p>
          Import stores the connection paused. Review its workflow before
          choosing Resume. Revoke delegated access in Roles or revoke the device
          connection in Workflows.
        </p>
        {state?.workflowId && <p>Workflow: {state.workflowId}</p>}
      </details>
    </section>
  );
}
