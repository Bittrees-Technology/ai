import React, { useEffect, useState } from "react";
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
export function RecurringWork({ api }: { api: Api }) {
  const [rows, setRows] = useState<any[]>([]),
    [details, setDetails] = useState<any>(null),
    [input, setInput] = useState(""),
    [error, setError] = useState("");
  const refresh = () =>
    api("/v1/workflows/recurring")
      .then(setRows)
      .catch((e) => setError(String(e)));
  useEffect(() => {
    void refresh();
  }, []);
  async function control(row: any, action: string) {
    setError("");
    try {
      await api("/v1/workflows/recurring/control", "POST", {
        id: row.id,
        action,
        ...(["approve", "enable"].includes(action)
          ? { revision: row.revision }
          : {}),
        ...(action === "approve" ? { confirmed: true } : {}),
      });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <section aria-label="Recurring work">
      <h3>Recurring work</h3>
      <p>
        Review imported schedules here. Original schedules stay responsible
        until their replacement has been verified and the original is paused.
        Approval here does not grant access to another app.
      </p>
      <p>
        Source adapters are not yet installed in this local release. Imported
        workflows cannot execute or take over their original schedules.
      </p>
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>Import workflow definitions</summary>
        <label>
          Reviewed definitions (JSON)
          <textarea value={input} onChange={(e) => setInput(e.target.value)} />
        </label>
        <button
          onClick={async () => {
            try {
              await api(
                "/v1/workflows/recurring/review",
                "POST",
                JSON.parse(input),
              );
              setInput("");
              await refresh();
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          Prepare review
        </button>
      </details>
      <button onClick={() => void refresh()}>Refresh</button>
      {rows.length === 0 && <p>No recurring workflows imported.</p>}
      {rows.map((row) => (
        <article key={row.id}>
          <h4>{row.name}</h4>
          <p>
            {row.status} · Original: {row.originalState} · {row.timezone}
          </p>
          <p>Required access: {row.capabilities.join(", ")}</p>
          <button
            onClick={async () => {
              try {
                setDetails(
                  await api(
                    "/v1/workflows/recurring/" + encodeURIComponent(row.id),
                  ),
                );
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            Review instructions and schedule
          </button>
          {details?.definition.id === row.id && (
            <div>
              <pre>{JSON.stringify(details.definition, null, 2)}</pre>
              {!row.approved && (
                <button
                  onClick={() =>
                    void control(
                      { ...row, revision: details.revision },
                      "approve",
                    )
                  }
                >
                  Approve this local definition
                </button>
              )}
            </div>
          )}
          {row.approved && (
            <button onClick={() => void control(row, "verify")}>
              Verify source access
            </button>
          )}
          {row.verified && !row.enabled && (
            <button onClick={() => void control(row, "enable")}>
              Enable after original is paused
            </button>
          )}
          {row.enabled && (
            <button onClick={() => void control(row, "pause")}>Pause</button>
          )}
          {row.approved && (
            <button onClick={() => void control(row, "revoke")}>
              Revoke local approval
            </button>
          )}
          {row.lastSummary && <p>{row.lastSummary}</p>}
          {row.exception && (
            <p role="status">Needs help: {row.exception.reason}</p>
          )}
        </article>
      ))}
    </section>
  );
}
