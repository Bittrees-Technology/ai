import React, { useEffect, useState } from "react";
export function ResearchActivity({
  api,
  onConnections,
}: {
  api: (path: string) => Promise<any>;
  onConnections: () => void;
}) {
  const [jobs, setJobs] = useState<any[]>([]),
    [error, setError] = useState(""),
    [checked, setChecked] = useState("");
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const value = await api("/v1/research/investors");
        if (!cancelled) {
          setJobs(value.jobs || []);
          setError("");
          setChecked(new Date().toLocaleTimeString());
        }
      } catch {
        if (!cancelled)
          setError(
            "Unable to refresh activity. Displayed results may be out of date.",
          );
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api]);
  return (
    <section aria-label="Work activity">
      <h2>Work activity</h2>
      <p>
        Research saves and CRM additions are separate. Research is stored in
        your private dataset; connected project permissions control automatic
        additions to People and Organizations. Supplier automation runs
        separately using rules.
      </p>
      <button onClick={onConnections}>
        Manage research and CRM connection
      </button>
      {error && <p role="alert">{error}</p>}
      <p>Last checked: {checked || "Checking…"}</p>
      {!jobs.length && <p>No research runs recorded.</p>}
      {[...jobs]
        .sort(
          (a, b) =>
            Number(b.state === "running") - Number(a.state === "running") ||
            b.updatedAt.localeCompare(a.updatedAt),
        )
        .map((j) => (
          <article className="card" key={j.id}>
            <h3>{j.input.brief.slice(0, 100)}</h3>
            <p>
              <strong>
                {j.state === "running"
                  ? "Running"
                  : j.state === "complete"
                    ? "Target reached"
                    : j.state === "sources_exhausted"
                      ? "Sources exhausted"
                      : j.state === "needs_attention"
                        ? "Needs attention"
                        : "Paused"}
              </strong>{" "}
              · {j.added} of {j.input.target} people saved as research
            </p>
            <progress
              value={j.added}
              max={j.input.target}
              aria-label="People saved as research"
            />
            {j.crmProgress ? (
              <div aria-label="CRM addition status">
                <p>
                  <strong>
                    In CRM: {j.crmProgress.crmPeople} people ·{" "}
                    {j.crmProgress.crmOrganizations} organizations
                  </strong>
                </p>
                <p>
                  Connected dataset totals: {j.crmProgress.researchPeople}{" "}
                  people and {j.crmProgress.researchOrganizations} organizations
                  saved as research. These totals include other runs and manual
                  additions.
                </p>
                <p>
                  CRM checked:{" "}
                  {new Date(j.crmProgress.checkedAt).toLocaleString()}. Counts
                  update when this run reads or saves research.
                </p>
              </div>
            ) : (
              <p>
                CRM additions have not been checked for this run. The research
                count does not confirm a CRM import.
              </p>
            )}
            <p>Model: {j.modelName || "Recorded profile"} · On this Mac</p>
            <p>
              {j.done.length} pages processed · {j.queue.length} queued ·{" "}
              {j.skipped} candidates skipped · {j.failures.length} source/model
              failures
            </p>
            {j.state === "running" && (
              <p role="status">
                {j.activity?.phase || "Research in progress"}
                {j.activity?.url && (
                  <>
                    {" "}
                    —{" "}
                    <a href={j.activity.url} target="_blank" rel="noreferrer">
                      Current source
                    </a>
                  </>
                )}
              </p>
            )}
            {j.error && (
              <p>
                {j.error === "This operation was aborted"
                  ? "Run interrupted; saved progress is preserved."
                  : j.error}
              </p>
            )}
            <p>Last progress: {new Date(j.updatedAt).toLocaleString()}</p>
            <a
              href="https://crm.bittrees.org/connect/ai/leads"
              target="_blank"
              rel="noreferrer"
            >
              Open private research dataset
            </a>
            <p>
              <a
                href="https://crm.bittrees.org/"
                target="_blank"
                rel="noreferrer"
              >
                Open CRM People and Organizations
              </a>
              {" · "}
              <a
                href="https://crm.bittrees.org/connect/ai/projects"
                target="_blank"
                rel="noreferrer"
              >
                Automatic addition permissions
              </a>
            </p>
            <p>
              Saved research is preliminary. Source-supported names and roles do
              not establish investment interest, eligibility or mandate fit.
            </p>
            {j.results?.length > 0 ? (
              <ul>
                {j.results.map((r: any) => (
                  <li key={r.id}>
                    <strong>{r.name}</strong> — {r.title} ·{" "}
                    <a href={r.url} target="_blank" rel="noreferrer">
                      Source
                    </a>{" "}
                    · Saved as research {new Date(r.savedAt).toLocaleString()} ·{" "}
                    {j.crmProgress?.entryIds.includes(r.id)
                      ? "In CRM"
                      : "CRM addition not confirmed"}
                  </li>
                ))}
              </ul>
            ) : j.added > 0 ? (
              <p>
                These records were saved before detailed activity receipts were
                available. Inspect them in the connected CRM dataset.
              </p>
            ) : null}
            {j.failures.length > 0 && (
              <details>
                <summary>Source and model failures</summary>
                <ul>
                  {j.failures.map((f: any, i: number) => (
                    <li key={i}>
                      {f.url}: {f.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </article>
        ))}
    </section>
  );
}
