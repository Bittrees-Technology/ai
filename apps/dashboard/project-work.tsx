import React, { useState, useEffect } from "react";
export function ProjectWorkPanel({ api, onError, profiles }: any) {
  const [status, setStatus] = useState<any>(null),
    [project, setProject] = useState(""),
    [profile, setProfile] = useState(""),
    [prompt, setPrompt] = useState(""),
    [busy, setBusy] = useState(false);
  const refresh = async () => setStatus(await api("/v1/crm-projects"));
  useEffect(() => {
    void refresh().catch(onError);
  }, []);
  const running = status?.jobs?.some((j: any) => j.state === "running");
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void refresh().catch(onError), 10000);
    return () => clearInterval(id);
  }, [running]);
  async function act(fn: () => Promise<any>) {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  async function start(mode: string) {
    if (
      !confirm(
        mode === "plan"
          ? "Let the local model create up to five draft/review tasks in this connected CRM project?"
          : "Work on up to 20 open AI draft/review tasks assigned to you, saving results as CRM notes and marking completed drafts/reviews done?",
      )
    )
      return;
    await api("/v1/crm-projects/start", "POST", {
      confirmed: true,
      mode,
      profileId: profile,
      projectId: project,
      prompt,
    });
  }
  if (!status?.available) return null;
  return (
    <article className="card crm-dataset-panel" aria-label="CRM project tasks">
      <h3>CRM project tasks</h3>
      <p>
        Plan tasks and complete drafts or reviews using your local model and
        connected project records. Results return to CRM automatically. This
        cannot send messages, delete records, change access or carry out outside
        actions.
      </p>
      <a
        href="https://crm.bittrees.org/connect/ai/projects"
        target="_blank"
        rel="noreferrer"
      >
        Manage connected projects in CRM
      </a>
      <button onClick={() => void act(refresh)}>
        Refresh connected projects
      </button>
      <fieldset disabled={busy || running}>
        <label>
          Project
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">Choose a connected project</option>
            {status.projects
              .filter((p: any) => p.tasks)
              .map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Local model profile
          <select value={profile} onChange={(e) => setProfile(e.target.value)}>
            <option value="">Choose a model</option>
            {profiles.map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.model} ·{" "}
                {p.contextTokens?.toLocaleString() || p.id.slice(0, 8)} context
              </option>
            ))}
          </select>
        </label>
        <label>
          What tasks should the local AI create?
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={2000}
            placeholder="Draft qualification questions and review missing evidence for this project’s investors."
          />
        </label>
        <button
          disabled={!project || !profile || prompt.trim().length < 10}
          onClick={() => void act(() => start("plan"))}
        >
          Create tasks with local AI
        </button>
        <button
          disabled={!project || !profile}
          onClick={() => void act(() => start("work"))}
        >
          Work on queued AI tasks
        </button>
      </fieldset>
      <p>
        Only open tasks assigned to you and categorized “AI draft” or “AI
        review” are eligible. Ordinary tasks stay with you. Pause investor
        research before running project tasks; both use the same local model.
      </p>
      {status.jobs.map((j: any) => (
        <section key={j.id}>
          <h4>
            {j.input.mode === "plan" ? "Task planning" : "Project task work"}
          </h4>
          <p>
            {j.state} · {j.completed} confirmed CRM saves
          </p>
          {j.error && <p role="status">{j.error}</p>}
          {j.state === "running" ? (
            <button
              onClick={() =>
                void act(() => api("/v1/crm-projects/pause", "POST", {}))
              }
            >
              Pause project work
            </button>
          ) : (
            j.state !== "complete" && (
              <button
                onClick={() =>
                  void act(() =>
                    api("/v1/crm-projects/resume", "POST", { id: j.id }),
                  )
                }
              >
                Resume project work
              </button>
            )
          )}
          <details>
            <summary>Results and receipts</summary>
            {j.pendingResults?.map((r: string, i: number) => (
              <pre key={i}>{r}</pre>
            ))}
            <pre>{JSON.stringify(j.receipts, null, 2)}</pre>
          </details>
        </section>
      ))}
    </article>
  );
}
