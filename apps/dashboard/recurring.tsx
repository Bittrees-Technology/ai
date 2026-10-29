import React, { useEffect, useState } from "react";
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
function readableSchedule(rule: string) {
  const parts = Object.fromEntries(
    rule
      .replace(/^RRULE:/, "")
      .split(";")
      .map((part) => part.split("=")),
  );
  const interval = Number(parts.INTERVAL || 1);
  if (
    Object.keys(parts).some(
      (key) =>
        ![
          "FREQ",
          "INTERVAL",
          "BYHOUR",
          "BYMINUTE",
          "BYSECOND",
          "BYDAY",
        ].includes(key),
    )
  )
    return `Custom schedule: ${rule}`;
  if (
    ["MINUTELY", "HOURLY"].includes(parts.FREQ) &&
    Object.keys(parts).every((key) => ["FREQ", "INTERVAL"].includes(key))
  ) {
    const unit = parts.FREQ === "MINUTELY" ? "minute" : "hour";
    return interval === 1 ? `Every ${unit}` : `Every ${interval} ${unit}s`;
  }
  const days: Record<string, string> = {
    MO: "Monday",
    TU: "Tuesday",
    WE: "Wednesday",
    TH: "Thursday",
    FR: "Friday",
    SA: "Saturday",
    SU: "Sunday",
  };
  if (
    interval === 1 &&
    /^\d{1,2}$/.test(parts.BYHOUR || "") &&
    /^\d{1,2}$/.test(parts.BYMINUTE || "") &&
    (!parts.BYSECOND || parts.BYSECOND === "0")
  ) {
    const time = `${parts.BYHOUR.padStart(2, "0")}:${parts.BYMINUTE.padStart(2, "0")}`;
    if (parts.FREQ === "DAILY" && !parts.BYDAY) return `Every day at ${time}`;
    if (parts.FREQ === "WEEKLY" && days[parts.BYDAY])
      return `Every ${days[parts.BYDAY]} at ${time}`;
  }
  return `Custom schedule: ${rule}`;
}
function accessDescription(capability: string) {
  if (capability === "local.investor.portfolio.daily")
    return "Research public primary business sources with the local model and read only the eight approved private investor lists. Drafts remain private; no workspace publication or outreach.";
  if (capability === "local.investor.portfolio.private-edit")
    return "May append or enrich sourced proposals in the eight approved private investor lists only, after current source checks. No CRM records, projects, tasks, sharing or publication. Uncertain saves stop for reconciliation.";
  if (capability === "local.mycloud.health")
    return "Read-only: pinned MyCloud health checker. Access is limited to the approved NAS on port 22; no repairs or file changes.";
  if (capability === "local.storage.inspect")
    return "Read free disk space and inspect cache safety. Cleanup requires a separately reviewed cache action.";
  if (capability === "local.cache.cleanup.reviewed")
    return "May remove only verified unused download/compiler caches below the 20 GiB reserve. Verification runs can perform this cleanup. Projects, dependencies, backups and open/changing files are retained.";
  if (capability === "local.home-monitor.read")
    return "Available: read local Home Server Monitor status. SSH and repairs are not available.";
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
            {row.status} ·{" "}
            {row.scheduleOrigin === "native"
              ? "New local schedule"
              : "Original: " + row.originalState}{" "}
            · {row.timezone}
          </p>
          <p>
            {row.enabled
              ? "Local workflow enabled"
              : row.scheduleOrigin === "native"
                ? "Local workflow inactive; no original schedule exists."
                : "Local workflow inactive; original schedule remains responsible."}
          </p>
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
              <p>
                <strong>Schedule:</strong>{" "}
                {readableSchedule(details.definition.rrule)} (
                {details.definition.timezone})
              </p>
              <p>
                <strong>Original schedule:</strong>{" "}
                {details.definition.scheduleOrigin === "native"
                  ? "None — new local schedule"
                  : details.definition.originalState === "paused"
                    ? "Paused — will not restart through import"
                    : "Active"}
              </p>
              <p style={{ whiteSpace: "pre-wrap" }}>
                {details.definition.executionBrief}
              </p>
              <p>{accessDescription(details.definition.collect.capability)}</p>
              {details.definition.actions.map((action: any) => (
                <p key={action.id}>{accessDescription(action.capability)}</p>
              ))}
              <p>
                {details.definition.scheduleOrigin === "native"
                  ? "Enabling this new local schedule requires source verification and current single-owner authorization."
                  : "Schedule takeover requires a complete verified source adapter and confirmation that the original schedule is paused."}
              </p>
              <details>
                <summary>Full original instructions</summary>
                <p style={{ whiteSpace: "pre-wrap" }}>
                  {details.definition.instructions}
                </p>
              </details>
              <details>
                <summary>Technical definition</summary>
                <pre>{JSON.stringify(details.definition, null, 2)}</pre>
              </details>
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
              {row.capabilities?.includes("local.cache.cleanup.reviewed")
                ? "Run reviewed cache cleanup verification"
                : "Verify source access"}
            </button>
          )}
          {row.verified && !row.enabled && (
            <button onClick={() => void control(row, "enable")}>
              {row.scheduleOrigin === "native"
                ? "Enable new local schedule"
                : "Enable after original is paused"}
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
          {row.capabilities?.includes("local.cache.cleanup.reviewed") &&
            row.lastReceipt?.evidence?.afterAvailableBytes !== undefined && (
              <p>
                Last check:{" "}
                {(
                  row.lastReceipt.evidence.afterAvailableBytes /
                  1024 ** 3
                ).toFixed(1)}{" "}
                GiB free. {row.lastReceipt.evidence.removed?.length ?? 0} caches
                cleaned; {row.lastReceipt.evidence.skipped?.length ?? 0}{" "}
                skipped. {row.lastReceipt.evidence.review}
              </p>
            )}
          {row.exception && (
            <p role="status">Needs help: {row.exception.reason}</p>
          )}
        </article>
      ))}
    </section>
  );
}
