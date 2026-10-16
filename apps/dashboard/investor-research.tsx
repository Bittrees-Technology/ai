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
  const [extensions, setExtensions] = useState<Record<string, string>>({});
  const [totalTargets, setTotalTargets] = useState<Record<string, number>>({});
  const [batchTargets, setBatchTargets] = useState<Record<string, number>>({});
  const [verificationProjects, setVerificationProjects] = useState<
    Record<string, string>
  >({});
  const [projectChoices, setProjectChoices] = useState<any[]>([]);
  useEffect(() => {
    if (status?.available)
      void api("/v1/crm-projects")
        .then((r) => setProjectChoices(r.projects || []))
        .catch(onError);
  }, [status?.available]);
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
          {j.verificationTarget && (
            <p>
              Separate verification target: {j.verificationTarget} fully
              verified investors in the connected CRM project. Research saves do
              not count as verified. Source-confirmed progress syncs to
              Workflows while this Mac is online.
            </p>
          )}
          {j.totalPeopleTarget && (
            <p>
              Dataset total: {j.crmProgress?.researchPeople ?? "Not checked"} /{" "}
              {j.totalPeopleTarget} people. This includes other runs and manual
              additions; CRM imports are counted separately.
            </p>
          )}
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
          {j.state !== "running" && (
            <details>
              <summary>Add sources and continue this run</summary>
              <fieldset
                disabled={
                  busy ||
                  status.jobs.some((job: any) => job.state === "running")
                }
              >
                <label>
                  Additional people to research in this batch
                  <input
                    type="number"
                    min={1}
                    max={200}
                    value={batchTargets[j.id] ?? 20}
                    onChange={(e) =>
                      setBatchTargets({
                        ...batchTargets,
                        [j.id]: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Track verified investor progress in a connected project
                  <select
                    value={
                      verificationProjects[j.id] ??
                      j.verificationProjectId ??
                      ""
                    }
                    onChange={(e) =>
                      setVerificationProjects({
                        ...verificationProjects,
                        [j.id]: e.target.value,
                      })
                    }
                  >
                    <option value="">Research counts only</option>
                    {projectChoices
                      .filter((p) => p.qualification)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Fully verified investor target in CRM
                  <input
                    type="number"
                    min={1}
                    max={200}
                    disabled={
                      !(verificationProjects[j.id] ?? j.verificationProjectId)
                    }
                    value={totalTargets[j.id] ?? j.verificationTarget ?? 200}
                    onChange={(e) =>
                      setTotalTargets({
                        ...totalTargets,
                        [j.id]: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Additional approved public sources — one per line
                  <textarea
                    rows={8}
                    value={extensions[j.id] || ""}
                    onChange={(e) =>
                      setExtensions({ ...extensions, [j.id]: e.target.value })
                    }
                  />
                </label>
                <p>
                  Saved results and duplicate checks are preserved. Only new
                  HTTPS sources are queued; the same 100 starting-source,
                  8-page-per-host and 300-page run limits apply. This batch
                  stops at its research limit or when sources run out. Only
                  source-confirmed fully verified CRM records count toward the
                  separate verification target.
                </p>
                <button
                  disabled={!extensions[j.id]?.trim()}
                  onClick={() =>
                    void act(async () => {
                      if (
                        !confirm(
                          "Add these public sources and continue this saved run with the selected research batch and verification target? Existing CRM permissions and qualification requirements remain in effect.",
                        )
                      )
                        return;
                      await api("/v1/research/investors/extend", "POST", {
                        confirmed: true,
                        id: j.id,
                        urls: extensions[j.id]!.split(/\s+/).filter(Boolean),
                        additionalPeople: batchTargets[j.id] ?? 20,
                        ...((verificationProjects[j.id] ??
                        j.verificationProjectId)
                          ? {
                              verificationProjectId:
                                verificationProjects[j.id] ??
                                j.verificationProjectId,
                              verificationTarget:
                                totalTargets[j.id] ??
                                j.verificationTarget ??
                                200,
                            }
                          : {}),
                      });
                      setExtensions((previous) => ({
                        ...previous,
                        [j.id]: "",
                      }));
                    })
                  }
                >
                  Add sources and continue research
                </button>
              </fieldset>
            </details>
          )}
          {!!j.locationReviews?.length && (
            <details>
              <summary>
                {j.locationReviews.length} people need location research
              </summary>
              <p>
                These candidates remain outside CRM additions until a source
                establishes their current personal US base. A company address is
                insufficient.
              </p>
              <ul>
                {j.locationReviews.map((r: any, i: number) => (
                  <li key={i}>
                    <strong>{r.name}</strong> · {r.reason}
                    {" · "}
                    <a href={r.url} target="_blank" rel="noreferrer">
                      Source
                    </a>
                  </li>
                ))}
              </ul>
            </details>
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
