import React, { useEffect, useRef, useState } from "react";
import type { RetainedCopy } from "../companion/retained-content.js";
type Page = { items: RetainedCopy[]; nextCursor: string | null };
export function RecoveryCopies({
  api,
  onError,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
  onError: (error: unknown) => void;
}) {
  const [page, setPage] = useState<Page | null>(null),
    [busy, setBusy] = useState(false);
  const alive = useRef(true),
    inFlight = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function run(fn: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      if (alive.current) onError(error);
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function load(after?: string) {
    const response: Page = await api(
      "/v1/recovery-copies" +
        (after ? "?after=" + encodeURIComponent(after) : ""),
    );
    if (alive.current) setPage(response);
  }
  return (
    <section aria-label="Retained recovery copies">
      <h3>Retained recovery copies</h3>
      <p>
        Recovery keeps earlier copies of your tasks and memories on this Mac
        until you delete them. Deleting an item from your current data does not
        remove it from these copies or backups saved elsewhere.
      </p>
      <p>
        The active copy and the immediate rollback copy are protected. Deleting
        another copy is permanent. Downloaded models, connection credentials and
        backup files saved elsewhere are separate.
      </p>
      <button disabled={busy} onClick={() => void run(() => load())}>
        {page ? "Refresh copies" : "Show saved copies"}
      </button>
      {page?.items.map((copy) => (
        <article className="memory" key={copy.id}>
          <strong>
            {copy.id === "original"
              ? "Original content"
              : "Recovery copy " + copy.id.slice(-6)}
          </strong>
          <p>
            {copy.modifiedAt === "1970-01-01T00:00:00.000Z"
              ? "Empty recovery folder"
              : "Last changed " +
                new Date(copy.modifiedAt).toLocaleString()}{" "}
            · {(copy.bytes / 1024 / 1024).toFixed(2)} MB
          </p>
          {copy.protectedAs ? (
            <p>
              {copy.protectedAs === "active"
                ? "Currently in use — protected"
                : "Available for immediate rollback — protected"}
            </p>
          ) : (
            <button
              disabled={busy}
              onClick={() => {
                if (
                  !confirm(
                    "Permanently delete this retained copy of task and memory data? Current data and other copies stay in place. This cannot be undone.",
                  )
                )
                  return;
                void run(async () => {
                  await api("/v1/recovery-copies/delete", "POST", {
                    id: copy.id,
                    review: copy.review,
                    confirmed: true,
                  });
                  if (alive.current) {
                    setPage(null);
                    await load();
                  }
                });
              }}
            >
              Delete this copy
            </button>
          )}
        </article>
      ))}
      {page && !page.items.length && <p>No retained copies on this page.</p>}
      {page?.nextCursor && (
        <button
          disabled={busy}
          onClick={() => void run(() => load(page.nextCursor!))}
        >
          Next copies
        </button>
      )}
    </section>
  );
}
