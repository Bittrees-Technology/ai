import { profileLabel } from "./model-profile-settings.js";
import React, { useEffect, useRef, useState } from "react";
type Api = (
  path: string,
  method?: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<any>;
type Props = { api: Api; onError: (e: unknown) => void };
export function AutoNoteDrafts({
  api,
  onError,
  profiles,
  onCreated,
}: Props & {
  profiles: { id: string; model: string }[];
  onCreated: (id: string) => void;
}) {
  const [records, setRecords] = useState<
      { id: string; title: string; version: number }[]
    >([]),
    [selected, setSelected] = useState<string[]>([]),
    [prompt, setPrompt] = useState(
      "Summarize this meeting and suggest actions. Cite transcript segments. Leave unknown owners and deadlines empty.",
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
      <h3>Draft from your selected meeting</h3>
      <p>
        Load the one meeting approved by this connection. Summaries and
        suggested actions stay local and require review.
      </p>
      <button
        disabled={busy}
        onClick={() =>
          void act(async () => {
            setRecords([]);
            setSelected([]);
            const generation = ++viewEpoch.current;
            const data = await api(
              "/v1/connections/autonote/meetings",
              "POST",
              {},
            );
            if (
              generation === viewEpoch.current &&
              !document.hidden &&
              document.hasFocus()
            ) {
              setRecords(data.items);
              setSelected(data.items.map((m: { id: string }) => m.id));
            }
          })
        }
      >
        Load permitted meeting
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
                "/v1/connections/autonote/drafts",
                "POST",
                {
                  meetingId: selected[0],
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
          <p>
            Selected meeting: {records[0]?.title} · version{" "}
            {records[0]?.version}
          </p>
          <label htmlFor="autonote-draft-profile">Local model profile</label>
          <select className="model-profile-select"
            id="autonote-draft-profile"
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
          <label htmlFor="autonote-draft-prompt">Draft request</label>
          <textarea
            id="autonote-draft-prompt"
            required
            maxLength={32000}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <p>
            Meeting permissions and transcript versions are checked again during
            generation. Inferred owners and deadlines remain unconfirmed.
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
