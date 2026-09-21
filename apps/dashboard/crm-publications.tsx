import React, { useEffect, useRef, useState } from "react";
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
type Summary = {
  id: string;
  state: string;
  prepared: { expiresAt: string; reviewUrl: string } | null;
  receipt: { recordId: string; state: string; existing: boolean } | null;
};
type Editor = {
  targetId: string;
  permissionEpoch: string;
  targetName: string;
  kinds: string[];
  kind: "notes" | "tasks";
  name: string;
  description: string;
  dueDate: string;
};
export function CrmPublicationControls({
  id,
  api,
  onError,
}: {
  id: string;
  api: Api;
  onError: (error: unknown) => void;
}) {
  const [items, setItems] = useState<Summary[]>([]),
    [editor, setEditor] = useState<Editor | null>(null),
    [preview, setPreview] = useState<{
      id: string;
      proposal: Pick<
        Editor,
        "name" | "description" | "dueDate" | "kind" | "targetId"
      >;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const active = useRef(true),
    epoch = useRef(0),
    working = useRef(false);
  const retry = useRef<{ fingerprint: string; operationId: string } | null>(
    null,
  );
  async function refresh() {
    const data = await api(`/v1/requests/${id}/publications`);
    if (active.current) setItems(data.items);
  }
  useEffect(() => {
    active.current = true;
    void refresh().catch(onError);
    const hide = () => {
      epoch.current++;
      setEditor(null);
      setPreview(null);
      setNotice(
        "Unsent editor content clears when this window loses focus. Saved proposals remain available below.",
      );
    };
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", hide);
    return () => {
      active.current = false;
      epoch.current++;
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [id]);
  useEffect(() => {
    if (!editor && !preview) return;
    let live = true,
      checking = false;
    const timer = setInterval(async () => {
      if (checking || document.hidden || !document.hasFocus()) return;
      checking = true;
      try {
        await api(`/v1/requests/${id}/export`);
      } catch {
        if (live) {
          epoch.current++;
          setEditor(null);
          setPreview(null);
          setNotice(
            "Source access changed. Reload the current draft before creating another proposal.",
          );
        }
      } finally {
        checking = false;
      }
    }, 15000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [!!editor, !!preview, id]);
  async function act(fn: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      onError(error);
    } finally {
      try {
        await refresh();
      } catch (error) {
        if (active.current) onError(error);
      }
      working.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <section>
      <h3>Reviewed CRM publication</h3>
      <p>
        Enable note/task permission on{" "}
        <a
          href="https://crm.bittrees.org/connect/ai"
          target="_blank"
          rel="noreferrer"
        >
          CRM’s connection page
        </a>
        . Save a proposal here, send its exact content to CRM, then review the
        destination and audience there. Approval alone does not publish.
      </p>
      <p role="status">{notice}</p>
      <button
        disabled={busy}
        onClick={() =>
          void act(async () => {
            const generation = ++epoch.current;
            const data = await api(`/v1/requests/${id}/export`);
            if (data.task.status !== "completed") {
              if (active.current)
                setNotice("Wait for this draft to finish first.");
              return;
            }
            const permission = await api(
              `/v1/requests/${id}/write-permission`,
              "POST",
              {},
            );
            if (
              !active.current ||
              generation !== epoch.current ||
              document.hidden ||
              !document.hasFocus()
            )
              return;
            setEditor({
              targetId: permission.targetId,
              permissionEpoch: permission.epoch,
              targetName: permission.targetName,
              kinds: permission.kinds,
              kind: permission.kinds[0],
              name: "",
              description: data.task.result?.text ?? "",
              dueDate: "",
            });
            setNotice(
              "Review and edit the draft. Unsent editor content clears on focus loss; save locally before opening CRM.",
            );
          })
        }
      >
        Create proposal from current draft
      </button>
      {editor && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              const { targetName: _name, kinds: _kinds, ...body } = editor;
              const fingerprint = JSON.stringify(body);
              if (retry.current?.fingerprint !== fingerprint)
                retry.current = {
                  fingerprint,
                  operationId: crypto.randomUUID(),
                };
              await api(`/v1/requests/${id}/publications`, "POST", {
                ...body,
                operationId: retry.current.operationId,
              });
              if (active.current) {
                setEditor(null);
                setNotice(
                  "Proposal saved locally. Choose Send to CRM for review below to transfer its content.",
                );
              }
              retry.current = null;
            });
          }}
        >
          <p>
            Destination: {editor.targetName}. The final audience is shown in CRM
            before approval.
          </p>
          <label htmlFor="proposal-kind">Create</label>
          <select
            id="proposal-kind"
            value={editor.kind}
            disabled={busy}
            onChange={(e) =>
              setEditor({
                ...editor,
                kind: e.target.value as Editor["kind"],
                dueDate: "",
              })
            }
          >
            {editor.kinds.map((kind) => (
              <option key={kind} value={kind}>
                {kind === "notes" ? "Note" : "Task"}
              </option>
            ))}
          </select>
          <label htmlFor="proposal-name">Title</label>
          <input
            id="proposal-name"
            required
            maxLength={200}
            value={editor.name}
            disabled={busy}
            onChange={(e) => setEditor({ ...editor, name: e.target.value })}
          />
          <label htmlFor="proposal-description">Exact content</label>
          <textarea
            id="proposal-description"
            maxLength={4000}
            value={editor.description}
            disabled={busy}
            onChange={(e) =>
              setEditor({ ...editor, description: e.target.value })
            }
          />
          <p>
            {editor.description.length}/4000 characters. Verify all claims and
            citations. No owner is assigned automatically.
          </p>
          {editor.kind === "tasks" && (
            <>
              <label htmlFor="proposal-date">Due date (optional)</label>
              <input
                id="proposal-date"
                type="date"
                value={editor.dueDate}
                disabled={busy}
                onChange={(e) =>
                  setEditor({ ...editor, dueDate: e.target.value })
                }
              />
            </>
          )}
          <button
            disabled={
              busy || !editor.name.trim() || editor.description.length > 4000
            }
          >
            Save proposal locally
          </button>
          <button type="button" disabled={busy} onClick={() => setEditor(null)}>
            Discard unsaved edits
          </button>
        </form>
      )}
      <button disabled={busy} onClick={() => void act(async () => {})}>
        Refresh proposal status
      </button>
      {!items.length && <p>No saved proposals.</p>}
      {items.map((item, index) => (
        <article key={item.id}>
          <h4>Proposal {index + 1}</h4>
          <p>
            Reference: <code>{item.id}</code>
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const generation = ++epoch.current;
                setPreview(null);
                const data = await api(`/v1/requests/${id}/export`);
                if (
                  !active.current ||
                  generation !== epoch.current ||
                  document.hidden ||
                  !document.hasFocus()
                )
                  return;
                const saved = data.publications.find(
                  (p: { id: string }) => p.id === item.id,
                );
                if (saved)
                  setPreview({ id: item.id, proposal: saved.proposal });
              })
            }
          >
            View saved content with current permission
          </button>
          {preview?.id === item.id && (
            <div>
              <h5>{preview.proposal.name}</h5>
              <p>
                {preview.proposal.kind === "notes" ? "Note" : "Task"} ·
                Destination reference: <code>{preview.proposal.targetId}</code>
              </p>
              <div className="result">{preview.proposal.description}</div>
              <p>
                Due date: {preview.proposal.dueDate || "None"}. No owner
                assigned.
              </p>
              <p>
                Saved proposals are fixed. To change content, create a new
                proposal and review it separately; first reconcile any
                unconfirmed publication.
              </p>
            </div>
          )}
          {item.receipt ? (
            <p role="status">
              CRM confirmed{" "}
              {item.receipt.state === "deleted"
                ? "this record was deleted"
                : "publication"}
              . Record reference: <code>{item.receipt.recordId}</code>. This is
              a saved receipt, not a current record-access check.
            </p>
          ) : (
            <>
              <p>
                {item.state === "uncertain"
                  ? "The last outcome is unconfirmed. Retry this same proposal to reconcile it; do not create a replacement to retry."
                  : item.prepared
                    ? "Prepared for review; publication has not been confirmed."
                    : "Saved on this device; not yet sent for review."}
              </p>
              {!item.prepared ? (
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await api(
                        `/v1/publications/${item.id}/prepare`,
                        "POST",
                        {},
                      );
                    })
                  }
                >
                  Send to CRM for review / retry
                </button>
              ) : (
                <>
                  <p>
                    <a
                      href={item.prepared.reviewUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Review exact content, destination and audience in CRM
                    </a>
                  </p>
                  <p>
                    Review expires{" "}
                    {new Date(item.prepared.expiresAt).toLocaleString()}.
                    Expired reviews cannot authorize a new publication; an
                    existing receipt can still be recovered while the grant
                    permits it.
                  </p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await api(
                          `/v1/publications/${item.id}/publish`,
                          "POST",
                          {},
                        );
                      })
                    }
                  >
                    Publish approved proposal / reconcile receipt
                  </button>
                </>
              )}
            </>
          )}
        </article>
      ))}
      <p>
        Delete staged proposals on CRM’s review page. Deleting local task data
        also deletes these local proposals and receipts; it does not delete CRM
        records or staged copies.
      </p>
    </section>
  );
}
