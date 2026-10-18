import React, { useState, useEffect, useId } from "react";
export function QualificationPanel({
  api,
  onError,
  profiles,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
  onError: (e: unknown) => void;
  profiles: { id: string; model: string }[];
}) {
  const modelId = useId();
  const [status, setStatus] = useState<any>(null),
    [projects, setProjects] = useState<any[]>([]),
    [project, setProject] = useState(""),
    [ctx, setCtx] = useState<any>(null),
    [selected, setSelected] = useState<string[]>([]),
    [profile, setProfile] = useState(""),
    [urls, setUrls] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [brief, setBrief] = useState("");
  const refresh = async () =>
    setStatus(await api("/v1/research/qualification"));
  useEffect(() => {
    void refresh().catch(onError);
  }, []);
  useEffect(() => {
    if (!status?.jobs?.some((j: any) => j.state === "running")) return;
    const t = setInterval(() => void refresh().catch(onError), 10000);
    return () => clearInterval(t);
  }, [status?.jobs?.some((j: any) => j.state === "running")]);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  const load = async () => {
    const c = await api("/v1/research/qualification/context", "POST", {
      projectId: project,
    });
    setCtx(c);
    setSelected(
      c.entries
        .filter(
          (r: any) =>
            r.entry.kind === "people" &&
            r.entry.category?.endsWith("| Priority research"),
        )
        .slice(0, 20)
        .map((r: any) => r.entry.id),
    );
    const u = c.entries
      .flatMap((r: any) => [
        r.entry.website,
        ...(r.entry.research?.sources || []).map((s: any) => s.url),
      ])
      .filter((u: any) => typeof u === "string" && u.startsWith("https://"));
    setUrls([...new Set(u)].slice(0, 100).join("\n"));
  };
  if (!status?.available) return null;
  const running = status.jobs.some((j: any) => j.state === "running");
  return (
    <article
      className="card crm-dataset-panel"
      aria-label="Investor qualification"
    >
      <h3>Investor qualification</h3>
      <p>
        Research existing people on approved public sites using your local
        model. Saves evidence in your private dataset and updates only the CRM
        qualification label. Unknown requirements stay unverified. Enable
        qualification for the project in CRM first.
      </p>
      <fieldset disabled={busy || running}>
        <button
          onClick={() =>
            void act(async () => {
              const p = await api("/v1/crm-projects");
              setProjects(p.projects.filter((p: any) => p.qualification));
            })
          }
        >
          Load connected projects
        </button>
        <label>
          Qualification project
          <select
            value={project}
            onChange={(e) => {
              setProject(e.target.value);
              setCtx(null);
              setSelected([]);
            }}
          >
            <option value="">Choose project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button disabled={!project} onClick={() => void act(load)}>
          Preview people and labels
        </button>
        {ctx && (
          <>
            <p>
              {ctx.entries.length} mapped records. Select up to 20 people for
              research.
            </p>
            <div style={{ maxHeight: 250, overflowY: "auto" }}>
              {ctx.entries
                .filter((r: any) => r.entry.kind === "people")
                .map((r: any) => (
                  <label key={r.entry.id}>
                    <input
                      type="checkbox"
                      checked={selected.includes(r.entry.id)}
                      disabled={
                        !selected.includes(r.entry.id) && selected.length >= 20
                      }
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, r.entry.id]
                            : selected.filter((id) => id !== r.entry.id),
                        )
                      }
                    />
                    {r.entry.name} — {r.entry.category || "Unclassified"}
                  </label>
                ))}
            </div>
            <details>
              <summary>Label sync preview</summary>
              {ctx.entries.map((r: any) => (
                <p key={r.entry.id}>
                  {r.entry.name}: {r.record.category || "None"} →{" "}
                  {r.entry.category || "Unclassified"}
                </p>
              ))}
            </details>
            <button
              onClick={() =>
                void act(async () => {
                  let count = 0;
                  const ids = ctx.entries
                    .filter(
                      (r: any) =>
                        r.entry.category?.startsWith(ctx.projectName + " | ") &&
                        !r.entry.category?.endsWith("| Qualified"),
                    )
                    .map((r: any) => r.entry.id);
                  for (let i = 0; i < ids.length; i += 20) {
                    const fresh = await api(
                      "/v1/research/qualification/context",
                      "POST",
                      { projectId: project },
                    );
                    const rows = fresh.entries.filter((r: any) =>
                      ids.slice(i, i + 20).includes(r.entry.id),
                    );
                    if (
                      rows.some(
                        (r: any) =>
                          r.record.version !==
                            ctx.entries.find(
                              (x: any) => x.entry.id === r.entry.id,
                            )?.record.version ||
                          r.entry.category !==
                            ctx.entries.find(
                              (x: any) => x.entry.id === r.entry.id,
                            )?.entry.category,
                      )
                    )
                      throw new Error(
                        "CRM changed since preview. Reload before syncing remaining labels.",
                      );
                    if (!rows.length) continue;
                    const receipt = await api(
                      "/v1/research/qualification/sync",
                      "POST",
                      {
                        confirmed: true,
                        projectId: project,
                        datasetVersion: fresh.datasetVersion,
                        entries: rows.map((r: any) => ({
                          entryId: r.entry.id,
                          recordVersion: r.record.version,
                        })),
                      },
                    );
                    count += receipt.receipts.length;
                  }
                  await load();
                  setMessage(`${count} labels reconciled with CRM.`);
                })
              }
            >
              Sync previewed labels only
            </button>
            <label htmlFor={modelId}>Local model</label>
            <select
              id={modelId}
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
            >
              <option value="">Choose model</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.model}
                </option>
              ))}
            </select>
            <label>
              Investment requirements
              <textarea
                placeholder="Describe the evidence required for this project (at least 30 characters)."
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                maxLength={2000}
              />
            </label>
            <label>
              Approved public source URLs, one per line
              <textarea
                value={urls}
                onChange={(e) => setUrls(e.target.value)}
              />
            </label>
            <p>
              Up to six pages per person, on these exact hosts only. Website
              content cannot grant new permissions.
            </p>
            <button
              disabled={
                !profile ||
                !selected.length ||
                !urls.trim() ||
                brief.trim().length < 30
              }
              onClick={() =>
                void act(async () => {
                  await api("/v1/research/qualification/start", "POST", {
                    confirmed: true,
                    projectId: project,
                    profileId: profile,
                    brief,
                    entryIds: selected,
                    urls: urls.split(/\s+/).filter(Boolean),
                  });
                })
              }
            >
              Research {selected.length} selected people and sync labels
            </button>
          </>
        )}
      </fieldset>
      {message && <p role="status">{message}</p>}
      {status.jobs.map((j: any) => (
        <section key={j.id}>
          <h4>
            {j.state} · {j.results.length} confirmed CRM saves /{" "}
            {j.input.entryIds.length} people
          </h4>
          <p>{j.activity}</p>
          {j.error && <p role="alert">{j.error}</p>}
          {j.failures.map((f: any) => (
            <p key={f.entryId}>{f.reason}</p>
          ))}
          {j.state === "running" ? (
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api("/v1/research/qualification/pause", "POST", {});
                })
              }
            >
              Pause qualification
            </button>
          ) : (
            j.state !== "complete" && (
              <button
                disabled={busy || running}
                onClick={() =>
                  void act(async () => {
                    await api("/v1/research/qualification/resume", "POST", {
                      id: j.id,
                    });
                  })
                }
              >
                Resume qualification
              </button>
            )
          )}
          <details>
            <summary>Saved labels</summary>
            {j.results.map((r: any) => (
              <p key={r.entryId}>
                {r.name}: {r.status}
              </p>
            ))}
          </details>
        </section>
      ))}
    </article>
  );
}
