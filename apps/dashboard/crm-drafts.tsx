import { useAppMemory } from "./app-memory.js";
import { QuestionChoice } from "./question-choice.js";
import { profileLabel } from "./model-profile-settings.js";
import { MailEvidenceReview } from "./mail-evidence.js";
import { AutoNoteReviewControls } from "./autonote-reviews.js";
import { CrmPublicationControls } from "./crm-publications.js";
import React, { useCallback, useEffect, useRef, useState } from "react";
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
    [allowQuestions, setAllowQuestions] = useState(false),
    [busy, setBusy] = useState(false);
  const draftMemory = useAppMemory(
    api,
    "crm",
    JSON.stringify({ selected, prompt, profile, allowQuestions }),
    busy,
  );
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
              const memorySelection = draftMemory.request();
              const fingerprint = JSON.stringify({
                memorySelection,
                selected: [...selected].sort(),
                prompt,
                profile,
                allowQuestions,
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
                  ...(allowQuestions ? { allowQuestions: true } : {}),
                  ...(memorySelection ? { memorySelection } : {}),
                  conversationId: attempt.current.conversationId,
                },
                { "Idempotency-Key": attempt.current.key },
              );
              attempt.current = null;
              draftMemory.clear();
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
            className="model-profile-select"
            id="crm-draft-profile"
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
          {draftMemory.panel}
          <QuestionChoice
            checked={allowQuestions}
            onChange={setAllowQuestions}
            disabled={busy}
          />
          <button
            disabled={
              busy ||
              draftMemory.blocked ||
              !profile ||
              !selected.length ||
              !prompt.trim()
            }
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
  sourceApp,
}: Props & { id: string; sourceApp?: string }) {
  const [detail, setDetail] = useState<any>(null),
    [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const sourceUnavailable = useCallback(() => {
    epoch.current++;
    setDetail({ unavailable: true });
  }, []);
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
      <h3>
        {sourceApp === "memory"
          ? "Source-linked memory"
          : sourceApp === "mail"
            ? "Mail"
            : sourceApp === "autonote"
              ? "AutoNote"
              : "CRM"}{" "}
        draft
      </h3>
      <p>
        Access is checked when opened and every 15 seconds while visible.
        Previously displayed or exported copies cannot be retracted.
      </p>
      {!detail ? (
        <p role="status">Checking current source access…</p>
      ) : detail.unavailable ? (
        <p role="status">
          Source access or content versions could not be confirmed. Reconnect or
          create a fresh draft after reviewing the current source content.
        </p>
      ) : (
        <>
          {detail.task.result?.text ? (
            <>
              {sourceApp === "mail" ? (
                <MailEvidenceReview
                  key={detail.task.id + ":" + detail.task.revision}
                  api={api}
                  task={detail.task}
                  onUnavailable={sourceUnavailable}
                />
              ) : (
                <div className="result">{detail.task.result.text}</div>
              )}
            </>
          ) : (
            <p>No result yet. Task status: {detail.task.status}.</p>
          )}
          <p>
            Unreviewed draft. Verify citations and claims before use.
            {sourceApp === "memory"
              ? "Source-linked memories are checked again before this result is opened or exported."
              : sourceApp === "crm"
                ? "Publication status is shown separately below."
                : sourceApp === "mail"
                  ? "Nothing has been sent or saved in Mail. Download text to review and use yourself."
                  : "Proposed owners and deadlines are unconfirmed. Send for AutoNote review using the controls below."}
          </p>
          {sourceApp === "mail" && detail.task.result?.text && (
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const generation = epoch.current;
                try {
                  const data = await api("/v1/requests/" + id + "/export");
                  if (
                    generation !== epoch.current ||
                    document.hidden ||
                    !document.hasFocus()
                  )
                    return;
                  if (
                    data.task.result?.kind !== "unreviewed_draft" ||
                    !data.task.result?.mail ||
                    typeof data.task.result.text !== "string"
                  )
                    throw Error("Mail draft unavailable");
                  const url = URL.createObjectURL(
                    new Blob([data.task.result.text], {
                      type: "text/plain;charset=utf-8",
                    }),
                  );
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = "bittrees-mail-draft.txt";
                  link.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                } catch (e) {
                  setDetail({ unavailable: true });
                  onError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Download draft text with current permission
            </button>
          )}
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
                const generation = epoch.current;
                const data = await api("/v1/requests/" + id + "/export");
                if (
                  generation !== epoch.current ||
                  document.hidden ||
                  !document.hasFocus()
                )
                  return;
                const url = URL.createObjectURL(
                    new Blob([JSON.stringify(data, null, 2)], {
                      type: "application/json",
                    }),
                  ),
                  a = document.createElement("a");
                a.href = url;
                a.download =
                  "bittrees-" +
                  (sourceApp === "memory"
                    ? "memory"
                    : sourceApp === "mail"
                      ? "mail"
                      : sourceApp === "autonote"
                        ? "autonote"
                        : "crm") +
                  "-draft.json";
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
      {sourceApp === "autonote" && (
        <AutoNoteReviewControls key={id} id={id} api={api} onError={onError} />
      )}
      {sourceApp === "crm" && (
        <CrmPublicationControls key={id} id={id} api={api} onError={onError} />
      )}
    </section>
  );
}
