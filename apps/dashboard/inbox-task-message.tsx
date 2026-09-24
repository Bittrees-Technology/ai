import React, { useEffect, useState } from "react";
import type { InboxMessage } from "./inbox-message-state.js";
import { TaskAnswer } from "./task-answer.js";
import { InboxTaskReview } from "./inbox-task-review-state.js";

export function InboxTaskMessage({
  message,
  api,
}: {
  message: InboxMessage;
  api: (
    path: string,
    method?: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<any>;
}) {
  const [, redraw] = useState(0),
    [error, setError] = useState("");
  const [review] = useState(
    () => new InboxTaskReview(api, () => redraw((v) => v + 1)),
  );
  useEffect(() => {
    let mounted = true;
    const clear = () => {
      if (mounted) {
        review.clear();
        setError("");
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") clear();
    };
    window.addEventListener("blur", clear);
    window.addEventListener("keydown", key);
    document.addEventListener("visibilitychange", clear);
    const timer = setInterval(() => review.expire(), 250);
    return () => {
      mounted = false;
      clearInterval(timer);
      review.clear();
      window.removeEventListener("blur", clear);
      window.removeEventListener("keydown", key);
      document.removeEventListener("visibilitychange", clear);
    };
  }, [review, message.id]);
  return (
    <div>
      <p className="prose">
        {review.content ??
          "Task-linked message. Open it to check current access."}
      </p>
      <p className="hint">
        Text hides after 15 seconds or when you leave this view. Opening it does
        not resume work.
      </p>
      <button
        disabled={review.busy}
        onClick={() => {
          setError("");
          void review
            .read(
              message,
              () =>
                document.hasFocus() && document.visibilityState !== "hidden",
            )
            .catch(() =>
              setError(
                "Task message could not be opened. Refresh and check access again.",
              ),
            );
        }}
      >
        Open task-linked message
      </button>
      {review.content !== null && (
        <button onClick={() => review.clear()}>Hide task-linked message</button>
      )}
      {error && <p role="alert">{error}</p>}
      {message.input.replyExpected && (
        <TaskAnswer message={message} api={api} onOpen={() => review.clear()} />
      )}
    </div>
  );
}
