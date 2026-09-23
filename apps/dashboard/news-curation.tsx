import React from "react";
import type { NewsConnectionController } from "./news-state.js";
export function NewsCuration({
  controller: c,
  changed,
}: {
  controller: NewsConnectionController;
  changed: () => void;
}) {
  const editable = c.status?.connection?.scopes.includes("curate"),
    expired = c.status?.connection?.state === "expired";
  return (
    <section className="news-curation" aria-label="Private News preview">
      <h4>Private newspaper preview</h4>
      <p className="hint">
        Load an existing preview from News. Source text is unverified; your
        edits are labeled as owner edits and keep their source links. This does
        not generate a briefing or change its schedule.
      </p>
      <button disabled={c.busy || expired} onClick={() => void c.loadPreview()}>
        Load private preview
      </button>
      {!editable && (
        <p className="hint">
          This key allows reading only. Manage curation permission in News if
          you want to edit, then reconnect here.
        </p>
      )}
      {c.notice && <p role="status">{c.notice}</p>}
      {c.preview && (
        <>
          <h4>
            {c.preview.name} · Revision {c.preview.revision}
          </h4>
          <p className="hint">
            Checked {new Date(c.preview.checkedAt).toLocaleString()}.{" "}
            {c.preview.feedCount} named feeds remain unchanged. Article
            source-sharing permissions remain controlled by News.
          </p>
          {!c.preview.exists || !c.preview.front.length ? (
            <p>Create a private preview in News first, then load it here.</p>
          ) : (
            c.preview.front.map((item) => (
              <article key={item.id}>
                <h4>
                  <a href={item.url} target="_blank" rel="noopener noreferrer">
                    {item.title}
                  </a>
                </h4>
                <p className="news-exact-text">
                  {item.summary ?? item.excerpt}
                </p>
                <p className="hint">
                  {item.user_edited
                    ? "Owner-edited text; not independently verified."
                    : "Unverified source text."}{" "}
                  · {item.source_id}
                </p>
                {editable && (
                  <button
                    disabled={c.busy || expired}
                    onClick={() => c.chooseStory(item.id)}
                  >
                    Edit this story
                  </button>
                )}
              </article>
            ))
          )}
        </>
      )}
      {c.edit && (
        <form
          aria-label="Edit News story"
          onSubmit={(e) => {
            e.preventDefault();
            void c.reviewStory();
          }}
        >
          <label>
            Headline
            <input
              value={c.edit.title}
              maxLength={250}
              disabled={c.busy}
              onChange={(e) => c.changeStory("title", e.target.value)}
            />
          </label>
          <label>
            Summary
            <textarea
              value={c.edit.summary}
              maxLength={2000}
              disabled={c.busy}
              onChange={(e) => c.changeStory("summary", e.target.value)}
            />
          </label>
          <p className="hint">
            Headline: 1–250 characters. Summary: up to 2,000 characters.
            Existing long text is never shortened automatically.
          </p>
          <button
            disabled={
              c.busy ||
              !c.edit.title.trim() ||
              c.edit.title.trim().length > 250 ||
              c.edit.summary.trim().length > 2000
            }
          >
            Review story change
          </button>
        </form>
      )}
      {c.editReview && (
        <section aria-label="Review News story change">
          <h4>Review the exact change</h4>
          <p>
            {c.editReview.name} · Revision {c.editReview.revision}
          </p>
          <p>
            <a
              href={c.editReview.before.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Original source
            </a>
          </p>
          <h5>Before</h5>
          <strong className="news-exact-text">
            {c.editReview.before.title}
          </strong>
          <p className="news-exact-text">
            {c.editReview.before.summary ?? c.editReview.before.excerpt}
          </p>
          <h5>After</h5>
          <strong className="news-exact-text">
            {c.editReview.after.title}
          </strong>
          <p className="news-exact-text">
            {c.editReview.after.summary || "(Empty summary)"}
          </p>
          <p className="hint">
            Only this story changes. Other stories, named feeds, published
            pages, sharing permissions and schedules remain unchanged. Review
            expires {new Date(c.editReview.expiresAt).toLocaleTimeString()}.
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={c.curateConfirmed}
              disabled={c.busy}
              onChange={(e) => {
                c.curateConfirmed = e.target.checked;
                changed();
              }}
            />{" "}
            Allow curation for this exact change to my private preview.
          </label>
          <button
            disabled={c.busy || !c.curateConfirmed}
            onClick={() => void c.saveStory()}
          >
            Save reviewed story
          </button>
          <button disabled={c.busy} onClick={() => void c.cancel()}>
            Cancel story review
          </button>
        </section>
      )}
    </section>
  );
}
