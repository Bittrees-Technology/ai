import { NewsPublication } from "./news-publication.js";
import { NewsCuration } from "./news-curation.js";
import React, { useEffect, useRef, useState } from "react";
import { NewsConnectionController } from "./news-state.js";
export function NewsConnectionPanel({
  api,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
}) {
  const [, render] = useState(0),
    mounted = useRef(true);
  const [c] = useState(
    () =>
      new NewsConnectionController(api, () => {
        if (mounted.current) render((n) => n + 1);
      }),
  );
  useEffect(() => {
    mounted.current = true;
    void c.refresh();
    const hide = () => c.hide();
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", hide);
    return () => {
      mounted.current = false;
      c.hide();
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [c]);
  useEffect(() => {
    const deadlines = [
      c.pending?.reviewExpiresAt,
      c.editReview?.expiresAt,
      c.publicReview?.expiresAt,
      c.status?.connection?.expiresAt,
    ].filter((v): v is string => !!v);
    const until = deadlines.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    if (!until) return;
    let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      const delay = Date.parse(until) - Date.now();
      if (delay > 0) {
        timer = setTimeout(expire, Math.min(delay, 2147483647));
        return;
      }
      if (
        c.status?.connection &&
        c.status.connection.state !== "expired" &&
        Date.parse(c.status.connection.expiresAt) <= Date.now()
      )
        c.status = {
          ...c.status,
          connection: { ...c.status.connection, state: "expired" },
        };
      if (
        c.pending ||
        c.editReview ||
        c.publicReview ||
        c.publicationRecord ||
        c.publicationHistory ||
        c.preview ||
        c.checkedAt ||
        c.status?.connection?.state === "expired"
      )
        c.hide();
    };
    expire();
    return () => clearTimeout(timer);
  }, [c, c.pending, c.editReview, c.publicReview, c.status]);
  const connection = c.status?.connection;
  return (
    <article className="card news-connection" aria-label="News connection">
      <h3>News</h3>
      <p>
        Read articles from your own News account using an existing connection
        key. Articles are loaded only when you ask.
      </p>
      <p>
        <a
          href="https://news.bittrees.org/account/ai"
          target="_blank"
          rel="noopener noreferrer"
        >
          Manage keys and permissions in News
        </a>
      </p>
      <p className="hint">
        Starts with read-only access. Each preview edit requires a separate
        review and curation confirmation. Publication requires its own full
        public review and confirmation. Manage deliveries and schedules in News.
      </p>
      {c.error && <p role="alert">{c.error}</p>}
      {!c.status ? (
        <p role="status">Connection status has not loaded.</p>
      ) : !c.status.available ? (
        <p>This build does not support the News connection.</p>
      ) : connection ? (
        <>
          <p>
            Key{" "}
            {connection.state === "expired" ? "expired" : "saved on this Mac"} ·
            Expires {new Date(connection.expiresAt).toLocaleString()}
          </p>
          <p className="hint">
            News checks access for every read. Removing the key here does not
            revoke it in News or other clients.
          </p>
          <details>
            <summary>Connection details</summary>
            <p>Account: {connection.accountId}</p>
            <p>Key permissions: {connection.scopes.join(", ")}</p>
          </details>
          <button
            disabled={c.busy || connection.state === "expired"}
            onClick={() => void c.read()}
          >
            Load my News articles
          </button>{" "}
          <button
            disabled={c.busy}
            onClick={() => {
              if (
                confirm(
                  "Remove this News key from this Mac? Revoke it in News separately if you want to disable it everywhere.",
                )
              )
                void c.forget();
            }}
          >
            Remove from this Mac
          </button>
        </>
      ) : c.pending ? (
        <section aria-label="Review News connection">
          <h4>Review this connection</h4>
          <p>
            News verified the key. Saving the key enables reads. Editing also
            requires curation permission and a separate confirmation for each
            change.
          </p>
          <p>
            Expires {new Date(c.pending.connection.expiresAt).toLocaleString()}{" "}
            · Key permissions: {c.pending.connection.scopes.join(", ")}
          </p>
          <details>
            <summary>Verified account</summary>
            <p>{c.pending.connection.accountId}</p>
          </details>
          <label className="check">
            <input
              type="checkbox"
              checked={c.confirmed}
              onChange={(e) => {
                c.confirmed = e.target.checked;
                render((n) => n + 1);
              }}
            />{" "}
            Save this key in this Mac’s Keychain for read-only News access.
          </label>
          <button
            disabled={c.busy || !c.confirmed}
            onClick={() => void c.confirm()}
          >
            Save News connection
          </button>{" "}
          <button disabled={c.busy} onClick={() => void c.cancel()}>
            Cancel review
          </button>
        </section>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void c.prepare();
          }}
        >
          <label>
            Existing News connection key
            <input
              type="password"
              autoComplete="off"
              maxLength={68}
              value={c.token}
              onChange={(e) => c.editToken(e.target.value)}
              placeholder="Paste your News key"
            />
          </label>
          <button disabled={c.busy || !/^tbn_[a-f0-9]{64}$/.test(c.token)}>
            Review key
          </button>
        </form>
      )}
      <button disabled={c.busy} onClick={() => void c.refresh()}>
        Refresh News connection
      </button>
      {connection && (
        <NewsCuration controller={c} changed={() => render((n) => n + 1)} />
      )}
      <NewsPublication controller={c} changed={() => render((n) => n + 1)} />
      {c.checkedAt && (
        <section aria-label="News articles">
          <h4>Your News articles</h4>
          <p className="hint">
            Snapshot checked {new Date(c.checkedAt).toLocaleString()}. Source
            text is unverified. This view clears when you leave or refresh.
          </p>
          {!c.articles.length && (
            <p>No eligible articles were returned for your account.</p>
          )}
          {c.articles.map((item) => (
            <article key={item.id}>
              <h4>
                <a href={item.url} target="_blank" rel="noopener noreferrer">
                  {item.title}
                </a>
              </h4>
              <p>{item.summary || item.excerpt}</p>
              <p className="hint">
                {item.source_id} ·{" "}
                {new Date(item.published_at).toLocaleString()}
              </p>
            </article>
          ))}
        </section>
      )}
    </article>
  );
}
