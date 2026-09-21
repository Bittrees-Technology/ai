import React, { useEffect, useRef, useState } from "react";
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
export function AutoNoteReviewControls({
  id,
  api,
  onError,
}: {
  id: string;
  api: Api;
  onError: (e: unknown) => void;
}) {
  const [items, setItems] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [content, setContent] = useState<any>(null);
  const operation = useRef(crypto.randomUUID()),
    epoch = useRef(0),
    working = useRef(false);
  const base = "/v1/requests/" + id + "/autonote-reviews";
  async function refresh() {
    const data = await api(base);
    setItems(data.items);
    setLoaded(true);
  }
  async function act(fn: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(e);
    } finally {
      try {
        await refresh();
      } catch (e) {
        onError(e);
      }
      working.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    api(base)
      .then((data) => {
        if (active) {
          setItems(data.items);
          setLoaded(true);
        }
      })
      .catch(onError);
    const clear = () => {
      epoch.current++;
      setContent(null);
    };
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    return () => {
      active = false;
      clear();
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", clear);
    };
  }, [id]);
  useEffect(() => {
    if (!content) return;
    const timer = setTimeout(() => {
      epoch.current++;
      setContent(null);
    }, 15000);
    return () => clearTimeout(timer);
  }, [content]);
  return (
    <section>
      <h3>Save through AutoNote review</h3>
      <p>
        Enable draft review uploads on your AutoNote connection first. Preparing
        a submission below keeps it local. Sending it transfers the exact draft
        to AutoNote; only your review there can save it. Nothing is published to
        CRM here.
      </p>
      <a
        href="https://autonote.bittrees.org/connect/ai"
        target="_blank"
        rel="noopener noreferrer"
      >
        Manage AutoNote review permission
      </a>
      <button disabled={busy} onClick={() => void act(async () => {})}>
        Refresh submission status
      </button>
      {loaded && !items.length && (
        <button
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await api(base, "POST", { operationId: operation.current });
            })
          }
        >
          Prepare local submission
        </button>
      )}
      {items.map((item) => (
        <article key={item.id}>
          <p>
            Submission:{" "}
            {item.state === "local"
              ? "Local only"
              : item.state === "uncertain"
                ? "Outcome uncertain — check the source receipt"
                : item.state === "prepared"
                  ? "Sent for source review"
                  : item.state === "saved"
                    ? "Saved in AutoNote"
                    : "Deleted at source"}
          </p>
          <p>
            <small>Operation reference: {item.id}</small>
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                setContent(null);
                const generation = ++epoch.current;
                const data = await api(
                  "/v1/autonote-reviews/" + item.id + "/content",
                );
                if (
                  generation === epoch.current &&
                  !document.hidden &&
                  document.hasFocus()
                )
                  setContent(data);
              })
            }
          >
            View exact submission
          </button>
          {item.state === "local" && (
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api(
                    "/v1/autonote-reviews/" + item.id + "/prepare",
                    "POST",
                    {},
                  );
                })
              }
            >
              Send to AutoNote for review
            </button>
          )}
          {item.state === "uncertain" && !item.review && (
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api(
                    "/v1/autonote-reviews/" + item.id + "/prepare",
                    "POST",
                    {},
                  );
                })
              }
            >
              Retry original submission
            </button>
          )}
          {["prepared", "uncertain"].includes(item.state) && (
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api(
                    "/v1/autonote-reviews/" + item.id + "/reconcile",
                    "POST",
                    {},
                  );
                })
              }
            >
              Check AutoNote receipt
            </button>
          )}
          {item.review && (
            <p>
              <a
                href={item.review.reviewUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open AutoNote review
              </a>{" "}
              · Review expires{" "}
              {new Date(item.review.expiresAt).toLocaleString()}. On AutoNote,
              load draft reviews and open this meeting’s draft.
            </p>
          )}
          {item.receipt && (
            <p>
              Saved meeting version {item.receipt.version}. This is the original
              save receipt, not a claim about current access or CRM publication.
            </p>
          )}
        </article>
      ))}
      {content && (
        <details open>
          <summary>
            Exact local submission · clears after 15 seconds or when leaving
            this window
          </summary>
          <pre>{JSON.stringify(content.proposal, null, 2)}</pre>
        </details>
      )}
      <p>
        Deleting local task data removes local submission history. Delete an
        independently staged draft in AutoNote separately. Recover uncertain
        receipts before creating replacement drafts.
      </p>
    </section>
  );
}
