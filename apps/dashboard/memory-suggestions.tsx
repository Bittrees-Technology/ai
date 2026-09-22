import React, { useEffect, useState } from "react";
import { MemorySuggestionController } from "./memory-suggestion-state.js";
export function MemorySuggestions({
  taskId,
  revision,
  profileId,
  extraction,
  api,
  onError,
}: {
  taskId: string;
  revision: number;
  profileId: string;
  extraction: boolean;
  api: (path: string, method: string, body?: unknown) => Promise<any>;
  onError: (error: unknown) => void;
}) {
  const [, render] = useState(0);
  const [c] = useState(
    () =>
      new MemorySuggestionController(api, taskId, revision, () =>
        render((v) => v + 1),
      ),
  );
  useEffect(() => {
    const hide = () => c.hide();
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", hide);
      c.hide();
    };
  }, [c]);
  useEffect(() => c.hide(), [c, profileId]);
  return (
    <section>
      <h3>Memory suggestions</h3>
      {extraction ? (
        <>
          <p>
            Review each suggestion against its quoted source. A matching quote
            does not prove that the suggestion is correct.
          </p>
          <button
            disabled={c.busy}
            onClick={() => void c.load().catch(onError)}
          >
            Review suggestions
          </button>
          <button onClick={() => c.hide()}>Hide suggestions</button>
          {c.review && (
            <>
              <p className="hint">
                From task {c.review.parentId}, revision{" "}
                {c.review.parentRevision}. Saved suggestions remain candidates;
                approve or edit them in Memory before using them.
              </p>
              {!c.review.candidates.length && (
                <p role="status">No durable memory was suggested.</p>
              )}
              {c.review.candidates.map((item, index) => (
                <article className="memory" key={index}>
                  <p>{item.type} · Model-generated, unverified</p>
                  <p className="prose">{item.text}</p>
                  {item.evidence.map((e, i) => (
                    <div key={i}>
                      <p>
                        {e.source === "request"
                          ? "Your request"
                          : "Task result"}
                      </p>
                      <blockquote>{e.quote}</blockquote>
                    </div>
                  ))}
                  <button
                    disabled={c.busy || c.saved.has(index)}
                    onClick={() => void c.save(index).catch(onError)}
                  >
                    {c.saved.has(index)
                      ? "Saved for review in Memory"
                      : "Save as memory candidate"}
                  </button>
                </article>
              ))}
            </>
          )}
        </>
      ) : (
        <>
          <p>
            Ask the selected local model to suggest durable memories from this
            completed task. Nothing is approved automatically.
          </p>
          {c.queuedId ? (
            <p role="status">
              Request queued. Refresh Tasks and open {c.queuedId} when it
              completes to review suggestions.
            </p>
          ) : (
            <>
              <button
                disabled={c.busy || !profileId}
                onClick={() => c.prepare(profileId)}
              >
                Prepare suggestions
              </button>
              {c.prepared && (
                <div>
                  <p>
                    Use profile {profileId} on this Mac for task {taskId},
                    revision {revision}? Its request and result will enter the
                    local queue and stay until you delete task history.
                  </p>
                  <button
                    disabled={c.busy}
                    onClick={() => void c.request().catch(onError)}
                  >
                    Request local suggestions
                  </button>
                  <button disabled={c.busy} onClick={() => c.hide()}>
                    Cancel review
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
