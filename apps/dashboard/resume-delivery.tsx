import React, { useEffect, useRef, useState } from "react";
import type { CompanionPrivateResumes } from "../companion/private-resumes.js";
import type { CompanionPrivateRelay } from "../companion/private-relay.js";
import type { relayQueueReview } from "../../modules/remote/private-relay-queue.js";
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
type Data = {
  resumes: ReturnType<CompanionPrivateResumes["status"]>;
  relay: ReturnType<CompanionPrivateRelay["status"]>;
};
type Item = NonNullable<ReturnType<typeof relayQueueReview>>;
type Review = {
  action: "receive" | "send";
  body: unknown;
  snapshot: string;
  text: string;
  start: number;
  mono: number;
  expires: number;
};
export function ResumeDelivery({
  api,
  onClose,
}: {
  api: Api;
  onClose: () => void;
}) {
  const [data, setData] = useState<Data | null>(null),
    [connection, setConnection] = useState(""),
    [permission, setPermission] = useState("");
  const [review, setReview] = useState<Review | null>(null),
    [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(
      "Refresh to choose an active connection and a saved resume permission.",
    ),
    [error, setError] = useState("");
  const [queue, setQueue] = useState<{
    item: Item | null;
    nextCursor: unknown;
    after: unknown;
  } | null>(null);
  const cancellation = useRef<Promise<void>>(Promise.resolve());
  const generation = useRef(0),
    running = useRef(false),
    mounted = useRef(true);
  const focused = () => document.hasFocus() && !document.hidden;
  const valid = (r: Review) =>
    focused() &&
    Date.now() >= r.start &&
    Date.now() < r.expires &&
    performance.now() >= r.mono &&
    performance.now() - r.mono < Math.min(120000, r.expires - r.start);
  function hide() {
    generation.current++;
    setReview(null);
    setAck(false);
    setQueue(null);
    cancellation.current = cancellation.current
      .then(async () => {
        await api("/v1/private-relay/cancel-review", "POST", {
          confirmed: true,
        });
      })
      .catch(() => {});
  }
  useEffect(() => {
    mounted.current = true;
    const blur = () => hide(),
      visibility = () => {
        if (document.hidden) hide();
      },
      escape = (e: KeyboardEvent) => {
        if (e.key === "Escape") hide();
      };
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", escape);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      mounted.current = false;
      generation.current++;
      void api("/v1/private-relay/cancel-review", "POST", {
        confirmed: true,
      }).catch(() => {});
      window.removeEventListener("blur", blur);
      window.removeEventListener("keydown", escape);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [api]);
  useEffect(() => {
    if (!review) return;
    const timer = setInterval(() => {
      if (!valid(review)) hide();
    }, 500);
    return () => clearInterval(timer);
  }, [review]);
  async function read(): Promise<Data> {
    return {
      resumes: await api("/v1/private-resume"),
      relay: await api("/v1/private-relay"),
    };
  }
  async function run(work: (check: () => void) => Promise<void>) {
    if (running.current || !mounted.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    const g = generation.current,
      start = Date.now(),
      mono = performance.now();
    const check = () => {
      if (
        !mounted.current ||
        g !== generation.current ||
        !focused() ||
        Date.now() < start ||
        Date.now() - start >= 120000 ||
        performance.now() < mono ||
        performance.now() - mono >= 120000
      )
        throw Error("DENIED");
    };
    try {
      await cancellation.current;
      check();
      await work(check);
      check();
    } catch {
      if (mounted.current && g === generation.current) {
        setReview(null);
        setAck(false);
        setError(
          "The result was not confirmed. Refresh saved receipts before repeating an action; the Mac may already have accepted the request.",
        );
      }
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const selected = data?.relay.state.items.find((r) => r.id === connection);
  const grant = data?.resumes.grants.find((g) => g.id === permission);
  const connectionInput = (d: Data) => {
    const r = d.relay.state.items.find((r) => r.id === connection);
    if (
      !r ||
      r.locked ||
      r.phase !== "active" ||
      !r.permission ||
      r.permission.state !== "active" ||
      r.permission.expiresAt <= Date.now()
    )
      throw Error("DENIED");
    return { id: r.id, expectedRevision: r.revision };
  };
  async function refresh() {
    hide();
    await run(async (check) => {
      const next = await read();
      check();
      setData(next);
      setNotice("Resume permissions and saved receipts loaded.");
    });
  }
  async function inspect(after: unknown = null) {
    hide();
    await run(async (check) => {
      const next = await read();
      check();
      const result = await api("/v1/private-relay/inspect-resume", "POST", {
        connection: connectionInput(next),
        after,
        confirmed: true,
      });
      check();
      setData(next);
      setQueue({ ...result, after });
      setNotice(
        result.item
          ? "Queued item inspected. Inspection does not resume a task or acknowledge delivery."
          : "No queued item is available.",
      );
    });
  }
  async function begin(action: Review["action"], commandId?: string) {
    const inspected = queue;
    hide();
    await run(async (check) => {
      const next = await read();
      check();
      const selectedConnection = connectionInput(next);
      let body: unknown,
        text: string,
        expires = Date.now() + 120000;
      if (action === "receive") {
        const g = next.resumes.grants.find((g) => g.id === permission);
        if (!g || g.state !== "saved" || !inspected?.item)
          throw Error("DENIED");
        expires = Math.min(
          expires,
          g.choices.expiresAt,
          inspected.item.expiresAt,
        );
        body = {
          connection: selectedConnection,
          after: inspected.after,
          selection: inspected.item.selection,
          permissionId: g.id,
          confirmed: true,
        };
        text = `Resume task ${g.choices.taskId}, version ${g.choices.taskRevision}, using model ${g.choices.modelDigest}, from browser ${g.choices.peerId}. Permission ${g.id}. Selected item ${inspected.item.selection.messageId}, fingerprint ${inspected.item.selection.envelopeHash}. Only a matching authenticated request can resume this task.`;
      } else {
        const receipt = next.resumes.deliveries.find(
          (d) => d.commandId === commandId && !d.locked,
        );
        if (!receipt) throw Error("DENIED");
        expires = Math.min(expires, receipt.expiresAt);
        body = {
          connection: selectedConnection,
          permissionId: receipt.permissionId,
          commandId: receipt.commandId,
          confirmed: true,
        };
        text = `Send the saved acceptance receipt for task ${receipt.receipt.taskId}, version ${receipt.receipt.taskRevision}, request ${receipt.commandId}. This confirms the resume transition, not completed inference. Retrying sends the same receipt.`;
      }
      setData(next);
      setReview({
        action,
        body,
        text: `${text} Access ends ${new Date(expires).toLocaleString()}.`,
        snapshot: JSON.stringify(next),
        start: Date.now(),
        mono: performance.now(),
        expires,
      });
      setAck(false);
    });
  }
  async function confirm() {
    const r = review;
    if (!r || !ack || !valid(r)) {
      hide();
      return;
    }
    await run(async (check) => {
      const before = await read();
      check();
      if (!valid(r) || JSON.stringify(before) !== r.snapshot)
        throw Error("CONFLICT");
      setReview(null);
      setAck(false);
      await api(
        r.action === "receive"
          ? "/v1/private-relay/check-resume"
          : "/v1/private-relay/send-resume-receipt",
        "POST",
        r.body,
      );
      check();
      if (!valid(r)) throw Error("DENIED");
      const next = await read();
      check();
      setData(next);
      setQueue(null);
      setNotice(
        r.action === "receive"
          ? "Mac accepted the resume request. Sending its receipt is a separate action; task completion is not confirmed."
          : "Relay stored the saved receipt. Browser receipt acceptance is not confirmed.",
      );
    });
  }
  return (
    <section className="resume-permissions" aria-label="Mac resume delivery">
      <h3>Resume requests from your browser</h3>
      <p>
        Inspect one queued request, review its exact task permission, then send
        the saved acceptance receipt.
      </p>
      <div className="actions">
        <button disabled={busy} onClick={() => void refresh()}>
          Refresh Mac resume delivery
        </button>
        <button
          onClick={() => {
            hide();
            onClose();
          }}
        >
          Close Mac resume delivery
        </button>
      </div>
      <p role="status">{notice}</p>
      {error && <p role="alert">{error}</p>}
      <label>
        Connection for resume delivery
        <select
          value={connection}
          disabled={busy || !!review}
          onChange={(e) => {
            hide();
            setConnection(e.target.value);
          }}
        >
          <option value="">Choose a saved connection</option>
          {data?.relay.state.items.map((r) => (
            <option key={r.id} value={r.id}>
              {r.id} — {r.phase}
            </option>
          ))}
        </select>
      </label>
      <label>
        Permission for this resume
        <select
          value={permission}
          disabled={busy || !!review}
          onChange={(e) => {
            hide();
            setPermission(e.target.value);
          }}
        >
          <option value="">Choose a task permission</option>
          {data?.resumes.grants.map((g) => (
            <option key={g.id} value={g.id}>
              {g.choices.taskId} — {g.state}
            </option>
          ))}
        </select>
      </label>
      <div className="actions">
        <button
          disabled={busy || !!review || !selected}
          onClick={() => void inspect()}
        >
          Inspect queued resume request
        </button>
        {queue?.nextCursor != null && (
          <button
            disabled={busy || !!review}
            onClick={() => void inspect(queue.nextCursor)}
          >
            Inspect next resume queue item
          </button>
        )}
        {queue?.item && (
          <button
            disabled={busy || !!review || !grant}
            onClick={() => void begin("receive")}
          >
            Review accepting resume request
          </button>
        )}
      </div>
      {queue?.item && (
        <p className="hint" style={{ overflowWrap: "anywhere" }}>
          Selected item {queue.item.selection.messageId}. Inspecting or skipping
          does not acknowledge it.
        </p>
      )}
      <h4>Saved acceptance receipts</h4>
      {data?.resumes.deliveries.map((d) => (
        <article key={d.commandId}>
          <p style={{ overflowWrap: "anywhere" }}>
            Task {d.receipt.taskId}, version {d.receipt.taskRevision}. Request{" "}
            {d.commandId}. Resume accepted; task completion is not confirmed.
          </p>
          <button
            disabled={busy || !!review || d.locked || !selected}
            onClick={() => void begin("send", d.commandId)}
          >
            Review sending resume receipt
          </button>
        </article>
      ))}
      {review && (
        <article className="review">
          <h4>
            {review.action === "receive"
              ? "Accept this resume request"
              : "Send this resume receipt"}
          </h4>
          <p style={{ overflowWrap: "anywhere" }}>{review.text}</p>
          <label>
            <input
              type="checkbox"
              checked={ack}
              disabled={busy}
              onChange={(e) => setAck(e.target.checked)}
            />
            I reviewed this task, permission and exact action.
          </label>
          <div className="actions">
            <button disabled={busy || !ack} onClick={() => void confirm()}>
              Confirm Mac resume action
            </button>
            <button onClick={() => hide()}>Cancel Mac resume review</button>
          </div>
        </article>
      )}
    </section>
  );
}
