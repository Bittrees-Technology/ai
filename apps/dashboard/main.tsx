import { SourceDraftDetail } from "./crm-drafts.js";
import { Connections } from "./connections.js";
import { Inbox } from "./inbox.js";
import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
type Task = {
  sourceBound?: boolean;
  id: string;
  status: string;
  revision: number;
  input: { prompt: string; modelProfileId: string };
  result: null | { text?: string };
};
type Memory = {
  id: string;
  text: string;
  revision: number;
  state: string;
  pinned: boolean;
};
type Profile = { id: string; model: string };
const explanations: Record<string, string> = {
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
    "CRM denied access. Check the source grant and your current permissions.",
  INVALID_SOURCE:
    "CRM returned an unexpected response. No source content was accepted.",
  UNAUTHORIZED: "Pair this browser to continue.",
  CONFLICT: "This item changed. Refresh and try again.",
  MODEL_UNAVAILABLE: "Start Ollama and check your installed models.",
  CAPACITY: "Shorten the request or choose a larger model context.",
  PAIRING_DENIED:
    "Code incorrect, expired or already used. Restart the companion for a new code.",
  FORBIDDEN: "This request is not permitted.",
  INVALID_INPUT: "Check your entries and try again.",
};
async function api(
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: "INTERNAL" }));
    throw Error(data.error);
  }
  return response.status === 204 ? null : response.json();
}
function App() {
  const [paired, setPaired] = useState(false),
    [page, setPage] = useState("Tasks"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [code, setCode] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]),
    [memories, setMemories] = useState<Memory[]>([]),
    [profiles, setProfiles] = useState<Profile[]>([]),
    [models, setModels] = useState<{ name: string }[]>([]),
    [runs, setRuns] = useState<any[]>([]);
  const [selected, setSelected] = useState(""),
    [prompt, setPrompt] = useState(""),
    [profile, setProfile] = useState(""),
    [model, setModel] = useState(""),
    [memoryIds, setMemoryIds] = useState<string[]>([]),
    [candidate, setCandidate] = useState(""),
    [deleteText, setDeleteText] = useState("");
  const epoch = useRef(0);
  const submission = useRef<{
    fingerprint: string;
    key: string;
    body: unknown;
  } | null>(null);
  const task = tasks.find((t) => t.id === selected);
  function clear() {
    epoch.current++;
    submission.current = null;
    setProfiles([]);
    setModels([]);
    setProfile("");
    setPaired(false);
    setTasks([]);
    setMemories([]);
    setRuns([]);
    setPrompt("");
    setCandidate("");
    setSelected("");
    setMemoryIds([]);
  }
  function fail(e: unknown) {
    const key = e instanceof Error ? e.message : "";
    setError(
      explanations[key] ??
        "Could not complete the request. Check that the companion is running and try again.",
    );
    if (key === "UNAUTHORIZED") clear();
  }
  async function refresh() {
    const version = epoch.current;
    const [t, m, p] = await Promise.all([
      api("/v1/requests"),
      api("/v1/memories"),
      api("/v1/profiles"),
    ]);
    if (version !== epoch.current) return;
    setTasks(t.items);
    setMemories(m.items);
    setProfiles(p.items);
    setProfile((old) => old || p.defaultProfile?.id || p.items[0]?.id || "");
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
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
    if (task?.sourceBound) {
      setRuns([]);
      return;
    }
    if (selected && paired)
      api("/v1/requests/" + selected + "/runs")
        .then((r) => {
          if (active) setRuns(r.items);
        })
        .catch(fail);
    return () => {
      active = false;
    };
  }, [selected, task?.revision, task?.sourceBound, paired]);
  useEffect(() => {
    if (page === "Models" && paired)
      api("/v1/models")
        .then((r) => {
          setModels(r.items);
          setModel(r.items[0]?.name ?? "");
        })
        .catch(fail);
  }, [page, paired]);
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
          {["Tasks", "Inbox", "Memory", "Models", "Device", "Connections"].map(
            (name) => (
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
            ),
          )}
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
          <>
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
                    <label>
                      Model profile
                      <select
                        required
                        value={profile}
                        onChange={(e) => setProfile(e.target.value)}
                      >
                        <option value="">Choose a profile</option>
                        {profiles.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.model}
                          </option>
                        ))}
                      </select>
                    </label>
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
                      {task.sourceBound && (
                        <SourceDraftDetail
                          key={task.id}
                          id={task.id}
                          api={api}
                          onError={fail}
                        />
                      )}
                      {task.result?.text && (
                        <>
                          <h3>Draft result</h3>
                          <p className="hint">
                            Review before using. Nothing has been published.
                          </p>
                          <div className="result">{task.result.text}</div>
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
                                  { text: candidate, type: "fact" },
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
                      ) && (
                        <button
                          onClick={() => {
                            setPrompt(task.input.prompt);
                            setProfile(task.input.modelProfileId);
                          }}
                        >
                          Use prompt again
                        </button>
                      )}
                      <h3>Run history</h3>
                      {runs.map((r) => (
                        <p key={r.id}>
                          {r.outcome ?? "Running"} ·{" "}
                          {r.model?.profile?.model ?? "Model not started"}
                        </p>
                      ))}
                      {!runs.length && (
                        <p className="hint">Waiting to start.</p>
                      )}
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
                      const id = crypto.randomUUID();
                      await api("/v1/profiles", "POST", {
                        id,
                        runtime: "ollama",
                        model,
                        contextTokens: 4096,
                        maxOutputTokens: 512,
                        temperature: 0.2,
                      });
                      await api("/v1/profiles/default", "PUT", {
                        profileId: id,
                      });
                      setProfile(id);
                      await refresh();
                    });
                  }}
                >
                  <label>
                    Installed model
                    <select
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
                  <p className="hint">
                    Profiles use 4,096 context tokens and up to 512 output
                    tokens.
                  </p>
                  <button className="primary" disabled={busy || !model}>
                    Create profile and use by default
                  </button>
                </form>
                <h3>Saved profiles</h3>
                {profiles.map((p) => (
                  <div className="row" key={p.id}>
                    <span>
                      {p.model}
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
                <p className="hint">
                  The reviewed file-import interface is still being built.
                </p>
              </section>
            )}
            {page === "Memory" && (
              <section className="content">
                <h2>Keep what helps</h2>
                <p>
                  Candidates need your review before a task can use them.
                  Approval does not make a statement verified.
                </p>
                {!memories.length && (
                  <p className="emptyline">
                    Save a candidate from a completed task to begin.
                  </p>
                )}
                {memories.map((m) => (
                  <article className="memory" key={m.id}>
                    <div className="status">
                      {m.state}
                      {m.pinned ? " · Pinned" : ""}
                    </div>
                    <p className="prose">{m.text}</p>
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
                <h3>Your data</h3>
                <p>
                  Tasks and memory stay until you delete them. Your key is
                  stored in macOS Keychain. Exports contain readable content;
                  older exports and backups have their own lifecycle.
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
                <div className="danger">
                  <h3>Delete local tasks and memory</h3>
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
                        epoch.current++;
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
          </>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
