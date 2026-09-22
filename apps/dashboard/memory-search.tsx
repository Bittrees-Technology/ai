import React, { useEffect, useState } from "react";
import { MemorySearchController } from "./memory-state.js";
export function MemorySearch({
  api,
  onError,
}: {
  api: (path: string, method: string, body: unknown) => Promise<any>;
  onError: (error: unknown) => void;
}) {
  const [, render] = useState(0);
  const [controller] = useState(
    () => new MemorySearchController(api, () => render((v) => v + 1)),
  );
  useEffect(() => {
    const hide = () => controller.hide();
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", hide);
      controller.hide();
    };
  }, [controller]);
  return (
    <section aria-labelledby="memory-search-heading">
      <h3 id="memory-search-heading">Find reviewed memory</h3>
      <p>
        Search stays on this Mac. Only currently accessible, approved memories
        can appear. Search does not select memory for a task or make a statement
        verified.
      </p>
      <p>
        Identical text of the same memory type appears once in search. All saved
        copies keep their own source and review history.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void controller.search().catch(onError);
        }}
      >
        <label>
          Words to find
          <input
            maxLength={512}
            value={controller.query}
            onChange={(event) => controller.edit(event.target.value)}
          />
        </label>
        <button
          disabled={controller.busy || !controller.query.trim()}
          type="submit"
        >
          {controller.busy ? "Searching…" : "Search memory"}
        </button>
        <button type="button" onClick={() => controller.hide()}>
          Clear search
        </button>
      </form>
      {controller.searched && !controller.results.length && (
        <p role="status">
          No approved, accessible memory matched. Try other words or review a
          candidate below.
        </p>
      )}
      {controller.results.map((item) => (
        <article className="memory" key={item.id}>
          <p className="status">{item.type} · Reviewed, unverified</p>
          <p className="prose">{item.text}</p>
          <details>
            <summary>Why this matched and where it came from</summary>
            <p>
              Matched {Math.round(item.why.relevance * 100)}% of the search
              terms. Recency, explicit usefulness feedback and{" "}
              {item.why.pinned ? "your pin" : "pin status"} also affect order.
              These are search signals, not confidence in the statement.
            </p>
            <p>
              {item.why.sourcePenalty > 0
                ? "To broaden source coverage, this result received a repeated-source penalty while ranking."
                : "This result has no repeated-source penalty."}{" "}
              Source diversity only reorders candidates with the same query-term
              coverage.
            </p>
            <p>
              Origin:{" "}
              {item.why.provenance === "model"
                ? "model-generated candidate"
                : "user-entered candidate"}
              . Repeated searching does not increase usefulness.
            </p>
            <ul>
              {item.sources.map((source, index) => (
                <li key={index}>
                  {source.app} source <code>{source.resourceId}</code>, version{" "}
                  {source.revision}.
                </li>
              ))}
            </ul>
          </details>
        </article>
      ))}
    </section>
  );
}
