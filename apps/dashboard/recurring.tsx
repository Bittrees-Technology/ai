import React, { useEffect, useState } from "react";
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
function readableSchedule(rule: string) {
  const parts = Object.fromEntries(rule.replace(/^RRULE:/, "").split(";").map((part) => part.split("=")));
  const interval = Number(parts.INTERVAL || 1);
  if (Object.keys(parts).some((key) => !["FREQ", "INTERVAL", "BYHOUR", "BYMINUTE", "BYSECOND", "BYDAY"].includes(key))) return `Custom schedule: ${rule}`;
  if (["MINUTELY", "HOURLY"].includes(parts.FREQ) && Object.keys(parts).every((key) => ["FREQ", "INTERVAL"].includes(key))) {
    const unit = parts.FREQ === "MINUTELY" ? "minute" : "hour";
    return interval === 1 ? `Every ${unit}` : `Every ${interval} ${unit}s`;
  }
  const days: Record<string, string> = { MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday", SU: "Sunday" };
  if (interval === 1 && /^\d{1,2}$/.test(parts.BYHOUR || "") && /^\d{1,2}$/.test(parts.BYMINUTE || "") && (!parts.BYSECOND || parts.BYSECOND === "0")) {
    const time = `${parts.BYHOUR.padStart(2, "0")}:${parts.BYMINUTE.padStart(2, "0")}`;
    if (parts.FREQ === "DAILY" && !parts.BYDAY) return `Every day at ${time}`;
    if (parts.FREQ === "WEEKLY" && days[parts.BYDAY]) return `Every ${days[parts.BYDAY]} at ${time}`;
  }
  return `Custom schedule: ${rule}`;
}
function accessDescription(capability: string) {
  if (capability === "local.storage.inspect") return "Available: read free disk space. Cleanup is not available.";
  if (capability === "local.home-monitor.read") return "Available: read local Home Server Monitor status. SSH and repairs are not available.";
  return `Not connected yet: ${capability}. No source actions are enabled.`;
}
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
        Storage and Home Server Monitor inspection are available locally. Source
        changes and schedule takeover remain held until complete adapters are
        verified.
      </p>
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>Technical details: import definitions</summary>
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
          <p>{row.enabled ? "Local workflow enabled" : "Local workflow inactive; original schedule remains responsible."}</p>
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
              <p><strong>Schedule:</strong> {readableSchedule(details.definition.rrule)} ({details.definition.timezone})</p>
              <p><strong>Original schedule:</strong> {details.definition.originalState === "paused" ? "Paused — will not restart through import" : "Active"}</p>
              <p style={{ whiteSpace: "pre-wrap" }}>{details.definition.executionBrief}</p>
              <p>{accessDescription(details.definition.collect.capability)}</p>
              <p>Schedule takeover remains unavailable until the complete task can be performed and verified.</p>
              <details><summary>Full original instructions</summary><p style={{ whiteSpace: "pre-wrap" }}>{details.definition.instructions}</p></details>
              <details><summary>Technical definition</summary><pre>{JSON.stringify(details.definition, null, 2)}</pre></details>
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
