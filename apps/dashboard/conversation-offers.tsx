import React, { useEffect, useMemo, useRef, useState } from "react";
import { ConversationOfferPanelState } from "./conversation-offer-state.js";
import { ConversationChoicesView } from "./conversation-choices.js";
import type { ConversationPermissionStatus } from "./conversation-permission-state.js";
export function ConversationOffers({
  api,
  inboxId,
  conversationId,
  permissions,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
  inboxId: string;
  conversationId: string;
  permissions: ConversationPermissionStatus;
}) {
  const [, render] = useState(0),
    [ack, setAck] = useState(false),
    urls = useRef(new Set<string>());
  const c = useMemo(
    () =>
      new ConversationOfferPanelState(api, { inboxId, conversationId }, () =>
        render((v) => v + 1),
      ),
    [api, inboxId, conversationId],
  );
  const available = () => document.hasFocus() && !document.hidden;
  const revoke = () => {
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current.clear();
  };
  const clear = () => {
    c.hide();
    setAck(false);
    revoke();
  };
  useEffect(() => {
    const visibility = () => {
      if (document.hidden) clear();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") clear();
    };
    window.addEventListener("blur", clear);
    window.addEventListener("keydown", escape);
    document.addEventListener("visibilitychange", visibility);
    const timer = setInterval(() => c.expire(), 250);
    return () => {
      clearInterval(timer);
      c.dispose();
      revoke();
      window.removeEventListener("blur", clear);
      window.removeEventListener("keydown", escape);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [c]);
  useEffect(() => {
    setAck(false);
  }, [c.review?.id]);
  const download = (wire: unknown, id: string) => {
    if (!available()) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(wire)], { type: "application/json" }),
    );
    urls.current.add(url);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bittrees-conversation-offer-${id}.json`;
    a.rel = "noopener";
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      urls.current.delete(url);
    }, 1000);
  };
  const grants = permissions.grants.filter(
      (g) =>
        g.choices.inboxId === inboxId &&
        g.choices.conversationId === conversationId &&
        g.state === "saved",
    ),
    offers =
      c.status?.offers.filter(
        (e) =>
          e.choices.inboxId === inboxId &&
          e.choices.conversationId === conversationId,
      ) ?? [],
    r = c.review;
  return (
    <section
      className="conversation-offers"
      aria-label="Conversation sharing offers"
    >
      <h4>Invite the paired browser</h4>
      <p>
        Create an encrypted offer for this conversation. It contains your
        sharing choices, with no messages or local conversation names.
      </p>
      <p className="hint">
        Browser offer import and conversation delivery are still being prepared.
        Downloading an offer does not start sharing.
      </p>
      <button
        disabled={c.busy}
        onClick={() => {
          setAck(false);
          void c.refresh();
        }}
      >
        Refresh saved offers
      </button>
      {c.error && <p role="alert">{c.error}</p>}
      {c.notice && <p role="status">{c.notice}</p>}
      {c.status && !r && (
        <>
          {grants.length === 0 && (
            <p>Save conversation access above before creating an offer.</p>
          )}
          {grants.map((g) => (
            <div className="conversation-offer-row" key={g.id}>
              <p className="prose">Browser {g.choices.peerId}</p>
              <button
                disabled={
                  c.busy ||
                  !c.status?.canSetup ||
                  !permissions.canSetup ||
                  g.choices.expiresAt <= Date.now()
                }
                onClick={() => {
                  setAck(false);
                  void c.create(g.id, permissions);
                }}
              >
                Review a new sharing offer
              </button>
            </div>
          ))}
          <h5>Saved offers for this conversation</h5>
          {!offers.length && <p>No offers saved.</p>}
          {offers.map((e) => (
            <article key={e.id}>
              <p className="prose">
                Offer {e.id}
                <br />
                Browser {e.choices.peerId}
              </p>
              <p>
                {e.state === "ready"
                  ? "Encrypted offer saved; access will be checked again"
                  : e.state === "preparing"
                    ? "Preparation interrupted; review to continue"
                    : e.state === "stopped"
                      ? "Further downloads stopped"
                      : e.state === "locked"
                        ? "Restored offer locked"
                        : "Offer expired"}
              </p>
              <p>Opening deadline: {new Date(e.expiresAt).toLocaleString()}</p>
              <div className="actions">
                {["ready", "preparing"].includes(e.state) && (
                  <button
                    disabled={
                      c.busy || !c.status?.canSetup || e.expiresAt <= Date.now()
                    }
                    onClick={() => {
                      setAck(false);
                      void c.prepare(e.id, "reveal");
                    }}
                  >
                    Review saved offer download
                  </button>
                )}
                {e.state !== "stopped" && (
                  <button
                    disabled={c.busy}
                    onClick={() => {
                      setAck(false);
                      void c.prepare(e.id, "stop");
                    }}
                  >
                    Review stopping this offer
                  </button>
                )}
              </div>
            </article>
          ))}
        </>
      )}
      {r && (
        <div className="conversation-permission-review">
          <h5>
            {r.action === "stop"
              ? "Stop future offer downloads"
              : r.action === "create"
                ? "Review new sharing offer"
                : "Review saved sharing offer"}
          </h5>
          <p className="prose">
            Conversation {r.choices.conversationId}
            <br />
            Inbox {r.choices.inboxId}
            <br />
            Browser {r.choices.peerId}
          </p>
          <p className="prose">Verified browser fingerprint: {r.fingerprint}</p>
          <ConversationChoicesView choices={r.choices} />
          <p>
            Conversation access ends{" "}
            {new Date(r.choices.expiresAt).toLocaleString()}.<br />
            Offer opening deadline:{" "}
            {new Date(r.offerExpiresAt).toLocaleString()}.<br />
            Review ends {new Date(r.expiresAt).toLocaleString()}.
          </p>
          <p>
            {r.action === "stop"
              ? "Stopping prevents future downloads from this Mac. Copies already downloaded remain. Revoke conversation access above to stop future sharing."
              : "This downloads a file encrypted for the selected browser. The browser must review its own access. No messages are included or sent."}
          </p>
          <label className="conversation-choice">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            <span>I reviewed this offer, browser and deadlines.</span>
          </label>
          <div className="actions">
            <button
              disabled={c.busy || !ack}
              onClick={() => void c.confirm(ack, available, download)}
            >
              {r.action === "stop"
                ? "Stop offer downloads"
                : "Download encrypted offer"}
            </button>
            <button
              disabled={c.busy}
              onClick={() => {
                c.discard();
                setAck(false);
              }}
            >
              Discard offer review
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
