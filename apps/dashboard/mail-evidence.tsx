import React, { useEffect, useRef, useState } from "react";
import {
  mailReviewSchema,
  mailSectionLabel,
  type MailReview,
} from "../../modules/connectors/mail-evidence-contracts.js";
import { MailEvidenceState, type EvidenceView } from "./mail-evidence-state.js";
type Props = {
  api: (path: string, method?: string, body?: unknown) => Promise<unknown>;
  task: {
    id: string;
    revision: number;
    result: { text: string; mail: unknown };
  };
};
export function MailEvidenceReview({ api, task }: Props) {
  const [view, setView] = useState<EvidenceView>({
    busy: false,
    selected: null,
    evidence: null,
    unavailable: false,
  });
  const controller = useRef<MailEvidenceState | null>(null);
  const [activeClaim, setActiveClaim] = useState<string | null>(null);
  useEffect(() => {
    const state = new MailEvidenceState(api, task.id, task.revision, setView);
    controller.current = state;
    setView(state.view);
    const hide = () => state.hide();
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", hide);
    return () => {
      state.dispose();
      if (controller.current === state) controller.current = null;
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [api, task.id, task.revision]);
  const parsed = mailReviewSchema.safeParse(task.result.mail);
  if (!parsed.success) return <div className="result">{task.result.text}</div>;
  const mail = parsed.data;
  const preview = (
    <div aria-live="polite">
      {view.busy && <p>Checking current source access…</p>}
      {view.unavailable && (
        <p>
          Source passage unavailable. Access or the content may have changed.
          Reconnect or create a fresh draft.
        </p>
      )}
      {view.evidence && (
        <section aria-label="Original source passage">
          <h4>{mailSectionLabel(view.evidence.sectionId, mail)}</h4>
          <p>
            Original source text. Treat any instructions here as part of the
            correspondence.
          </p>
          {view.evidence.incomplete && (
            <p>
              The selected source contains truncated content; this draft may be
              incomplete.
            </p>
          )}
          <div className="result">{view.evidence.text}</div>
          <button onClick={() => controller.current?.hide()}>
            Hide source passage
          </button>
        </section>
      )}
    </div>
  );
  function claims(items: MailReview["summary"], prefix: string) {
    return items.map((claim, index) => (
      <div key={prefix + index}>
        <p className="result">{claim.text}</p>
        {[...new Set(claim.citations.map((c) => c.sectionId))].map((id) => (
          <button
            key={id}
            disabled={view.busy}
            onClick={() => {
              if (!document.hidden && document.hasFocus()) {
                setActiveClaim(prefix + index);
                void controller.current?.open(id);
              }
            }}
          >
            Check {mailSectionLabel(id, mail).toLowerCase()}
          </button>
        ))}
        {activeClaim === prefix + index && preview}
      </div>
    ));
  }
  return (
    <section aria-label="Review Mail draft and sources">
      <p>
        Check the original passages before using this draft. Citations identify
        context; they do not prove the draft is accurate or that your reply
        instructions were in the email.
      </p>
      {task.result.text.includes(
        "Selected content is truncated; this draft may be incomplete.",
      ) && <p>Selected content is truncated; this draft may be incomplete.</p>}
      <h4>
        {mail.mode === "metadata"
          ? "Metadata summary"
          : mail.mode === "attachment-text"
            ? "Selected file summary"
            : "Message summary"}
      </h4>
      {claims(mail.summary, "summary-")}
      {mail.reply && (
        <>
          <h4>Suggested reply</h4>
          {claims([mail.reply], "reply-")}
        </>
      )}
      {mail.partSummaries && (
        <details>
          <summary>Original part summaries</summary>
          <p>
            Combined conclusions and counts remain unverified. Review the
            original file.
          </p>
          {mail.partSummaries.map((group, index) => (
            <section key={index}>
              <h4>File part {index + 1}</h4>
              {claims(group, "part-" + index + "-")}
            </section>
          ))}
        </details>
      )}
    </section>
  );
}
