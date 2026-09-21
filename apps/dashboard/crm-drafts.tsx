import { CrmPublicationControls } from "./crm-publications.js";
import React, { useEffect, useRef, useState } from "react";
type Api = (
  path: string,
  method?: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<any>;
type Props = { api: Api; onError: (e: unknown) => void };
export function CrmDrafts({
  api,
  onError,
  profiles,
  onCreated,
}: Props & {
  profiles: { id: string; model: string }[];
  onCreated: (id: string) => void;
}) {
  const [records, setRecords] = useState<
      { id: string; kind: string; name: string }[]
    >([]),
    [selected, setSelected] = useState<string[]>([]),
    [prompt, setPrompt] = useState(
      "Create a concise brief of these selected records. Cite record IDs and flag missing information.",
    ),
    [profile, setProfile] = useState(profiles[0]?.id ?? ""),
    [busy, setBusy] = useState(false);
  const viewEpoch = useRef(0);
  useEffect(() => {
    const clear = () => {
      viewEpoch.current++;
      setRecords([]);
      setSelected([]);
    };
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    return () => {
      viewEpoch.current++;
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", clear);
    };
  }, []);
  const attempt = useRef<{
    fingerprint: string;
    key: string;
    conversationId: string;
  } | null>(null);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h3>Draft from selected CRM records</h3>
      <p>
        Load the records allowed by this connection, then choose the ones for
        this draft. Nothing is published.
      </p>
      <button
        disabled={busy}
        onClick={() =>
          void act(async () => {
            setRecords([]);
            setSelected([]);
            const generation = ++viewEpoch.current;
            const data = await api("/v1/connections/crm/records", "POST", {});
            if (
              generation === viewEpoch.current &&
              !document.hidden &&
              document.hasFocus()
            )
              setRecords(data.items);
          })
        }
      >
        Load permitted records
      </button>
      {records.length > 0 && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const fingerprint = JSON.stringify({
                selected: [...selected].sort(),
                prompt,
                profile,
              });
              if (attempt.current?.fingerprint !== fingerprint)
                attempt.current = {
                  fingerprint,
                  key: crypto.randomUUID(),
                  conversationId: crypto.randomUUID(),
                };
              const task = await api(
                "/v1/connections/crm/drafts",
                "POST",
                {
                  recordIds: [...selected].sort(),
                  prompt,
                  modelProfileId: profile,
                  conversationId: attempt.current.conversationId,
                },
                { "Idempotency-Key": attempt.current.key },
              );
              attempt.current = null;
              onCreated(task.id);
            });
          }}
        >
          <fieldset>
            <legend>Include in this draft</legend>
            {records.map((r) => (
              <label key={r.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(r.id)}
                  onChange={(e) =>
                    setSelected((v) =>
                      e.target.checked
                        ? [...v, r.id]
                        : v.filter((id) => id !== r.id),
                    )
                  }
                />
                {r.name} · {r.kind}
              </label>
            ))}
          </fieldset>
          <label htmlFor="crm-draft-profile">Local model profile</label>
          <select
            id="crm-draft-profile"
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
          {!profiles.length && <p>Create a model profile in Models first.</p>}
          <label htmlFor="crm-draft-prompt">Draft request</label>
          <textarea
            id="crm-draft-prompt"
            required
            maxLength={32000}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <p>
            {selected.length} records selected. CRM permissions and record
            versions are checked again during generation.
          </p>
          <button
            disabled={busy || !profile || !selected.length || !prompt.trim()}
          >
            Create local draft
          </button>
        </form>
      )}
    </section>
  );
}
export function SourceDraftDetail({
  api,
  onError,
  id,
}: Props & { id: string }) {
  const [detail, setDetail] = useState<any>(null),
    [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  useEffect(() => {
    let active = true,
      running = false;
    const refresh = async () => {
      if (running || document.hidden || !document.hasFocus()) return;
      running = true;
      const generation = ++epoch.current;
      setDetail(null);
      try {
        const next = await api("/v1/requests/" + id + "/export");
        if (active && generation === epoch.current) setDetail(next);
      } catch {
        if (active && generation === epoch.current)
          setDetail({ unavailable: true });
      } finally {
        running = false;
      }
    };
    const hide = () => {
      epoch.current++;
      setDetail(null);
      if (!document.hidden) void refresh();
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("blur", hide);
    window.addEventListener("focus", hide);
    return () => {
      active = false;
      epoch.current++;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("blur", hide);
      window.removeEventListener("focus", hide);
    };
  }, [id]);
  return (
    <section>
      <h3>CRM draft</h3>
      <p>
        Access is checked when opened and every 15 seconds while visible.
        Previously displayed or exported copies cannot be retracted.
      </p>
      {!detail ? (
        <p role="status">Checking current source access…</p>
      ) : detail.unavailable ? (
        <p role="status">
          Source access or record versions could not be confirmed. Reconnect or
          create a fresh draft after reviewing the current records.
        </p>
      ) : (
        <>
          {detail.task.result?.text ? (
            <div className="result">{detail.task.result.text}</div>
          ) : (
            <p>No result yet. Task status: {detail.task.status}.</p>
          )}
          <p>
            Unreviewed draft. Verify citations and claims before use.
            Publication status is shown separately below.
          </p>
          <details>
            <summary>Source references and run history</summary>
            <pre>
              {JSON.stringify(
                { sources: detail.task.input.sourceRefs, runs: detail.runs },
                null,
                2,
              )}
            </pre>
          </details>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const data = await api("/v1/requests/" + id + "/export"),
                  url = URL.createObjectURL(
                    new Blob([JSON.stringify(data, null, 2)], {
                      type: "application/json",
                    }),
                  ),
                  a = document.createElement("a");
                a.href = url;
                a.download = "bittrees-crm-draft.json";
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              } catch (e) {
                setDetail({ unavailable: true });
                onError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            Export this task with current permission
          </button>
        </>
      )}
      <CrmPublicationControls key={id} id={id} api={api} onError={onError} />
    </section>
  );
}
