import { CrmTaskEditor } from "./crm-task-editor.js";
import React, { useState, useEffect } from "react";
export function ProjectWorkPanel({ api, onError, profiles }: any) {
  const [status, setStatus] = useState<any>(null),
    [project, setProject] = useState(""),
    [profile, setProfile] = useState(""),
    [prompt, setPrompt] = useState(""),
    [busy, setBusy] = useState(false);
  const refresh = async () => setStatus(await api("/v1/crm-projects"));
  const refreshJobs = async () => {
    const local = await api("/v1/crm-projects/status");
    setStatus((previous: any) => ({ ...previous, ...local }));
  };
  useEffect(() => {
    void refresh().catch(onError);
  }, []);
  const running = status?.jobs?.some((j: any) => j.state === "running");
  useEffect(() => {
    if (!running && !status?.automatic?.enabled) return;
    let active = true,
      inFlight = false;
    const poll = async () => {
      if (!active || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const local = await api("/v1/crm-projects/status");
        if (active) setStatus((previous: any) => ({ ...previous, ...local }));
      } catch (error) {
        if (active) onError(error);
      } finally {
        inFlight = false;
      }
    };
    const visible = () => void poll();
    const id = setInterval(visible, 10000);
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [running, status?.automatic?.enabled]);
  async function act(fn: () => Promise<any>) {
    setBusy(true);
    try {
      await fn();
      await refreshJobs();
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
  async function automatic(enabled: boolean) {
    if (
      enabled &&
      !confirm(
        "Automatically work on your open AI draft/review tasks in this project, including while research runs and after app restarts? Results are saved to CRM. Outside actions still require separate approval.",
      )
    )
      return;
    await api(
      "/v1/crm-projects/automatic",
      "POST",
      enabled
        ? {
            enabled: true,
            confirmed: true,
            projectId: project,
            profileId: profile,
          }
        : { enabled: false },
    );
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
      <p role="status">
        Automatic task worker:{" "}
        {status.automatic?.enabled
          ? status.jobs?.find((j: any) => j.id === status.automatic.jobId)
              ?.state === "needs_attention"
            ? "Needs attention — see the task run below"
            : "On — watches the selected project, including during research"
          : "Off"}
      </p>
      {status.automatic?.enabled && (
        <button
          disabled={busy}
          onClick={() => void act(() => automatic(false))}
        >
          Turn off automatic task work
        </button>
      )}
      <fieldset disabled={busy || running}>
        <label>
          Project
          <select
            aria-label="Project"
            value={project}
            onChange={(e) => setProject(e.target.value)}
          >
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
          <select
            aria-label="Local model profile"
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
          >
            <option value="">Choose a model</option>
            {profiles.map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.model} ·{" "}
                {p.contextTokens?.toLocaleString() || p.id.slice(0, 8)} context
              </option>
            ))}
          </select>
        </label>
        {!status.automatic?.enabled && (
          <button
            disabled={!project || !profile}
            onClick={() => void act(() => automatic(true))}
          >
            Turn on automatic task work
          </button>
        )}
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
      {project && <CrmTaskEditor key={project} api={api} projectId={project} />}
      {status.jobs.map((j: any) => (
        <section key={j.id}>
          <h4>
            {j.input.mode === "plan" ? "Task planning" : "Project task work"}
          </h4>
          <p>
            {j.state} · {j.completed} confirmed CRM saves
          </p>
          {j.phase && (
            <p>
              {j.phase}
              {j.currentTask ? ` · ${j.currentTask}` : ""}
            </p>
          )}
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
