import { SourceMemoryCapture } from "./source-memory-capture.js";
import { ResumePermissions } from "./resume-permissions.js";
import { QuestionChoice } from "./question-choice.js";
import { ModelProfileFields } from "./model-profile-fields.js";
import {
  defaultProfileFields,
  readProfileFields,
  profileLabel,
  profileSettingsText,
} from "./model-profile-settings.js";
import { workspaceApi } from "./workspace-api.js";
import { TaskRuns } from "./task-runs.js";
import { TaskQualityReview } from "./task-quality-review.js";
import { DependencyFailureNotice } from "./dependency-failure.js";
import { RecoveryCopies } from "./recovery-copies.js";
import { requestBackup } from "./backup-download.js";
import { createLocalApi } from "./local-api.js";
import { MemorySuggestions } from "./memory-suggestions.js";
import { MemorySearch } from "./memory-search.js";
import { Templates } from "./templates.js";
import { ModelImportControls } from "./imports.js";
import { DeviceResources } from "./device.js";
import { SourceDraftDetail } from "./crm-drafts.js";
import { Connections } from "./connections.js";
import { Inbox } from "./inbox.js";
import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
type Task = {
  sourceBound?: boolean;
  dependencyAccess?: "unavailable";
  sourceApp?: string;
  id: string;
  status: string;
  revision: number;
  input: { prompt: string; modelProfileId: string };
  result: null | { text?: string; kind?: string };
};
type Memory = {
  type: string;
  origin: "user" | "model";
  expiresAt: number | null;
  sources: { app: string; resourceId: string; revision: string }[];
  id: string;
  text: string;
  revision: number;
  state: string;
  pinned: boolean;
};
type Profile = {
  id: string;
  model: string;
  contextTokens: number;
  maxOutputTokens: number;
  temperature: number;
};
const explanations: Record<string, string> = {
  LOCAL_TIMEOUT:
    "The companion took too long to respond. A submitted action may already have completed. Check task history before retrying it; drafts stay here.",
  LOCAL_UNAVAILABLE:
    "Cannot reach the companion on this Mac. Open Bittrees AI and check the connection. A submitted action may already have completed; check its status before retrying.",
  LOCAL_INVALID_RESPONSE:
    "The companion returned an unreadable response. Check its status before retrying a submitted action. No automatic retry was made.",
  REMOTE_TEMPLATE_CAPACITY:
    "A remote template limit was reached. Review existing permissions and run allowances, then refresh before retrying.",
  TEMPLATE_CONFIRMATION_REQUIRED:
    "This permission needs a fresh review. Refresh the remote connection, revoke the old permission if listed, and review the saved template again.",
  TEMPLATE_CAPACITY:
    "You have 100 saved templates. Delete one before adding another.",
  IMPORT_BUSY:
    "Another model import operation is still running. Wait or cancel it first.",
  REVIEW_MISMATCH:
    "The saved review does not match this action. Refresh the import list.",
  REVIEW_EXPIRED:
    "This review expired. Delete the staged import and begin a fresh review.",
  CONNECTION_REQUIRED: "Connect CRM first.",
  CONNECTION_EXPIRED:
    "This connection expired. Revoke it in CRM, then connect again.",
  CONNECTION_BUSY: "A connection change is still running. Wait a moment.",
  INVALID_CONNECTION:
    "This connection could not be completed. Begin again with a fresh code.",
  SOURCE_CONFLICT:
    "The source or review changed. Inspect the existing operation before creating a new proposal.",
  SOURCE_CAPACITY:
    "CRM has too many pending requests. Wait or clear pending reviews before trying again.",
  SOURCE_UNAVAILABLE:
    "CRM did not respond. If a code exchange failed, begin again with a fresh code.",
  SOURCE_DENIED:
    "CRM denied this request. Check the grant and current permissions; publishing also requires exact approval on CRM.",
  INVALID_SOURCE:
    "CRM returned an unexpected response. No source content was accepted.",
  UNAUTHORIZED: "Pair this browser to continue.",
  CONFLICT:
    "This item changed or an operation is still running. Wait for it to finish, then refresh and try again.",
  MODEL_UNAVAILABLE: "Start Ollama and check your installed models.",
  CAPACITY:
    "A size or capacity limit was reached. Shorten the request, review pending work, or free saved storage before retrying.",
  PAIRING_DENIED:
    "Code incorrect, expired or already used. Restart the companion for a new code.",
  FORBIDDEN: "This request is not permitted.",
  INVALID_INPUT: "Check your entries and try again.",
  INVALID_OUTPUT:
    "The model’s answer did not meet the required format or evidence rules. Start a fresh draft with another model or a revised request.",
};
const transport = createLocalApi();
function App() {
  const requests = useRef<ReturnType<typeof workspaceApi> | null>(null);
  requests.current ??= workspaceApi(transport);
  const api = requests.current.api;
  const refreshSequence = useRef(0);
  const [profileFields, setProfileFields] = useState({
    ...defaultProfileFields,
  });
  const checkedProfile = readProfileFields(profileFields);
  const [paired, setPaired] = useState(false),
    [page, setPage] = useState("Tasks"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [code, setCode] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]),
    [memories, setMemories] = useState<Memory[]>([]),
    [profiles, setProfiles] = useState<Profile[]>([]),
    [models, setModels] = useState<{ name: string }[]>([]);
  const [selected, setSelected] = useState(""),
    [prompt, setPrompt] = useState(""),
    [profile, setProfile] = useState(""),
    [allowQuestions, setAllowQuestions] = useState(false),
    [model, setModel] = useState(""),
    [memoryIds, setMemoryIds] = useState<string[]>([]),
    [candidate, setCandidate] = useState(""),
    [candidateType, setCandidateType] = useState("fact"),
    [deleteText, setDeleteText] = useState("");
  const epoch = useRef(0);
  const backupUrl = useRef<string | null>(null);
  useEffect(
    () => () => {
      epoch.current++;
      requests.current?.invalidate();
      if (backupUrl.current) URL.revokeObjectURL(backupUrl.current);
    },
    [],
  );
  const submission = useRef<{
    fingerprint: string;
    key: string;
    body: unknown;
  } | null>(null);
  const task = tasks.find((t) => t.id === selected);
  const selectedProfileSettings = profileSettingsText(
    profiles.find((p) => p.id === profile) ?? {},
  );
  function resetRequests() {
    epoch.current++;
    requests.current!.invalidate();
    requests.current = workspaceApi(transport);
    setBusy(false);
  }
  function clear() {
    resetRequests();
    if (backupUrl.current) URL.revokeObjectURL(backupUrl.current);
    backupUrl.current = null;
    submission.current = null;
    setProfiles([]);
    setModels([]);
    setProfile("");
    setPaired(false);
    setTasks([]);
    setMemories([]);
    setModel("");
    setProfileFields({ ...defaultProfileFields });
    setCode("");
    setDeleteText("");
    setPrompt("");
    setAllowQuestions(false);
    setCandidate("");
    setCandidateType("fact");
    setSelected("");
    setMemoryIds([]);
  }
  function fail(e: unknown) {
    const key = e instanceof Error ? e.message : "";
    if (key === "WORKSPACE_CHANGED") return;
    setError(
      explanations[key] ??
        "Could not complete the request. Check that the companion is running and try again.",
    );
    if (key === "UNAUTHORIZED") clear();
  }
  const memoryViewEpoch = useRef(0);
  useEffect(() => {
    const hide = () => {
      memoryViewEpoch.current++;
      setMemories([]);
      setCandidate("");
    };
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", hide);
    };
  }, []);
  async function refresh() {
    const version = epoch.current,
      memoryView = memoryViewEpoch.current,
      sequence = ++refreshSequence.current;
    const currentApi = requests.current!.api;
    try {
      const [t, m, p] = await Promise.all([
        currentApi("/v1/requests"),
        currentApi("/v1/memories"),
        currentApi("/v1/profiles"),
      ]);
      if (version !== epoch.current || sequence !== refreshSequence.current)
        return;
      setTasks(t.items);
      if (
        memoryView === memoryViewEpoch.current &&
        !document.hidden &&
        document.hasFocus()
      )
        setMemories(m.items);
      setProfiles(p.items);
      setProfile((old) => old || p.defaultProfile?.id || p.items[0]?.id || "");
    } catch (error) {
      if (version === epoch.current && sequence === refreshSequence.current)
        throw error;
    }
  }
  async function action(fn: () => Promise<void>) {
    const version = epoch.current;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (version === epoch.current) fail(e);
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  }
  useEffect(() => {
    api("/v1/health")
      .then(() => setPaired(true))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!paired) return;
    let active = true,
      running = false;
    const poll = async () => {
      if (running) return;
      running = true;
      try {
        await refresh();
      } catch (e) {
        if (active) fail(e);
      } finally {
        running = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [paired]);
  useEffect(() => {
    let active = true;
    if (page === "Models" && paired)
      api("/v1/models")
        .then((r) => {
          if (!active) return;
          setModels(r.items);
          setModel(r.items[0]?.name ?? "");
        })
        .catch((e) => {
          if (active) fail(e);
        });
    return () => {
      active = false;
    };
  }, [page, paired, api]);
  const command = (command: string) =>
    action(async () => {
      await api("/v1/requests/" + task!.id + "/commands", "POST", {
        command,
        expectedRevision: task!.revision,
      });
      await refresh();
    });
  return (
    <div className="shell">
      <aside>
        <a className="brand" href="/">
          <span className="mark">b</span>Bittrees <strong>AI</strong>
        </a>
        <p className="local">On this Mac</p>
        <nav aria-label="Main">
          {[
            "Tasks",
            "Templates",
            "Inbox",
            "Memory",
            "Models",
            "Device",
            "Connections",
          ].map((name) => (
            <button
              key={name}
              aria-current={page === name ? "page" : undefined}
              onClick={() => {
                setPage(name);
                setError("");
              }}
            >
              {name}
            </button>
          ))}
        </nav>
        <p className="privacy">
          Your work stays here.
          <br />
          Remote access is not enabled.
        </p>
      </aside>
      <main>
        <header>
          <div>
            <h1>{paired ? page : "Your local workspace"}</h1>
            <p>Bittrees AI companion</p>
          </div>
          {paired && (
            <button
              onClick={() =>
                action(async () => {
                  await api("/logout", "POST");
                  clear();
                })
              }
            >
              Lock workspace
            </button>
          )}
        </header>
        {error && (
          <div className="error" role="alert">
            {error}
            <button onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
        {!paired ? (
          <section className="pair">
            <h2>Connect to this Mac</h2>
            <p>
              Enter the one-time code from the pairing-code file shown when the
              companion started. It expires after ten minutes.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  await api("/pair", "POST", { code: code.trim() });
                  setCode("");
                  setPaired(true);
                });
              }}
            >
              <label>
                Pairing code
                <input
                  type="password"
                  autoComplete="off"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                />
              </label>
              <button className="primary" disabled={busy}>
                Open workspace
              </button>
            </form>
            <p className="hint">
              Restart the companion to pair another browser session.
            </p>
          </section>
        ) : (
          <React.Fragment key={epoch.current}>
            {page === "Tasks" && (
              <div className="workspace">
                <section className="queue">
                  <h2>Start something</h2>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void action(async () => {
                        const fingerprint = JSON.stringify({
                          prompt,
                          profile,
                          memoryIds,
                          allowQuestions,
                        });
                        if (submission.current?.fingerprint !== fingerprint)
                          submission.current = {
                            fingerprint,
                            key: crypto.randomUUID(),
                            body: {
                              conversationId: crypto.randomUUID(),
                              kind: "query",
                              prompt,
                              modelProfileId: profile,
                              memoryIds,
                              ...(allowQuestions
                                ? { allowQuestions: true }
                                : {}),
                            },
                          };
                        const t = await api(
                          "/v1/requests",
                          "POST",
                          submission.current.body,
                          { "Idempotency-Key": submission.current.key },
                        );
                        submission.current = null;
                        setPrompt("");
                        setSelected(t.id);
                        await refresh();
                      });
                    }}
                  >
                    <label>
                      What would you like to work on?
                      <textarea
                        required
                        maxLength={32000}
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        placeholder="Ask a question or draft something…"
                      />
                    </label>
                    <label
                      className="model-profile-choice"
                      htmlFor="task-model-profile"
                    >
                      <span id="task-model-profile-label">Model profile</span>
                      <select
                        id="task-model-profile"
                        aria-labelledby="task-model-profile-label"
                        aria-describedby={
                          selectedProfileSettings
                            ? "task-profile-settings"
                            : undefined
                        }
                        required
                        value={profile}
                        onChange={(e) => setProfile(e.target.value)}
                      >
                        <option value="">Choose a profile</option>
                        {profiles.map((p) => (
                          <option key={p.id} value={p.id}>
                            {profileLabel(p)}
                          </option>
                        ))}
                      </select>
                    </label>
                    {selectedProfileSettings && (
                      <p id="task-profile-settings" className="hint">
                        {selectedProfileSettings}
                      </p>
                    )}
                    {!profiles.length && (
                      <p className="hint">
                        Create a profile in Models to begin.
                      </p>
                    )}
                    <details>
                      <summary>
                        Include reviewed memory ({memoryIds.length}/8)
                      </summary>
                      {memories
                        .filter((m) => m.state === "approved")
                        .map((m) => (
                          <label className="check" key={m.id}>
                            <input
                              type="checkbox"
                              checked={memoryIds.includes(m.id)}
                              disabled={
                                !memoryIds.includes(m.id) &&
                                memoryIds.length >= 8
                              }
                              onChange={(e) =>
                                setMemoryIds((ids) =>
                                  e.target.checked
                                    ? [...ids, m.id]
                                    : ids.filter((id) => id !== m.id),
                                )
                              }
                            />
                            {m.text}
                          </label>
                        ))}
                    </details>
                    <QuestionChoice
                      checked={allowQuestions}
                      onChange={setAllowQuestions}
                      disabled={busy}
                    />
                    <button className="primary" disabled={busy || !profile}>
                      Start task
                    </button>
                  </form>
                  <h2 className="recent">Recent work</h2>
                  {!tasks.length && (
                    <p className="hint">Your first task will appear here.</p>
                  )}
                  <div className="tasklist">
                    {tasks.map((t) => (
                      <button
                        key={t.id}
                        className={selected === t.id ? "chosen" : ""}
                        onClick={() => setSelected(t.id)}
                      >
                        <span>{t.input.prompt.slice(0, 100)}</span>
                        <small>{t.status.replaceAll("_", " ")}</small>
                      </button>
                    ))}
                  </div>
                </section>
                <section className="detail">
                  {task ? (
                    <>
                      <div className="status">
                        {task.status.replaceAll("_", " ")}
                      </div>
                      <h2>Task detail</h2>
                      <p className="prose">{task.input.prompt}</p>
                      <div className="actions">
                        {["queued", "running"].includes(task.status) && (
                          <button
                            disabled={busy}
                            onClick={() => command("pause")}
                          >
                            Pause
                          </button>
                        )}
                        {task.status === "paused" && (
                          <button
                            disabled={busy}
                            onClick={() => command("resume")}
                          >
                            Resume
                          </button>
                        )}
                        {![
                          "completed",
                          "failed",
                          "cancelled",
                          "expired",
                        ].includes(task.status) && (
                          <button
                            disabled={busy}
                            onClick={() => command("cancel")}
                          >
                            Cancel task
                          </button>
                        )}
                        {["queued", "running", "paused"].includes(
                          task.status,
                        ) && (
                          <button
                            disabled={busy || !profile}
                            onClick={() =>
                              action(async () => {
                                await api(
                                  "/v1/requests/" + task.id + "/model",
                                  "POST",
                                  {
                                    profileId: profile,
                                    expectedRevision: task.revision,
                                  },
                                );
                                await refresh();
                              })
                            }
                          >
                            Use selected profile
                          </button>
                        )}
                      </div>
                      <ResumePermissions
                        key={`${task.id}:${task.revision}:${task.status}`}
                        api={api}
                        taskId={task.id}
                        taskRevision={task.revision}
                        status={task.status}
                      />
                      {task.dependencyAccess === "unavailable" && (
                        <p role="status">
                          A source or memory used by this task is no longer
                          available or has changed. Its content and history are
                          hidden. Create a new task with current references to
                          continue.
                        </p>
                      )}
                      {task.sourceBound && (
                        <SourceDraftDetail
                          key={task.id}
                          id={task.id}
                          sourceApp={task.sourceApp}
                          api={api}
                          onError={fail}
                        />
                      )}
                      {task.status === "completed" && task.sourceBound && (
                        <SourceMemoryCapture
                          key={task.id + ":" + task.revision}
                          taskId={task.id}
                          sourceApp={task.sourceApp}
                          api={api}
                        />
                      )}
                      {task.status === "completed" &&
                        !task.sourceBound &&
                        !task.dependencyAccess &&
                        (task.result?.text ||
                          task.result?.kind === "memory_candidates") && (
                          <MemorySuggestions
                            key={task.id + ":" + task.revision}
                            taskId={task.id}
                            revision={task.revision}
                            profileId={profile}
                            extraction={
                              task.result?.kind === "memory_candidates"
                            }
                            api={api}
                            onError={fail}
                          />
                        )}
                      {task.status === "failed" && (
                        <DependencyFailureNotice result={task.result} />
                      )}
                      {task.result?.text && (
                        <>
                          <h3>Draft result</h3>
                          <p className="hint">
                            Review before using. Nothing has been published.
                          </p>
                          <div className="result">{task.result.text}</div>
                          <label>
                            Memory type
                            <select
                              value={candidateType}
                              onChange={(event) =>
                                setCandidateType(event.target.value)
                              }
                            >
                              <option value="preference">Preference</option>
                              <option value="fact">Fact</option>
                              <option value="decision">Decision</option>
                              <option value="outcome">Outcome</option>
                              <option value="procedure">Procedure</option>
                            </select>
                          </label>
                          <label>
                            Save a memory candidate
                            <textarea
                              maxLength={16000}
                              value={candidate}
                              onChange={(e) => setCandidate(e.target.value)}
                              placeholder="Write the useful fact or preference to retain."
                            />
                          </label>
                          <button
                            disabled={busy || !candidate.trim()}
                            onClick={() =>
                              action(async () => {
                                await api(
                                  "/v1/requests/" + task.id + "/memories",
                                  "POST",
                                  { text: candidate, type: candidateType },
                                );
                                setCandidate("");
                                await refresh();
                                setPage("Memory");
                              })
                            }
                          >
                            Save for review
                          </button>
                        </>
                      )}
                      {["failed", "cancelled", "expired", "completed"].includes(
                        task.status,
                      ) &&
                        !task.dependencyAccess && (
                          <button
                            onClick={() => {
                              setPrompt(task.input.prompt);
                              setProfile(task.input.modelProfileId);
                            }}
                          >
                            Use prompt again
                          </button>
                        )}
                      {task.status === "completed" &&
                        !task.dependencyAccess && (
                          <TaskQualityReview
                            key={task.id + ":" + task.revision}
                            taskId={task.id}
                            api={api}
                          />
                        )}
                      <TaskRuns
                        key={
                          task.id +
                          ":" +
                          task.revision +
                          ":" +
                          !!task.sourceBound
                        }
                        taskId={task.id}
                        sourceBound={task.sourceBound}
                        dependencyUnavailable={!!task.dependencyAccess}
                        status={task.status}
                        api={api}
                        onError={fail}
                      />
                    </>
                  ) : (
                    <div className="empty">
                      <div className="tree">⌘</div>
                      <h2>A little room to think.</h2>
                      <p>
                        Start a task or open recent work.
                        <br />
                        Results and their history stay together.
                      </p>
                    </div>
                  )}
                </section>
              </div>
            )}
            {page === "Templates" && (
              <Templates
                api={api}
                profiles={profiles}
                onError={fail}
                onTask={(id) => {
                  setSelected(id);
                  setPage("Tasks");
                  void refresh().catch(fail);
                }}
              />
            )}
            {page === "Models" && (
              <section className="content">
                <h2>Choose your local model</h2>
                <p>
                  Ollama must be running on this Mac. Models retain their own
                  licenses. Tool execution is disabled.
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void action(async () => {
                      const settings = readProfileFields(profileFields).value;
                      if (!settings) throw Error("INVALID_INPUT");
                      const id = crypto.randomUUID();
                      await api("/v1/profiles", "POST", {
                        id,
                        runtime: "ollama",
                        model,
                        ...settings,
                      });
                      await api("/v1/profiles/default", "PUT", {
                        profileId: id,
                      });
                      setProfile(id);
                      await refresh();
                    });
                  }}
                >
                  <label htmlFor="installed-model">
                    <span id="installed-model-label">Installed model</span>
                    <select
                      id="installed-model"
                      aria-labelledby="installed-model-label"
                      value={model}
                      required
                      onChange={(e) => setModel(e.target.value)}
                    >
                      <option value="">Choose a model</option>
                      {models.map((m) => (
                        <option key={m.name}>{m.name}</option>
                      ))}
                    </select>
                  </label>
                  <ModelProfileFields
                    value={profileFields}
                    change={setProfileFields}
                    disabled={busy}
                  />
                  <button
                    className="primary"
                    disabled={busy || !model || !checkedProfile.value}
                  >
                    Create profile and use by default
                  </button>
                </form>
                <h3>Saved profiles</h3>
                {profiles.map((p) => (
                  <div className="row saved-model-profile" key={p.id}>
                    <span>
                      <strong>{p.model}</strong>
                      <small>{profileSettingsText(p)}</small>
                      <small>Profile {p.id}</small>
                      <small>
                        {p.id === profile
                          ? "Selected for new work"
                          : "Saved profile"}
                      </small>
                    </span>
                    <button
                      onClick={() =>
                        action(async () => {
                          await api("/v1/profiles/default", "PUT", {
                            profileId: p.id,
                          });
                          setProfile(p.id);
                          await refresh();
                        })
                      }
                    >
                      Use by default
                    </button>
                  </div>
                ))}
                <ModelImportControls
                  api={api}
                  onError={fail}
                  onInstalled={() => {
                    void api("/v1/models")
                      .then((r) => setModels(r.items))
                      .catch(fail);
                  }}
                />
              </section>
            )}
            {page === "Memory" && (
              <section className="content">
                <h2>Keep what helps</h2>
                <p>
                  Candidates need your review before a task can use them.
                  Approval does not make a statement verified. Source-linked
                  memories need current source access, including when a later
                  task uses them.
                </p>
                <MemorySearch
                  key={memories.map((m) => `${m.id}:${m.revision}`).join("|")}
                  api={api}
                  onError={fail}
                />
                <h3>Review saved memory</h3>
                {!memories.length && (
                  <p className="emptyline">
                    Save a candidate from a completed task to begin.
                  </p>
                )}
                {memories.map((m) => (
                  <article className="memory" key={m.id}>
                    <div className="status">
                      {m.type} · {m.state}
                      {m.pinned ? " · Pinned" : ""}
                    </div>
                    <p className="prose">{m.text}</p>
                    <details>
                      <summary>Source and retention</summary>
                      <p>
                        {m.origin === "model"
                          ? "Model-generated candidate."
                          : "User-entered candidate."}{" "}
                        Review does not verify the statement.
                      </p>
                      <p>
                        {m.expiresAt === null
                          ? "Kept until you delete it while its source remains accessible."
                          : `Available until ${new Date(m.expiresAt).toLocaleString()} while its source remains accessible.`}{" "}
                        Older exports and backups are separate copies.
                      </p>
                      <ul>
                        {m.sources.map((source, index) => (
                          <li key={index}>
                            {source.app === "local"
                              ? "Companion task"
                              : source.app + " source"}{" "}
                            <code>{source.resourceId}</code>, version{" "}
                            {source.revision}.
                          </li>
                        ))}
                      </ul>
                    </details>
                    <div className="actions">
                      <button
                        disabled={busy}
                        onClick={() =>
                          action(async () => {
                            await api("/v1/memories/" + m.id, "PATCH", {
                              revision: m.revision,
                              approve: m.state !== "approved",
                            });
                            await refresh();
                          })
                        }
                      >
                        {m.state === "approved"
                          ? "Return to review"
                          : "Approve"}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          action(async () => {
                            await api("/v1/memories/" + m.id, "PATCH", {
                              revision: m.revision,
                              pinned: !m.pinned,
                            });
                            await refresh();
                          })
                        }
                      >
                        {m.pinned ? "Unpin" : "Pin"}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => {
                          const text = window.prompt("Edit memory", m.text);
                          if (text)
                            void action(async () => {
                              await api("/v1/memories/" + m.id, "PATCH", {
                                revision: m.revision,
                                text,
                                approve: false,
                              });
                              await refresh();
                            });
                        }}
                      >
                        Edit
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => {
                          if (
                            confirm(
                              "Forget this memory? Earlier results and exports may still contain it.",
                            )
                          )
                            void action(async () => {
                              await api("/v1/memories/" + m.id, "DELETE");
                              setMemoryIds((ids) =>
                                ids.filter((id) => id !== m.id),
                              );
                              await refresh();
                            });
                        }}
                      >
                        Forget
                      </button>
                    </div>
                  </article>
                ))}
              </section>
            )}
            <div hidden={page !== "Inbox"}>
              <Inbox key={epoch.current} api={api} onError={fail} />
            </div>
            {page === "Connections" && (
              <Connections
                api={api}
                onError={fail}
                profiles={profiles}
                onCreated={(id) => {
                  setSelected(id);
                  setPage("Tasks");
                  void refresh().catch(fail);
                }}
              />
            )}
            {page === "Device" && (
              <section className="content">
                <h2>This Mac</h2>
                <p>
                  The companion runs locally. Remote access and shared-device
                  execution are disabled.
                </p>
                <DeviceResources api={api} />
                <h3>Your data</h3>
                <p>
                  Tasks, templates and memory stay until you delete them. Your
                  key is stored in macOS Keychain. Exports contain readable
                  content; older exports and backups have their own lifecycle.
                </p>
                <button
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      const data = await api("/v1/export"),
                        url = URL.createObjectURL(
                          new Blob([JSON.stringify(data, null, 2)], {
                            type: "application/json",
                          }),
                        ),
                        link = document.createElement("a");
                      link.href = url;
                      link.download = "bittrees-ai-export.json";
                      link.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    })
                  }
                >
                  Export my local data
                </button>
                <RecoveryCopies api={api} onError={fail} />
                <h3>Encrypted backup</h3>
                <p>
                  Save this device's tasks and memories together. Restoring
                  requires the original storage key from this Mac's Keychain.
                  This file does not recover a lost key, app connections or
                  model files. In the Mac app, choose Restore from backup from
                  the Bittrees AI menu.
                </p>
                <button
                  disabled={busy}
                  onClick={() => {
                    if (
                      !confirm(
                        "Create an encrypted task-and-memory backup? Keep the original storage key: this file alone cannot recover data after losing that key.",
                      )
                    )
                      return;
                    void action(async () => {
                      const version = epoch.current;
                      const blob = await requestBackup();
                      if (version !== epoch.current) return;
                      if (backupUrl.current)
                        URL.revokeObjectURL(backupUrl.current);
                      const url = URL.createObjectURL(blob),
                        link = document.createElement("a");
                      backupUrl.current = url;
                      link.href = url;
                      link.download = "bittrees-ai-content.aib";
                      link.click();
                      // Keep the URL while the native save sheet is open; release
                      // on the next backup, session clear or component unmount.
                    });
                  }}
                >
                  Download encrypted backup
                </button>
                <div className="danger">
                  <h3>Delete local tasks, templates, memory and device keys</h3>
                  <p>
                    This clears the current copy. Delete older recovery copies
                    above and backup files saved elsewhere separately.
                  </p>
                  <p>
                    This also removes this Mac’s private device keys. History
                    encrypted to them may become unreadable. The storage
                    recovery kit does not include these keys. Remote copies and
                    earlier exports are not deleted.
                  </p>
                  <label>
                    Type DELETE to confirm
                    <input
                      value={deleteText}
                      onChange={(e) => setDeleteText(e.target.value)}
                    />
                  </label>
                  <button
                    disabled={busy || deleteText !== "DELETE"}
                    onClick={() =>
                      action(async () => {
                        await api("/v1/data", "DELETE", undefined, {
                          "X-Confirm-Delete": "all-local-task-data",
                        });
                        resetRequests();
                        setTasks([]);
                        setMemories([]);
                        setProfiles([]);
                        setDeleteText("");
                        setSelected("");
                        setMemoryIds([]);
                        setProfile("");
                        await refresh();
                      })
                    }
                  >
                    Delete local data
                  </button>
                </div>
              </section>
            )}
          </React.Fragment>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
