import React, { useId } from "react";
import type { NewsConnectionController } from "./news-state.js";
import type { NewsPublicationReview } from "../../modules/connectors/news-publication-contracts.js";
type Story = NewsPublicationReview["content"]["snapshot"]["front"][number];
const textValue = (value: unknown) =>
  value === null
    ? "Not set"
    : typeof value === "boolean"
      ? value
        ? "Yes"
        : "No"
      : Array.isArray(value)
        ? value.join(", ")
        : String(value);
function PublicStory({ item, blocked }: { item: Story; blocked: boolean }) {
  const title = item.translation?.title || item.title;
  const summary = item.translation?.summary ?? item.summary ?? item.excerpt;
  const metadata: { [key: string]: unknown } = {
    "Story identifier": item.id,
    "Source identifier": item.source_id,
    Topic: item.topic,
    "Story type": item.kind,
    "Published date": item.published_at,
    Authors: item.authors,
    Publication: item.publication,
    Tags: item.tags,
    "Summary type": item.summary_kind,
    "Owner edited": item.user_edited,
    "Original headline": item.original_title,
    "Observation period": item.observation_period,
    "Released date": item.released_at,
    "Retrieved date": item.retrieved_at,
    "Date basis": item.date_basis,
    "Translation identifier": item.translation_key,
    "Translation status": item.translation_status,
    "Translation language": item.translation?.language,
    "Translation model": item.translation?.model,
  };
  return (
    <article className="news-public-story">
      <h5 className="news-exact-text">{title}</h5>
      <p className="news-exact-text">{summary || "(Empty summary)"}</p>
      {item.translation && (
        <p className="hint">
          Translated text is included in the public edition. It is not
          independently verified.
        </p>
      )}
      {item.user_edited && (
        <p className="hint">
          Edited by the newspaper owner; not independently verified.
        </p>
      )}
      <p>
        <a href={item.url} target="_blank" rel="noopener noreferrer">
          {item.url}
        </a>
      </p>
      {item.authors && <p>By {item.authors.join(", ")}</p>}
      {item.publication && <p>{item.publication}</p>}
      {blocked && (
        <p role="alert">
          This story cannot be published. Check its current source content and
          sharing permission in News.
        </p>
      )}
      <details>
        <summary>All public text and story details</summary>
        <p className="hint">
          These fields are included in the public snapshot, even where the page
          displays a translation or summary.
        </p>
        <dl>
          <dt>Stored headline</dt>
          <dd className="news-exact-text">{item.title}</dd>
          {item.summary !== undefined && (
            <>
              <dt>Stored summary</dt>
              <dd className="news-exact-text">
                {item.summary === null
                  ? "Not set"
                  : item.summary || "(Empty summary)"}
              </dd>
            </>
          )}
          <dt>Source excerpt</dt>
          <dd className="news-exact-text">
            {item.excerpt || "(Empty excerpt)"}
          </dd>
          {item.briefing_preview !== undefined && (
            <>
              <dt>Briefing preview</dt>
              <dd className="news-exact-text">
                {item.briefing_preview || "(Empty preview)"}
              </dd>
            </>
          )}
          {item.translation?.title !== undefined && (
            <>
              <dt>Translated headline</dt>
              <dd className="news-exact-text">
                {item.translation.title || "(Empty headline)"}
              </dd>
            </>
          )}
          {item.translation?.summary !== undefined && (
            <>
              <dt>Translated summary</dt>
              <dd className="news-exact-text">
                {item.translation.summary || "(Empty summary)"}
              </dd>
            </>
          )}
          {Object.entries(metadata)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => (
              <React.Fragment key={k}>
                <dt>{k}</dt>
                <dd className="news-exact-text">{textValue(v)}</dd>
              </React.Fragment>
            ))}
        </dl>
      </details>
    </article>
  );
}
export function NewsPublicContent({
  source,
}: {
  source: NewsPublicationReview;
}) {
  const snapshot = source.content.snapshot;
  return (
    <div className="news-public-content">
      <h4 className="news-exact-text">{source.content.name}</h4>
      <p className="news-exact-text">
        {source.content.description || "No public description."}
      </p>
      <p>
        Public destination:{" "}
        <a href={source.url} target="_blank" rel="noopener noreferrer">
          {source.url}
        </a>
      </p>
      <h5>Public navigation</h5>
      {source.content.navigation.length ? (
        <ul>
          {source.content.navigation.map((n) => (
            <li key={n.slug}>
              <span className="news-exact-text">{n.name}</span>{" "}
              <span className="hint">/{n.slug}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p>No named navigation links.</p>
      )}
      <section aria-label="Public front page">
        <h4>
          Front page{" "}
          <span className="hint">
            ({snapshot.front.length}{" "}
            {snapshot.front.length === 1 ? "story" : "stories"})
          </span>
        </h4>
        {snapshot.front.map((i) => (
          <PublicStory
            key={i.id}
            item={i}
            blocked={source.eligibility.blockedItemIds.includes(i.id)}
          />
        ))}
      </section>
      {snapshot.feeds.map((f) => (
        <section key={f.id} aria-label={"Public feed " + f.name}>
          <h4 className="news-exact-text">
            {f.name}{" "}
            <span className="hint">
              ({f.items.length} {f.items.length === 1 ? "story" : "stories"})
            </span>
          </h4>
          <p className="hint">
            Saved section /{f.slug}. Navigation label:{" "}
            {source.content.navigation.find((n) => n.slug === f.slug)?.name}
          </p>
          {!f.items.length && <p>This named feed is empty.</p>}
          {f.items.map((i) => (
            <PublicStory
              key={i.id}
              item={i}
              blocked={source.eligibility.blockedItemIds.includes(i.id)}
            />
          ))}
          <details>
            <summary>Public section details</summary>
            <p>Section identifier: {f.id}</p>
            <p>Section slug: {f.slug}</p>
          </details>
        </section>
      ))}
      <details>
        <summary>Edition details</summary>
        <p>Newspaper slug: {source.content.slug}</p>
        <p>Preview revision: {source.revision}</p>
        <p>Previous publication version: {source.publicationVersion}</p>
        {snapshot.builtAt !== undefined && (
          <p>Preview built: {snapshot.builtAt}</p>
        )}
        {snapshot.editedAt !== undefined && (
          <p>Preview edited: {snapshot.editedAt}</p>
        )}
      </details>
    </div>
  );
}
export function NewsPublication({
  controller: c,
  changed,
}: {
  controller: NewsConnectionController;
  changed: () => void;
}) {
  const form = useId(),
    connection = c.status?.connection,
    review = c.publicReview,
    record = c.publicationRecord;
  const usable = !!connection && connection.state !== "expired";
  const canCheck =
    usable && record?.identity.accountId === connection.accountId;
  if (c.status?.publication !== "per_action_review") return null;
  return (
    <section className="news-publication" aria-label="News publication">
      <h4>Publish a reviewed edition</h4>
      <p>
        Review the front page, every named feed and the public fields below
        before publishing. Source text and translations are unverified.
        Publishing makes the edition public; existing subscriptions may include
        it later.
      </p>
      <p className="hint">
        This does not generate a briefing or change source-sharing permissions,
        delivery settings or schedules.
      </p>
      <button
        disabled={c.busy || !usable || !connection?.scopes.includes("publish")}
        onClick={() => void c.reviewPublication()}
      >
        Review public edition
      </button>
      {!connection?.scopes.includes("publish") && (
        <p className="hint">
          Publishing requires a News key with publish permission. Saving a key
          or approving a private edit does not approve publication.
        </p>
      )}
      {c.publicationError && <p role="alert">{c.publicationError}</p>}
      {c.publicationNotice && <p role="status">{c.publicationNotice}</p>}
      {review && (
        <section
          className="news-public-review"
          aria-label="Review public edition"
        >
          <h4>Review everything that will be public</h4>
          <p>
            Review expires {new Date(review.expiresAt).toLocaleTimeString()}.
            Leaving this view clears the review. A request already sent cannot
            be undone by closing the view.
          </p>
          <p>
            {review.source.previousPublication.published
              ? "This replaces the currently published edition reported by News."
              : "News reports no currently published edition."}
          </p>
          <NewsPublicContent source={review.source} />
          {!review.source.eligibility.eligible && (
            <p role="alert">
              Publication is blocked by current source permissions or changed
              content. Resolve this in News, then load a fresh review.
            </p>
          )}
          <div className="news-public-consent">
            <label htmlFor={form + "-publish"} className="check">
              <input
                id={form + "-publish"}
                type="checkbox"
                disabled={c.busy || !review.source.eligibility.eligible}
                checked={c.publicationConfirmed}
                onChange={(e) => {
                  c.publicationConfirmed = e.target.checked;
                  changed();
                }}
              />{" "}
              I reviewed every section and its public fields, and approve this
              exact edition for anyone to read. Existing subscriptions may
              include it later.
            </label>
            <button
              disabled={
                c.busy ||
                !c.publicationConfirmed ||
                !review.source.eligibility.eligible ||
                Date.parse(review.expiresAt) <= Date.now()
              }
              onClick={() => void c.publish()}
            >
              Publish reviewed edition
            </button>
            <button
              disabled={c.busy}
              onClick={() => void c.cancelPublication()}
            >
              Cancel publication review
            </button>
          </div>
        </section>
      )}
      <section className="news-public-history" aria-label="Publication history">
        <h4>Publication history on this Mac</h4>
        <p className="hint">
          Records stay until you delete them and are included in “Export my
          local data” under Data controls. Saved backups retain separate copies.
          Checking a receipt never resends a publication.
        </p>
        <button
          disabled={c.busy}
          onClick={() => void c.loadPublicationHistory()}
        >
          Load publication history
        </button>
        {c.publicationHistory && !c.publicationHistory.length && (
          <p>
            No local publication records found. An empty history does not prove
            that an in-flight request failed.
          </p>
        )}
        {c.publicationHistory?.map((r) => (
          <article className="news-public-history-row" key={r.operationId}>
            <h5>{r.name}</h5>
            <p>
              {r.receipt
                ? "Publication recorded (historical)"
                : "Unconfirmed — check receipt"}
            </p>
            <p className="hint">
              Approved {new Date(r.recordedAt).toLocaleString()}
            </p>
            <button
              disabled={c.busy}
              onClick={() => void c.openPublication(r.operationId)}
            >
              Open publication record
            </button>
          </article>
        ))}
        {record && (
          <article
            className="news-public-record"
            aria-label="Selected publication record"
          >
            <h4>
              {record.receipt
                ? "Historical publication receipt"
                : "Unconfirmed publication"}
            </h4>
            <p className="news-exact-text">{record.review.content.name}</p>
            <p>
              Destination:{" "}
              <a
                href={record.review.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {record.review.url}
              </a>
            </p>
            {record.receipt ? (
              <p>
                News recorded publication at{" "}
                {new Date(record.receipt.committedAt).toLocaleString()}. This
                does not verify that the edition is still public or that anyone
                received it.
              </p>
            ) : (
              <p>
                No matching receipt has been recorded here. The request may
                still be in flight. Do not publish a replacement to resolve
                uncertainty.
              </p>
            )}
            {record.lastCheckedAt && (
              <p className="hint">
                Receipt checked{" "}
                {new Date(record.lastCheckedAt).toLocaleString()}
              </p>
            )}
            <button
              disabled={c.busy || !canCheck}
              onClick={() => void c.checkPublicationReceipt()}
            >
              Check publication receipt
            </button>
            {!canCheck && (
              <p className="hint">
                Reconnect a valid read key for this record’s News account to
                check its receipt. The local record remains available.
              </p>
            )}
            <details>
              <summary>View the exact approved public content</summary>
              <NewsPublicContent source={record.review} />
            </details>
            <details>
              <summary>Receipt identifiers</summary>
              <p>Operation: {record.operationId}</p>
              <p>News account: {record.identity.accountId}</p>
              <p>Reviewed digest: {record.review.reviewDigest}</p>
            </details>
            <div className="news-public-delete">
              <p>
                Deleting this record loses local tracking. It does not remove a
                public edition, cancel an accepted request or delete copies in
                saved backups. Export the record before deleting it if you need
                it later.
              </p>
              <label htmlFor={form + "-delete"} className="check">
                <input
                  id={form + "-delete"}
                  type="checkbox"
                  checked={c.deletePublicationConfirmed}
                  disabled={c.busy}
                  onChange={(e) => {
                    c.deletePublicationConfirmed = e.target.checked;
                    changed();
                  }}
                />{" "}
                Delete this local record and forget its publication tracking.
              </label>
              <button
                disabled={c.busy || !c.deletePublicationConfirmed}
                onClick={() => void c.deletePublication()}
              >
                Delete local publication record
              </button>
            </div>
          </article>
        )}
      </section>
    </section>
  );
}
