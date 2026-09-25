import React, { useEffect, useRef, useState } from "react";
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
/** Manual capture from one freshly reviewed source result. No automatic extraction or approval. */
export function SourceMemoryCapture({
  taskId,
  sourceApp,
  api,
}: {
  taskId: string;
  sourceApp?: string;
  api: Api;
}) {
  const [review, setReview] = useState<{
    revision: number;
    text: string;
    expires: number;
  } | null>(null);
  const [text, setText] = useState(""),
    [type, setType] = useState("fact"),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const epoch = useRef(0),
    working = useRef(false),
    mounted = useRef(false);
  const clear = () => {
    setReview(null);
    setText("");
    setConfirmed(false);
  };
  const hide = () => {
    epoch.current++;
    working.current = false;
    setBusy(false);
    clear();
  };
  const focused = () => !document.hidden && document.hasFocus();
  useEffect(() => {
    mounted.current = true;
    const hidden = () => hide();
    window.addEventListener("blur", hidden);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      mounted.current = false;
      epoch.current++;
      window.removeEventListener("blur", hidden);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  useEffect(() => {
    if (!review) return;
    const timer = setTimeout(
      () => {
        hide();
        setMessage("Review expired. Open the source again to continue.");
      },
      Math.max(0, review.expires - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [review]);
  const open = async () => {
    if (working.current || !focused()) return;
    const generation = ++epoch.current;
    working.current = true;
    setBusy(true);
    clear();
    setMessage("Checking source access…");
    try {
      const data = await api(`/v1/requests/${taskId}/export`);
      if (!mounted.current || generation !== epoch.current || !focused())
        return;
      if (
        data.task?.id !== taskId ||
        data.task.status !== "completed" ||
        !Number.isInteger(data.task.revision) ||
        typeof data.task.result?.text !== "string"
      )
        throw Error("Unavailable");
      setReview({
        revision: data.task.revision,
        text: data.task.result.text,
        expires: Date.now() + 120000,
      });
      setMessage(
        "Write only what you want to retain. Review the candidate in Memory before using it.",
      );
    } catch {
      if (mounted.current && generation === epoch.current)
        setMessage(
          "Source access could not be confirmed. Reconnect or review a current draft.",
        );
    } finally {
      if (mounted.current && generation === epoch.current) {
        working.current = false;
        setBusy(false);
      }
    }
  };
  const save = async () => {
    if (
      working.current ||
      !focused() ||
      !confirmed ||
      !review ||
      Date.now() >= review.expires ||
      !text.trim()
    )
      return;
    const generation = epoch.current;
    working.current = true;
    setBusy(true);
    try {
      await api(`/v1/requests/${taskId}/memories`, "POST", {
        text: text.trim(),
        type,
        expectedRevision: review.revision,
      });
      if (!mounted.current || generation !== epoch.current || !focused())
        return;
      clear();
      setMessage(
        "Candidate saved. Open Memory to review or edit it before use.",
      );
    } catch {
      if (mounted.current && generation === epoch.current) {
        clear();
        setMessage(
          "Saving was not confirmed. Check Memory before trying again; reopen the source for a fresh review.",
        );
      }
    } finally {
      if (mounted.current && generation === epoch.current) {
        working.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <section aria-label="Source memory capture">
      <h3>
        Remember from{" "}
        {sourceApp === "memory"
          ? "this source-linked task"
          : sourceApp === "autonote"
            ? "AutoNote"
            : sourceApp === "mail"
              ? "Mail"
              : "CRM"}
      </h3>
      <p>
        Keep a candidate linked to this draft. Its source must remain accessible
        whenever it is read or used. Saving does not approve the statement or
        publish anything.
      </p>
      <button disabled={busy} onClick={() => void open()}>
        Review source for memory
      </button>
      <p role="status">{message}</p>
      {review && (
        <>
          <h4>Current source draft</h4>
          <div className="result">{review.text}</div>
          <label>
            Memory type
            <select
              disabled={busy}
              value={type}
              onChange={(e) => {
                setType(e.target.value);
                setConfirmed(false);
              }}
            >
              {["preference", "fact", "decision", "outcome", "procedure"].map(
                (v) => (
                  <option key={v} value={v}>
                    {v[0]!.toUpperCase() + v.slice(1)}
                  </option>
                ),
              )}
            </select>
          </label>
          <label>
            What to remember
            <textarea
              disabled={busy}
              maxLength={16000}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setConfirmed(false);
              }}
            />
          </label>
          <label>
            <input
              type="checkbox"
              disabled={busy}
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            Save this text as a candidate linked to the reviewed draft.
          </label>
          <div className="actions">
            <button
              disabled={busy || !confirmed || !text.trim()}
              onClick={() => void save()}
            >
              Save source memory candidate
            </button>
            <button
              onClick={() => {
                hide();
                setMessage("Source review hidden.");
              }}
            >
              Hide source memory review
            </button>
          </div>
        </>
      )}
    </section>
  );
}
