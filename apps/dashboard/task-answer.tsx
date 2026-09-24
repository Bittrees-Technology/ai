import React, { useEffect, useMemo, useState } from "react";
import type { InboxMessage } from "./inbox-message-state.js";
import { TaskAnswerController } from "./task-answer-state.js";
export function TaskAnswer({
  message,
  api,
  onOpen,
}: {
  message: InboxMessage;
  api: (
    path: string,
    method?: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<any>;
  onOpen: () => void;
}) {
  const [, redraw] = useState(0);
  const c = useMemo(
    () => new TaskAnswerController(api, () => redraw((v) => v + 1)),
    [api, message.id],
  );
  const available = () =>
    document.hasFocus() && document.visibilityState !== "hidden";
  useEffect(() => {
    const clear = () => c.clear();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") clear();
    };
    window.addEventListener("blur", clear);
    window.addEventListener("keydown", key);
    document.addEventListener("visibilitychange", clear);
    const timer = setInterval(() => c.expire(), 250);
    return () => {
      clearInterval(timer);
      clear();
      window.removeEventListener("blur", clear);
      window.removeEventListener("keydown", key);
      document.removeEventListener("visibilitychange", clear);
    };
  }, [c]);
  return (
    <section className="task-answer" aria-label="Task answer">
      <button
        disabled={c.busy || c.sending}
        onClick={() => {
          onOpen();
          void c.open(message, available);
        }}
      >
        Answer task question
      </button>
      {c.question && (
        <>
          <h3>{c.review ? "Review your answer" : "Answer this question"}</h3>
          <p className="prose">{c.question.question}</p>
          <p className="hint">
            For this conversation · Task {c.question.taskId.slice(0, 8)} ·
            Answer by {new Date(c.question.deadline).toLocaleString()}
          </p>
          {c.review ? (
            <>
              <h4>Your answer</h4>
              <p className="prose">{c.review.content}</p>
              <label>
                <input
                  type="checkbox"
                  checked={c.confirmed}
                  onChange={(e) => c.acknowledge(e.target.checked)}
                />{" "}
                I reviewed this question and answer.
              </label>
              <button
                disabled={!c.confirmed || c.sending}
                onClick={() => void c.save(available)}
              >
                Save answer
              </button>
            </>
          ) : (
            <>
              <label>
                Your answer
                <textarea
                  value={c.draft}
                  maxLength={32000}
                  disabled={c.busy}
                  onChange={(e) => c.edit(e.target.value)}
                />
              </label>
              <button
                disabled={c.busy || !c.draft.trim()}
                onClick={() => void c.prepare(message, available)}
              >
                Review answer
              </button>
            </>
          )}
          <p className="hint">
            {c.question.status === "paused"
              ? "Saving keeps this task paused. Resume it separately when ready."
              : "Saving queues this task to continue with its existing permissions."}
          </p>
          <p className="hint">
            Question and unsaved answer clear after two minutes or when you
            leave this view. Hiding cannot undo a save already requested.
          </p>
          <button onClick={() => c.clear()}>Discard answer review</button>
        </>
      )}
      {c.sending && <p role="status">Saving answer…</p>}
      {c.notice && <p role="status">{c.notice}</p>}
    </section>
  );
}
