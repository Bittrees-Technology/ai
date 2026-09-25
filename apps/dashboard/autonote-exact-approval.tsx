import React, { useEffect, useId, useRef, useState } from "react";
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
export function AutoNoteExactApproval({
  id,
  api,
  onChanged,
}: {
  id: string;
  api: Api;
  onChanged: () => Promise<void>;
}) {
  const [review, setReview] = useState<any>(null),
    [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const epoch = useRef(0),
    active = useRef(false),
    working = useRef(false),
    region = useRef<HTMLElement>(null),
    ackId = useId();
  const base = "/v1/autonote-reviews/" + id;
  function cancel() {
    epoch.current++;
    setReview(null);
    setAck(false);
    if (active.current) {
      active.current = false;
      void api(base + "/approval-cancel", "POST", {}).catch(() => {});
    }
  }
  const valid = (r: any) =>
    document.hasFocus() &&
    !document.hidden &&
    Date.now() >= r.start &&
    Date.now() < Date.parse(r.expiresAt) &&
    performance.now() - r.mono >= 0 &&
    performance.now() - r.mono < r.ttl;
  useEffect(() => {
    const blur = () => cancel(),
      visibility = () => {
        if (document.hidden) cancel();
      },
      key = (e: KeyboardEvent) => {
        if (e.key === "Escape") cancel();
      },
      outside = (e: PointerEvent) => {
        if (!region.current?.contains(e.target as Node)) cancel();
      };
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside);
    return () => {
      cancel();
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", outside);
    };
  }, [id, api]);
  useEffect(() => {
    if (!review) return;
    const timer = setInterval(() => {
      if (!valid(review)) cancel();
    }, 250);
    return () => clearInterval(timer);
  }, [review]);
  async function run(fn: (generation: number) => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    const generation = epoch.current;
    try {
      await fn(generation);
    } catch {
      if (generation === epoch.current) {
        cancel();
        setError(
          "The outcome could not be confirmed. Check the AutoNote receipt before reviewing again.",
        );
      }
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  return (
    <section ref={region} aria-label="Exact AutoNote approval">
      <h4>Review and save from this companion</h4>
      <p>
        Requires your separate AutoNote approval permission. The exact resulting
        notes below will be saved to this meeting; nothing is published to CRM.
      </p>
      {error && <p role="alert">{error}</p>}
      {!review && (
        <button
          disabled={busy}
          onClick={() =>
            void run(async (generation) => {
              if (!document.hasFocus() || document.hidden) return;
              active.current = true;
              const data = await api(base + "/approval-review", "POST", {});
              if (
                generation !== epoch.current ||
                !document.hasFocus() ||
                document.hidden
              )
                return;
              const start = Date.now(),
                ttl = Date.parse(data.expiresAt) - start;
              if (ttl <= 0 || ttl > 60000) throw Error();
              setAck(false);
              setReview({ ...data, start, ttl, mono: performance.now() });
            })
          }
        >
          Review exact notes to save
        </button>
      )}
      {review && (
        <>
          <h5>{review.detail.title}</h5>
          <p>
            Audience:{" "}
            {review.detail.visibility === "private"
              ? "Private meeting"
              : "Meeting workspace"}
            . Review expires at{" "}
            {new Date(review.expiresAt).toLocaleTimeString()}.
          </p>
          <h5>Resulting notes</h5>
          <p style={{ whiteSpace: "pre-wrap" }}>
            {review.detail.notes.summary}
          </p>
          {(
            [
              "topics",
              "decisions",
              "actions",
              "questions",
              "recommendations",
            ] as const
          ).map((group) => (
            <div key={group}>
              <h5>{group.slice(0, 1).toUpperCase() + group.slice(1)}</h5>
              {review.detail.notes[group].length ? (
                <ul>
                  {review.detail.notes[group].map((item: any) => (
                    <li key={item.id}>
                      <p>{item.text}</p>
                      <p>
                        Evidence: {item.evidence.join(", ")}. Status:{" "}
                        {item.status}.
                        {item.owner ? " Owner: " + item.owner + "." : ""}
                        {item.dueDate ? " Due: " + item.dueDate + "." : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>None</p>
              )}
            </div>
          ))}
          <label
            htmlFor={ackId}
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <input
              id={ackId}
              type="checkbox"
              checked={ack}
              disabled={busy}
              style={{ width: "auto", margin: 0 }}
              onChange={(e) => setAck(e.target.checked)}
            />
            I reviewed these exact notes and the meeting audience.
          </label>
          <button
            disabled={busy || !ack}
            onClick={() =>
              void run(async (generation) => {
                const current = review;
                if (!ack || !valid(current)) {
                  cancel();
                  return;
                }
                setReview(null);
                setAck(false);
                try {
                  await api(base + "/approve", "POST", {
                    reviewToken: current.reviewToken,
                    confirmed: true,
                    acknowledged: true,
                  });
                } finally {
                  active.current = false;
                  await onChanged();
                }
                if (generation !== epoch.current) return;
              })
            }
          >
            Save these exact notes in AutoNote
          </button>
          <button onClick={cancel}>Cancel exact approval</button>
        </>
      )}
      {busy && (
        <p role="status">
          Checking AutoNote. If confirmation was sent, cancellation cannot undo
          the save; check its receipt.
        </p>
      )}
    </section>
  );
}
