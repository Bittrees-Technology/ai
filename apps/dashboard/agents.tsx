import React, { useEffect, useState } from "react";
export function Agents({
  api,
  models,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
  models: { id: string; model: string }[];
}) {
  const [data, setData] = useState<any>();
  const [error, setError] = useState("");
  const [cloudKey, setCloudKey] = useState("");
  const [cloudConsent, setCloudConsent] = useState(false);
  const [selected, setSelected] = useState("");
  const empty = () => ({
    id: crypto.randomUUID(),
    name: "",
    role: "",
    methodology: "",
    knowledge: [] as { name: string; text: string }[],
    provider: "local",
    modelProfileId: models[0]?.id ?? "",
  });
  const [form, setForm] = useState(empty);
  const [knowledge, setKnowledge] = useState("");
  const [workflow, setWorkflow] = useState("");
  const [instruction, setInstruction] = useState("");
  async function refresh() {
    try {
      setData(await api("/v1/agents"));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load task queue");
    }
  }
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, []);
  async function action(path: string, body: unknown) {
    try {
      await api(path, "POST", body);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    }
  }
  const chosenProfile = data?.profiles.find(
    (p: any) =>
      p.id ===
      (selected ||
        data?.bindings.find((b: any) => b.workflow === workflow)?.profile),
  );
  const cloudPreview =
    chosenProfile?.provider === "openrouter"
      ? JSON.stringify(
          {
            role: chosenProfile.role,
            methodology: chosenProfile.methodology,
            knowledge: chosenProfile.knowledge,
            task: instruction,
          },
          null,
          2,
        )
      : "";
  useEffect(() => setCloudConsent(false), [cloudPreview]);
  const field = (key: string, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));
  return (
    <section aria-label="Task coordinator">
      <h3>Task queue & agents</h3>
      <p>
        One task runs at a time. The coordinator queues specialists and keeps
        their results separate from confirmed source changes.
      </p>
      {error && <p role="alert">{error}</p>}
      <button onClick={() => void refresh()}>Refresh</button>
      <button
        onClick={() =>
          void action("/v1/agents/queue", {
            action: data?.queue.paused ? "resume" : "pause",
          })
        }
      >
        {data?.queue.paused ? "Resume queue" : "Pause queue"}
      </button>
      <p>
        Running: {data?.queue.active?.label ?? "None"}. Waiting:{" "}
        {data?.queue.waiting.length ?? 0}. Pausing holds new work; it does not
        interrupt the current task.
      </p>
      <ol>
        {[
          ...(data?.queue.active ? [data.queue.active] : []),
          ...(data?.queue.waiting ?? []),
        ].map((t: any) => (
          <li key={t.id}>
            {t.label} — {t.state}{" "}
            <button
              onClick={() =>
                void action("/v1/agents/queue", { action: "cancel", id: t.id })
              }
            >
              Cancel
            </button>
          </li>
        ))}
      </ol>
      <details>
        <summary>Recent task receipts</summary>
        {data?.queue.history.map((t: any) => (
          <p key={t.id}>
            {t.label} —{" "}
            {t.state === "returned"
              ? "Worker returned; inspect source result"
              : t.state}
          </p>
        ))}
      </details>
      <h3>Agent profiles</h3>
      <p>
        A role, method, reference knowledge and model for each kind of work.
        These settings do not grant source access. Editing a profile holds
        already queued drafts that used its previous version.
      </p>
      <select
        aria-label="Agent profile"
        value={selected}
        onChange={(e) => {
          setSelected(e.target.value);
          const p = data?.profiles.find((p: any) => p.id === e.target.value);
          setForm(p ?? empty());
          setKnowledge(p?.knowledge.map((k: any) => k.text).join("\n\n") ?? "");
        }}
      >
        <option value="">New profile</option>
        {data?.profiles.map((p: any) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <label>
        Name
        <input
          value={form.name}
          onChange={(e) => field("name", e.target.value)}
        />
      </label>
      <label>
        Role
        <textarea
          value={form.role}
          onChange={(e) => field("role", e.target.value)}
        />
      </label>
      <label>
        Methodology
        <textarea
          value={form.methodology}
          onChange={(e) => field("methodology", e.target.value)}
        />
      </label>
      <label>
        Reference knowledge
        <textarea
          maxLength={6000}
          value={knowledge}
          onChange={(e) => setKnowledge(e.target.value)}
        />
      </label>
      <label>
        Model provider
        <select
          value={form.provider}
          onChange={(e) => field("provider", e.target.value)}
        >
          <option value="local">Local Mac model</option>
          <option value="openrouter">OpenRouter (not activated)</option>
        </select>
      </label>
      {form.provider === "local" ? (
        <label>
          Model
          <select
            value={form.modelProfileId}
            onChange={(e) => field("modelProfileId", e.target.value)}
          >
            <option value="">Select model</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.model}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label>
          OpenRouter model ID
          <input
            value={form.modelProfileId}
            onChange={(e) => field("modelProfileId", e.target.value)}
          />
        </label>
      )}
      <button
        onClick={() =>
          void action("/v1/agents/profiles", {
            ...form,
            knowledge: knowledge
              ? [{ name: "Reference knowledge", text: knowledge }]
              : [],
          })
        }
      >
        Save profile
      </button>
      <h3>Workflow assignments</h3>
      <p>
        Existing workflow identifiers: local-tasks, investor-research,
        crm-project-work, qualification-research, directory-evidence,
        central-workflows, saved-investor-evidence, recurring-work. Assignments
        apply on the next model pin; changed profiles hold in-flight reasoning.
        OpenRouter is blocked for these source workflows.
      </p>
      <h3>Queue a specialist draft</h3>
      <p>
        Drafts use supplied knowledge and the selected model. They cannot
        browse, change CRM records or mark source tasks complete. Existing
        source workflows keep their reviewed adapters and permissions.
      </p>
      <label>
        Workflow identifier
        <input value={workflow} onChange={(e) => setWorkflow(e.target.value)} />
      </label>
      <button
        disabled={!selected || !workflow}
        onClick={() =>
          void action("/v1/agents/bindings", { workflow, profile: selected })
        }
      >
        Assign selected agent to workflow
      </button>
      <label>
        Task instructions
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
      </label>
      <button
        disabled={
          !workflow ||
          !instruction ||
          (!!cloudPreview && (!cloudConsent || !data?.openRouter.enabled))
        }
        onClick={() =>
          void action("/v1/agents/tasks", {
            operationId: crypto.randomUUID(),
            workflow,
            instruction,
            ...(cloudConsent ? { cloudConsent: true } : {}),
            ...(selected ? { agentProfileId: selected } : {}),
          })
        }
      >
        Add to queue
      </button>
      {data?.drafts.map((d: any) => (
        <details key={d.id}>
          <summary>
            {d.snapshot.profile.name}: {d.input.workflow} — {d.state}
          </summary>
          <p>{d.reason}</p>
          <pre style={{ whiteSpace: "pre-wrap" }}>{d.receipt?.output}</pre>
          {d.receipt && <p>Model: {d.receipt.model}. Source writes: none.</p>}
        </details>
      ))}
      {cloudPreview && (
        <details>
          <summary>Information proposed for cloud review</summary>
          <pre style={{ whiteSpace: "pre-wrap" }}>{cloudPreview}</pre>
        </details>
      )}
      {cloudPreview && (
        <label>
          <input
            type="checkbox"
            checked={cloudConsent}
            onChange={(e) => setCloudConsent(e.target.checked)}
          />
          For this cloud draft, I approve sending the task instructions and
          selected agent's role, methodology and reference knowledge to
          OpenRouter and Phala. No source data is attached automatically.
        </label>
      )}
      <h3>Remote models & agents</h3>
      <p>
        Free-only model: Xing4.0 29B A4B via Phala. Zero-retention routing, no
        paid fallback. Existing source workflows remain local.
      </p>
      <label>
        OpenRouter API key
        <input
          type="password"
          autoComplete="off"
          value={cloudKey}
          onChange={(e) => setCloudKey(e.target.value)}
        />
      </label>
      <button
        disabled={!cloudKey}
        onClick={() => {
          const apiKey = cloudKey;
          setCloudKey("");
          void action("/v1/agents/cloud/key", { apiKey });
        }}
      >
        Save key securely
      </button>
      <p>
        {data?.openRouter.hasKey
          ? "Key saved in the encrypted local vault."
          : "No key saved."}
      </p>
      <button
        disabled={!data?.openRouter.hasKey}
        onClick={() => void action("/v1/agents/cloud/check", {})}
      >
        Check free access
      </button>
      <p>{data?.openRouter.lastCheck?.reason}</p>
      <button
        disabled={
          !data?.openRouter.lastCheck?.ready || data?.openRouter.enabled
        }
        onClick={() =>
          void action("/v1/agents/cloud/enable", { confirmed: true })
        }
      >
        Enable free specialist drafts
      </button>
      <button
        disabled={!data?.openRouter.enabled}
        onClick={() => void action("/v1/agents/cloud/disable", {})}
      >
        Disable cloud access
      </button>
      <p>{data?.openRouter.reason}</p>
      <p>
        Remote agent messages use an authenticated HTTPS REST transport. No
        remote peers are enrolled. The paired Mac workspace continues to use its
        existing local connection; offline restrictions are unchanged.
      </p>
    </section>
  );
}
