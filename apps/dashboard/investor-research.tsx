import React, { useState, useEffect } from "react";
export function InvestorResearchPanel({
  api,
  onError,
  profiles,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
  onError: (e: unknown) => void;
  profiles: { id: string; model: string }[];
}) {
  const [status, setStatus] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [profile, setProfile] = useState(""),
    [urls, setUrls] = useState(""),
    [target, setTarget] = useState(200),
    [brief, setBrief] = useState(
      "Find US investment decision-makers for BBRF-PT, a proposed Bitcoin-reserve and Portuguese real-estate vehicle. Prioritize Bitcoin investors, family-office allocators and alternative real-estate investors. Distinguish direct capital allocators from adjacent prospects; do not infer interest or accredited status.",
    );
  const refresh = async () => setStatus(await api("/v1/research/investors"));
  useEffect(() => {
    void refresh().catch(onError);
  }, []);
  useEffect(() => {
    if (!status?.jobs?.some((j: any) => j.state === "running")) return;
    const id = setInterval(() => void refresh().catch(onError), 10000);
    return () => clearInterval(id);
  }, [status?.jobs?.some((j: any) => j.state === "running")]);
  async function act(action: () => Promise<any>) {
    setBusy(true);
    try {
      await action();
      await refresh();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  if (!status?.available) return null;
  return (
    <article className="card crm-dataset-panel" aria-label="Investor research">
      <h3>Investor research</h3>
      <p>
        The local model searches the public sites you list and related team,
        about and contact pages on those exact hosts. It adds sourced people and
        organizations to the connected private CRM dataset through MCP. With an
        enabled destination project, CRM also adds new records automatically to
        People and Organizations. Otherwise they remain research only. It cannot
        contact anyone or approve training.
      </p>
      <fieldset
        disabled={busy || status.jobs.some((j: any) => j.state === "running")}
      >
        <label>
          Research model
          <select value={profile} onChange={(e) => setProfile(e.target.value)}>
            <option value="">Choose a local model</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.model}
              </option>
            ))}
          </select>
        </label>
        <label>
          Research brief
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            maxLength={1500}
          />
        </label>
        <label>
          Target additional people
          <input
            type="number"
            min={1}
            max={200}
            value={target}
            onChange={(e) => setTarget(Number(e.target.value))}
          />
        </label>
        <label>
          Approved public source URLs — one per line
          <textarea
            rows={8}
            value={urls}
            onChange={(e) => setUrls(e.target.value)}
          />
        </label>
        <p>
          HTTPS only, up to 100 starting URLs, 8 pages per host and 300 pages
          per run. No paid search service or cloud model. Source sites receive
          ordinary web requests. US office evidence does not confirm an
          individual’s location or investment interest. Existing records are
          preserved; conflicts pause the run.
        </p>
        <button
          disabled={!profile || !urls.trim()}
          onClick={() =>
            void act(async () => {
              if (
                !confirm(
                  "Start local research? New entries are saved as research. CRM also adds them to People and Organizations when automatic additions are enabled for this dataset.",
                )
              )
                return;
              await api("/v1/research/investors/start", "POST", {
                confirmed: true,
                profileId: profile,
                brief,
                target,
                urls: urls.split(/\s+/).filter(Boolean),
              });
            })
          }
        >
          Start private investor research
        </button>
      </fieldset>
      <button onClick={() => void act(refresh)}>
        Refresh research progress
      </button>
      {status.jobs.map((j: any) => (
        <section key={j.id}>
          <h4>{j.input.brief.slice(0, 80)}</h4>
          <p>
            {j.state} · {j.added} / {j.input.target} people saved as research ·{" "}
            {j.done.length} pages processed · {j.queue.length} queued ·{" "}
            {j.failures.length} source/model failures · {j.skipped} skipped
          </p>
          {j.error && (
            <p role="status">
              {j.error === "This operation was aborted"
                ? "This run was interrupted. Saved progress is preserved."
                : j.error}
            </p>
          )}
          {j.state !== "running" &&
            status.jobs.some((job: any) => job.state === "running") && (
              <p>
                Another research run is active. Resume this run after it
                finishes or is paused.
              </p>
            )}
          {j.state === "running" ? (
            <button
              onClick={() =>
                void act(() => api("/v1/research/investors/pause", "POST", {}))
              }
            >
              Pause research
            </button>
          ) : (
            j.state !== "complete" && (
              <button
                disabled={
                  busy ||
                  status.jobs.some((job: any) => job.state === "running")
                }
                onClick={() =>
                  void act(() =>
                    api("/v1/research/investors/resume", "POST", { id: j.id }),
                  )
                }
              >
                Resume research
              </button>
            )
          )}
          {!!j.duplicateReviews?.length && (
            <details>
              <summary>
                {j.duplicateReviews.length} possible duplicate names held for
                review
              </summary>
              <p>
                These candidates were not added or merged. Different
                organizations do not prove two names are different people.
                Review the sources before creating another profile.
              </p>
              <ul>
                {j.duplicateReviews.map((r: any, i: number) => (
                  <li key={i}>
                    <strong>{r.name}</strong> · Possible match:{" "}
                    {r.matches.map((m: any) => m.name).join(", ")}
                    {" · "}
                    <a href={r.url} target="_blank" rel="noreferrer">
                      Source
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <details>
            <summary>Source failures and run details</summary>
            <pre>{JSON.stringify(j, null, 2)}</pre>
          </details>
        </section>
      ))}
    </article>
  );
}
