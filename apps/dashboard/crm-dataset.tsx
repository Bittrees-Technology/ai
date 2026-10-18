import React, { useEffect, useState } from "react";
type Props = {
  manageData?: boolean;
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
  onError: (e: unknown) => void;
};
const base = "/v1/connections/dataset";
export function CrmDatasetPanel({ api, onError, manageData = false }: Props) {
  const [connection, setConnection] = useState<any>(null),
    [available, setAvailable] = useState(false),
    [key, setKey] = useState("");
  const [snapshot, setSnapshot] = useState<any>(null),
    [text, setText] = useState(""),
    [preview, setPreview] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  useEffect(() => {
    api(base)
      .then((s) => {
        setAvailable(s.available);
        setConnection(s.connection);
      })
      .catch(onError);
  }, []);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  async function read() {
    const s = await api(base + "/read", "POST", {});
    setSnapshot(s);
    setText(
      JSON.stringify(
        { version: s.version, name: s.name, entries: s.entries },
        null,
        2,
      ),
    );
    setPreview(null);
  }
  return (
    <article
      className="card crm-dataset-panel"
      aria-label="CRM dataset connection"
    >
      <h3>CRM dataset</h3>
      <p>
        Connect one private dataset. CRM access follows your selected project
        permissions. New researched leads enter CRM automatically only when you
        enable automatic additions for a destination project.
      </p>
      {!available ? (
        <p>Dataset connections are unavailable in this build.</p>
      ) : (
        <fieldset disabled={busy}>
          <p>
            <a
              href="https://crm.bittrees.org/connect/ai/projects"
              target="_blank"
              rel="noreferrer"
            >
              Manage Local AI in CRM
            </a>
          </p>
          <label>
            Dataset MCP configuration or connection key
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <button
            disabled={!key.trim()}
            onClick={() =>
              void act(async () => {
                if (
                  connection &&
                  !confirm(
                    "Replace this local dataset connection? The old credential remains active in CRM until you revoke it there.",
                  )
                )
                  return;
                let token = key.trim();
                if (token.startsWith("{")) {
                  const config = JSON.parse(token);
                  const servers = Object.values(
                    config.mcpServers || {},
                  ) as any[];
                  if (
                    servers.length !== 1 ||
                    servers[0].url !==
                      "https://crm.bittrees.org/api/integrations/datasets/mcp"
                  )
                    throw new Error(
                      "Use the single-dataset configuration copied from CRM.",
                    );
                  token = (servers[0].headers?.Authorization || "").replace(
                    /^Bearer /,
                    "",
                  );
                }
                setConnection(await api(base + "/connect", "POST", { token }));
                setKey("");
                setSnapshot(null);
                setText("");
                setPreview(null);
                setMessage(
                  "Dataset connected. The credential is stored in this Mac’s Keychain.",
                );
              })
            }
          >
            Connect dataset
          </button>
          {connection && (
            <>
              <p>
                Connected: {connection.name} · {connection.datasetId}
              </p>
              {manageData && (
                <button
                  onClick={() =>
                    void act(async () => {
                      if (
                        text &&
                        !confirm(
                          "Reload the saved dataset? Unsaved edits in this panel will be discarded.",
                        )
                      )
                        return;
                      await read();
                      setMessage(
                        "Loaded saved research and current linked CRM records.",
                      );
                    })
                  }
                >
                  Read dataset and linked CRM records
                </button>
              )}
              <button
                onClick={() =>
                  void act(async () => {
                    if (
                      !confirm(
                        "Remove this Mac’s saved credential? Revoke it in CRM to stop other copies too.",
                      )
                    )
                      return;
                    await api(base + "/forget", "POST", { confirmed: true });
                    setConnection(null);
                    setSnapshot(null);
                    setText("");
                    setPreview(null);
                  })
                }
              >
                Remove local connection
              </button>
            </>
          )}
          {snapshot && (
            <>
              <p>
                Current dataset version: {snapshot.version}. Preserve entry IDs.
                Keep training eligibility pending for changed research.
              </p>
              <label>
                Research dataset JSON
                <textarea
                  rows={14}
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    setPreview(null);
                  }}
                />
              </label>
              <button
                onClick={() =>
                  void act(async () => {
                    const p = JSON.parse(text);
                    if (
                      !Array.isArray(p.entries) ||
                      p.entries.length > 600 ||
                      p.version !== snapshot.version
                    )
                      throw new Error(
                        "Keep the loaded version and use at most 600 entries.",
                      );
                    setPreview(p);
                  })
                }
              >
                Preview dataset save
              </button>
              {preview && (
                <section aria-label="Dataset save preview">
                  <h4>Review private dataset replacement</h4>
                  <p>
                    {snapshot.entries.length} saved entries →{" "}
                    {preview.entries.length} proposed entries. Removed entries
                    lose their live CRM links. This does not delete or publish
                    CRM records.
                  </p>
                  <pre>{JSON.stringify(preview, null, 2)}</pre>
                  <button
                    onClick={() =>
                      void act(async () => {
                        await api(base + "/save", "POST", preview);
                        await read();
                        setMessage(
                          "Private dataset saved through MCP. Review linked updates or project imports in CRM before publishing.",
                        );
                      })
                    }
                  >
                    Save reviewed private dataset
                  </button>
                </section>
              )}
              <details>
                <summary>Current linked CRM records (read-only)</summary>
                <p>
                  These are current source values, separate from your research.
                  Copy changes into the research JSON only after reviewing them.
                </p>
                <pre>{JSON.stringify(snapshot.crm, null, 2)}</pre>
              </details>
              <details>
                <summary>Record links and submission status</summary>
                <pre>
                  {JSON.stringify(
                    {
                      links: snapshot.links,
                      submissions: snapshot.submissions,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </>
          )}
        </fieldset>
      )}
      {message && <p role="status">{message}</p>}
    </article>
  );
}
