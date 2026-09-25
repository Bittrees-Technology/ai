import React, { useEffect, useId, useRef, useState } from "react";
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
const base = "/v1/private-autonote-approvals";
const labels: Record<string, string> = {
  grant: "Allow this browser to approve these notes",
  revoke: "Revoke browser approval permission",
  create: "Prepare encrypted notes",
  send: "Send remaining encrypted parts",
  stop: "Stop this offer",
  remove: "Remove this local offer",
  receive: "Receive this browser decision",
  execute: "Save the browser-approved notes",
  reconcile: "Check the existing save receipt",
  "prepare-result": "Prepare the encrypted result",
  "send-result": "Send this result to the browser",
};
export function AutoNoteBrowserApproval({
  id,
  expiresAt,
  api,
}: {
  id: string;
  expiresAt: string;
  api: Api;
}) {
  const [data, setData] = useState<any>(null),
    [peers, setPeers] = useState<any[]>([]),
    [connections, setConnections] = useState<any[]>([]);
  const [peer, setPeer] = useState(""),
    [connection, setConnection] = useState(""),
    [review, setReview] = useState<any>(null);
  const [after, setAfter] = useState<any>(null);
  const [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const epoch = useRef(0),
    working = useRef(false),
    active = useRef(false),
    mounted = useRef(true),
    region = useRef<HTMLElement>(null);
  const cancellation = useRef<Promise<unknown>>(Promise.resolve());
  const peerLabel = useId(),
    relayLabel = useId(),
    ackLabel = useId();
  const focused = () => document.hasFocus() && !document.hidden;
  function cancel() {
    epoch.current++;
    setReview(null);
    setAck(false);
    if (active.current) {
      active.current = false;
      cancellation.current = cancellation.current
        .then(() => api(base + "/cancel", "POST", {}))
        .catch(() => {});
    }
  }
  const valid = (r: any) =>
    focused() &&
    Date.now() >= r.at &&
    Date.now() < r.expiresAt &&
    performance.now() >= r.mono &&
    performance.now() - r.mono < Math.min(60000, r.expiresAt - r.at);
  useEffect(() => {
    mounted.current = true;
    const blur = () => cancel(),
      hidden = () => {
        if (document.hidden) cancel();
      },
      key = (e: KeyboardEvent) => {
        if (e.key === "Escape") cancel();
      },
      outside = (e: PointerEvent) => {
        if (!region.current?.contains(e.target as Node)) cancel();
      };
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside);
    return () => {
      mounted.current = false;
      cancel();
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", outside);
    };
  }, [id, expiresAt, api]);
  useEffect(() => {
    if (!review) return;
    const timer = setInterval(() => {
      if (!valid(review)) cancel();
    }, 250);
    return () => clearInterval(timer);
  }, [review]);
  async function run(fn: (g: number) => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    const g = epoch.current;
    try {
      await cancellation.current;
      if (g === epoch.current && mounted.current) await fn(g);
    } catch {
      if (mounted.current && g === epoch.current) {
        cancel();
        setError(
          "The outcome is uncertain. Refresh progress before reviewing another action.",
        );
      }
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function refresh() {
    cancel();
    await run(async (g) => {
      const [status, paired, relay] = await Promise.all([
        api(base + "/" + id),
        api("/v1/private-peers"),
        api("/v1/private-relay"),
      ]);
      if (g !== epoch.current || !mounted.current) return;
      setData(status);
      setPeers((paired.peers ?? []).filter((p: any) => !p.revoked));
      setConnections(
        (relay.state?.items ?? []).filter(
          (r: any) =>
            !r.locked &&
            r.phase === "active" &&
            r.permission?.state === "active" &&
            r.permission.expiresAt > Date.now(),
        ),
      );
    });
  }
  async function prepare(action: string, extra: any) {
    cancel();
    await run(async (g) => {
      if (!focused()) return;
      active.current = true;
      const at = Date.now(),
        mono = performance.now();
      const r = await api(base + "/prepare", "POST", {
        action,
        operationId: id,
        expectedRevision: data.revision,
        ...extra,
      });
      if (g === epoch.current && mounted.current && focused())
        setReview({ ...r, at, mono });
    });
  }
  const target = peers.find((p) => p.peerId === peer),
    relay = connections.find((c) => c.id === connection);
  const grant = review?.summary?.grant ?? review?.summary;
  return (
    <section
      ref={region}
      className="autonote-browser-approval"
      aria-label="Browser approval delivery"
    >
      <h4>Review on a paired browser</h4>
      <p>
        Prepare and send these exact notes with a separate browser permission.
        The browser decision return is still being built; received decisions
        appear below.
      </p>
      <button disabled={busy} onClick={() => void refresh()}>
        Refresh browser approval progress
      </button>
      {error && <p role="alert">{error}</p>}
      {data && !data.canSetup && (
        <p>Encrypted approval delivery is not enabled on this companion.</p>
      )}
      {data?.canSetup && (
        <>
          <label htmlFor={peerLabel}>Paired browser</label>
          <select
            id={peerLabel}
            value={peer}
            disabled={busy}
            onChange={(e) => {
              cancel();
              setPeer(e.target.value);
            }}
          >
            <option value="">Choose a paired browser</option>
            {peers.map((p) => (
              <option key={p.peerId} value={p.peerId}>
                {p.fingerprint}
              </option>
            ))}
          </select>
          <button
            disabled={busy || !target || !!review}
            onClick={() =>
              void prepare("grant", {
                peerId: target.peerId,
                peerKeyEpoch: target.keyEpoch,
                expiresAt: Math.min(Date.now() + 300000, Date.parse(expiresAt)),
              })
            }
          >
            Review browser permission
          </button>
          <label htmlFor={relayLabel}>Encrypted relay connection</label>
          <select
            id={relayLabel}
            value={connection}
            disabled={busy}
            onChange={(e) => {
              cancel();
              setConnection(e.target.value);
              setAfter(null);
            }}
          >
            <option value="">Choose an active connection</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id}
              </option>
            ))}
          </select>
        </>
      )}
      {(data?.permissions ?? []).map((p: any) => (
        <div key={p.id}>
          <p>
            Browser fingerprint:{" "}
            <span className="approval-fingerprint">{p.fingerprint}</span>
          </p>
          <p>
            {p.revoked ? "Revoked" : "Permission retained"}. Expires{" "}
            {new Date(p.expiresAt).toLocaleString()}.
          </p>
          {!p.revoked && (
            <>
              <button
                disabled={
                  busy ||
                  !!review ||
                  !data.canSetup ||
                  p.expiresAt <= Date.now()
                }
                onClick={() => void prepare("create", { permissionId: p.id })}
              >
                Review preparing encrypted notes
              </button>
              <button
                disabled={
                  busy ||
                  !!review ||
                  !data.canSetup ||
                  !relay ||
                  p.expiresAt <= Date.now()
                }
                onClick={() =>
                  void prepare("receive", {
                    permissionId: p.id,
                    connection: {
                      id: relay.id,
                      expectedRevision: relay.revision,
                    },
                    after,
                  })
                }
              >
                Review receiving a browser decision
              </button>
              <button
                disabled={busy || !!review}
                onClick={() => void prepare("revoke", { permissionId: p.id })}
              >
                Review revoking permission
              </button>
            </>
          )}
        </div>
      ))}
      {(data?.offers ?? []).map((o: any) => (
        <div key={o.id}>
          <p>
            {
              o.packets.filter((p: any) =>
                ["stored", "received"].includes(p.receipt?.state),
              ).length
            }{" "}
            of {o.packets.length} parts stored at the relay.{" "}
            {o.state === "stopped"
              ? "Offer stopped."
              : "This does not mean the browser approved or saved the notes."}
          </p>
          {o.packets.some((p: any) => p.attempts > 0 && !p.receipt) && (
            <p>
              A previous upload has no confirmed receipt. Retrying sends the
              same encrypted parts.
            </p>
          )}
          {o.state !== "stopped" ? (
            <>
              <button
                disabled={
                  busy ||
                  !!review ||
                  !data.canSetup ||
                  !relay ||
                  o.expiresAt <= Date.now() ||
                  !o.packets.some((p: any) => !p.receipt)
                }
                onClick={() =>
                  void prepare("send", {
                    offerId: o.id,
                    connection: {
                      id: relay.id,
                      expectedRevision: relay.revision,
                    },
                  })
                }
              >
                Review sending remaining parts
              </button>
              <button
                disabled={busy || !!review}
                onClick={() => void prepare("stop", { offerId: o.id })}
              >
                Review stopping offer
              </button>
            </>
          ) : (
            <button
              disabled={busy || !!review}
              onClick={() => void prepare("remove", { offerId: o.id })}
            >
              Review removing local offer
            </button>
          )}
        </div>
      ))}
      {after && (
        <button
          disabled={busy}
          onClick={() => {
            cancel();
            setAfter(null);
          }}
        >
          Start at first queued message
        </button>
      )}
      {(data?.decisions ?? []).map((d: any) => (
        <div key={d.decisionId}>
          <p>
            Browser decision: {d.decision}.{" "}
            {d.state === "accepted"
              ? "Ready for a separate save confirmation."
              : d.state === "uncertain"
                ? "Save outcome uncertain. Check the receipt before taking further action."
                : d.state === "saved"
                  ? `Saved meeting version ${d.result.receipt.version}.`
                  : "Rejected; no save requested."}
          </p>
          {d.state === "accepted" && (
            <button
              disabled={busy || !!review || !data.canSetup}
              onClick={() =>
                void prepare("execute", { decisionId: d.decisionId })
              }
            >
              Review saving browser-approved notes
            </button>
          )}
          {d.result && (
            <button
              disabled={busy || !!review || !data.canSetup}
              onClick={() =>
                void prepare("prepare-result", { decisionId: d.decisionId })
              }
            >
              Review preparing browser result
            </button>
          )}
          {(d.resultDeliveries ?? []).map((r: any) => (
            <div key={r.messageId}>
              <p>
                {r.status} result:{" "}
                {r.transport
                  ? "Stored at relay."
                  : r.attempts
                    ? "Upload outcome uncertain; retry preserves the original encrypted result."
                    : "Prepared locally."}
              </p>
              {r.status === d.result?.status && (
                <button
                  disabled={
                    busy || !!review || !data.canSetup || !relay || !r.encrypted
                  }
                  onClick={() =>
                    void prepare("send-result", {
                      decisionId: d.decisionId,
                      messageId: r.messageId,
                      connection: {
                        id: relay.id,
                        expectedRevision: relay.revision,
                      },
                    })
                  }
                >
                  Review sending browser result
                </button>
              )}
            </div>
          ))}
          {d.state === "uncertain" && (
            <button
              disabled={busy || !!review}
              onClick={() =>
                void prepare("reconcile", { decisionId: d.decisionId })
              }
            >
              Review checking save receipt
            </button>
          )}
        </div>
      ))}
      {review && (
        <div role="group" aria-label="Review browser approval action">
          <h5>{labels[review.action]}</h5>
          {review.title && (
            <p>
              Meeting: {review.title}. Audience:{" "}
              {review.visibility === "workspace" ? "Workspace" : "Private"}.
            </p>
          )}
          {grant?.peer?.fingerprint && (
            <p>
              Browser fingerprint:{" "}
              <span className="approval-fingerprint">
                {grant.peer.fingerprint}
              </span>
            </p>
          )}
          {grant?.detailHash && (
            <p>
              Exact notes reference:{" "}
              <span className="approval-fingerprint">{grant.detailHash}</span>
            </p>
          )}
          {review.action === "send" && (
            <p>
              Send {review.summary.messageIds.length} remaining encrypted parts
              through the selected connection. This grants no additional source
              permission.
            </p>
          )}
          {review.action === "receive" && (
            <>
              <p>
                Receive queued message {review.summary.item.selection.messageId}
                . Its browser decision is verified before storage. Receiving
                does not save notes.
              </p>
              <button
                disabled={busy}
                onClick={() => {
                  const cursor = review.summary.item.cursor;
                  cancel();
                  setAfter(cursor);
                }}
              >
                Skip this message without receiving
              </button>
            </>
          )}
          {review.action === "execute" && (
            <p>
              Save the exact notes approved by this browser. Current source
              permission and notes are checked again before saving.
            </p>
          )}
          {(review.action === "prepare-result" ||
            review.action === "send-result") && (
            <p>
              Result: {review.summary.result.status}. This shares the recorded
              outcome; it does not save notes again.
            </p>
          )}
          {review.action === "reconcile" && (
            <p>
              Look up the result of the earlier save. This does not send another
              save request.
            </p>
          )}
          <p>
            Review expires {new Date(review.expiresAt).toLocaleTimeString()}.
          </p>
          <label htmlFor={ackLabel}>
            <input
              id={ackLabel}
              type="checkbox"
              checked={ack}
              disabled={busy}
              onChange={(e) => setAck(e.target.checked)}
            />
            I understand and want to perform this action.
          </label>
          <button
            disabled={busy || !ack}
            onClick={() =>
              void run(async (g) => {
                if (!valid(review)) {
                  cancel();
                  return;
                }
                const selected = review;
                setReview(null);
                setAck(false);
                const status = await api(base + "/confirm", "POST", {
                  reviewId: selected.id,
                  confirmed: true,
                  acknowledged: true,
                });
                if (g === epoch.current && mounted.current) {
                  active.current = false;
                  setData(status);
                }
              })
            }
          >
            Confirm reviewed action
          </button>
          <button onClick={cancel}>Cancel browser approval action</button>
        </div>
      )}
    </section>
  );
}
