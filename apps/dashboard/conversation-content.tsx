import React, { useEffect, useMemo, useState } from "react";
import { ConversationContentPanelState } from "./conversation-content-state.js";
import type { ConversationPermissionStatus } from "./conversation-permission-state.js";
import type { InboxMessage } from "./inbox-message-state.js";
export function ConversationContent({
  api,
  inboxId,
  conversationId,
  permissions,
  messages,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
  inboxId: string;
  conversationId: string;
  permissions: ConversationPermissionStatus;
  messages: InboxMessage[];
}) {
  const [, render] = useState(0),
    [ack, setAck] = useState(false),
    [permission, setPermission] = useState(""),
    [message, setMessage] = useState(""),
    [connection, setConnection] = useState("");
  const snapshot = JSON.stringify(permissions);
  const c = useMemo(
    () =>
      new ConversationContentPanelState(
        api,
        { inboxId, conversationId },
        JSON.parse(snapshot),
        () => render((v) => v + 1),
      ),
    [api, inboxId, conversationId, snapshot],
  );
  const available = () => document.hasFocus() && !document.hidden;
  const clear = () => {
    c.hide();
    setAck(false);
    setMessage("");
    setPermission("");
    setConnection("");
  };
  useEffect(() => {
    const visibility = () => {
        if (document.hidden) clear();
      },
      escape = (e: KeyboardEvent) => {
        if (e.key === "Escape") clear();
      };
    window.addEventListener("blur", clear);
    window.addEventListener("keydown", escape);
    document.addEventListener("visibilitychange", visibility);
    const timer = setInterval(() => c.expire(), 250);
    return () => {
      clearInterval(timer);
      c.dispose();
      window.removeEventListener("blur", clear);
      window.removeEventListener("keydown", escape);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [c]);
  useEffect(() => setAck(false), [c.review]);
  const r = c.review,
    items = c.items(),
    grants = c
      .grants()
      .filter((g) => g.state === "saved" && g.choices.expiresAt > Date.now());
  const change = () => {
    c.discard();
    setAck(false);
  };
  const action =
    r?.action === "prepare" || r?.action === "seal"
      ? "Prepare encrypted copy"
      : r?.action === "send"
        ? r.entry?.direction === "incoming"
          ? "Upload storage receipt"
          : "Upload encrypted copy"
        : "Stop further uploads";
  return (
    <section
      className="conversation-content"
      aria-label="Conversation message delivery"
    >
      <h4>Send a conversation message</h4>
      <p>
        Prepare one saved message or waiting AI question for your paired
        browser. Uploading is a separate choice.
      </p>
      <button disabled={c.busy} onClick={() => void c.refresh()}>
        Refresh delivery history
      </button>
      {c.error && <p role="alert">{c.error}</p>}
      {c.notice && <p role="status">{c.notice}</p>}
      {c.status && !r && (
        <>
          {c.status.enabled && permissions.canSetup && grants.length > 0 ? (
            <fieldset disabled={c.busy}>
              <legend>Prepare a local encrypted copy</legend>
              <label>
                Message destination
                <select
                  aria-label="Message destination"
                  value={permission}
                  onChange={(e) => {
                    change();
                    setPermission(e.target.value);
                  }}
                >
                  <option value="">Choose saved browser access</option>
                  {grants.map((g) => (
                    <option key={g.id} value={g.id}>
                      Browser {g.choices.peerId} — access {g.id}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Saved local message
                <select
                  aria-label="Saved local message"
                  value={message}
                  onChange={(e) => {
                    change();
                    setMessage(e.target.value);
                  }}
                >
                  <option value="">Choose a message</option>
                  {messages
                    .filter(
                      (m) =>
                        m.input.conversationId === conversationId &&
                        m.input.recipientInboxId === inboxId,
                    )
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        Message {m.sequence}
                        {m.input.requestId ? " (linked to a task)" : ""}
                      </option>
                    ))}
                </select>
              </label>
              <p className="hint">
                The review checks current access and shows the exact saved text.
                Share a reply’s original message first. New copies have a
                delivery window of at most five minutes.
              </p>
              <button
                disabled={!permission || !message || c.busy}
                onClick={() => void c.prepare(message, permission)}
              >
                Review encrypted copy
              </button>
            </fieldset>
          ) : (
            <p>
              Enable private conversation delivery and save browser access to
              prepare new copies. Retained history stays available here.
            </p>
          )}
          <h5>Upload through ai.bittrees.org</h5>
          <button
            disabled={c.busy}
            onClick={() => {
              setConnection("");
              void c.refreshConnections();
            }}
          >
            Refresh message connections
          </button>
          {c.relayStatus &&
            (c.connections().length ? (
              <label>
                Message connection
                <select
                  aria-label="Message connection"
                  value={connection}
                  disabled={c.busy}
                  onChange={(e) => {
                    change();
                    setConnection(e.target.value);
                  }}
                >
                  <option value="">Choose a connection</option>
                  {c.connections().map((v) => (
                    <option key={v.id} value={v.id}>
                      Connection {v.id}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p>
                No active connection is saved. Review a connection in Private
                relay settings.
              </p>
            ))}
          <h5>Saved delivery history</h5>
          {items.length === 0 && (
            <p>No encrypted message copies are saved for this conversation.</p>
          )}
          {items.map((e) => (
            <article
              className="conversation-delivery-row"
              key={e.permissionId + e.id}
            >
              <h6>
                {e.direction === "incoming"
                  ? "Storage receipt"
                  : e.kind === "conversation.question"
                    ? "AI question"
                    : "Conversation message"}
              </h6>
              <p className="prose">
                Copy {e.id}
                <br />
                Browser {e.peerId}
              </p>
              <p>
                {e.locked
                  ? "Restored copy locked"
                  : e.relayStopped
                    ? "Further uploads stopped"
                    : e.state === "preparing"
                      ? "Preparation interrupted; review to finish"
                      : "Encrypted copy retained"}
                . Delivery deadline: {new Date(e.expiresAt).toLocaleString()}.
              </p>
              <p>
                {!e.relayAttempts
                  ? "No upload attempted."
                  : e.relayObservation?.attempt === e.relayAttempts
                    ? `Server storage confirmed for upload attempt ${e.relayAttempts}.`
                    : `Upload attempt ${e.relayAttempts} is unconfirmed. Refresh and review an explicit retry.`}
                {e.relayObservation &&
                  ` Last server report: ${e.relayObservation.receipt.state}.`}
              </p>
              <p>
                {e.direction === "incoming"
                  ? "This sends only a receipt for content already stored on this Mac."
                  : e.recipientAccepted
                    ? "Recipient storage confirmed. This does not confirm reading or task completion."
                    : "Recipient storage has not been confirmed. Server storage does not confirm reading or task completion."}
              </p>
              <div className="actions">
                {e.state === "preparing" && e.direction === "outgoing" && (
                  <button
                    disabled={
                      c.busy ||
                      e.locked ||
                      e.relayStopped ||
                      e.expiresAt <= Date.now()
                    }
                    onClick={() =>
                      void c.prepare(e.localMessageId, e.permissionId, e.id)
                    }
                  >
                    Review finishing encrypted copy
                  </button>
                )}
                <button
                  disabled={
                    c.busy ||
                    !c.status?.enabled ||
                    !connection ||
                    !c.connections().some((v) => v.id === connection) ||
                    e.locked ||
                    e.relayStopped ||
                    e.expiresAt <= Date.now() ||
                    (e.direction === "incoming"
                      ? !e.receiptPrepared
                      : e.state !== "ready")
                  }
                  onClick={() =>
                    void c.relay(e.id, e.permissionId, "send", connection)
                  }
                >
                  {e.direction === "incoming"
                    ? "Review storage receipt upload"
                    : "Review encrypted message upload"}
                </button>
                <button
                  disabled={c.busy || e.relayStopped}
                  onClick={() => void c.relay(e.id, e.permissionId, "stop")}
                >
                  Review stopping uploads
                </button>
              </div>
            </article>
          ))}
        </>
      )}
      {r && (
        <div
          className="conversation-delivery-review"
          role="group"
          aria-label="Conversation delivery review"
        >
          <h5>
            {r.action === "prepare" || r.action === "seal"
              ? "Review the encrypted copy"
              : r.action === "send"
                ? "Review the upload"
                : "Review stopping uploads"}
          </h5>
          {r.message && (
            <>
              <p>{r.question ? "Exact AI question" : "Exact saved message"}</p>
              <blockquote className="prose">
                {r.message.input.content}
              </blockquote>
            </>
          )}
          <p className="prose">
            Browser {r.peerId}
            <br />
            Verified fingerprint: {r.fingerprint}
          </p>
          {(r.entry || r.request) && (
            <p>
              Delivery deadline:{" "}
              {new Date(
                r.entry?.expiresAt ?? r.request!.expiresAt,
              ).toLocaleString()}
              .
            </p>
          )}
          <p>Review ends {new Date(r.expiresAt).toLocaleTimeString()}.</p>
          <p>
            {r.action === "prepare" || r.action === "seal"
              ? "This prepares an encrypted copy on this Mac. It does not upload the message."
              : r.action === "send"
                ? r.entry?.direction === "incoming"
                  ? "Upload the original encrypted storage receipt. This does not send a new message or run work."
                  : "Upload the original encrypted message through ai.bittrees.org to this paired browser. Server storage does not confirm recipient storage, reading or task completion."
                : "Stop future uploads of this retained copy on this Mac. Copies already sent remain; this does not revoke conversation access."}
          </p>
          <label className="conversation-choice">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            <span>I reviewed this copy, destination and action.</span>
          </label>
          <div className="actions">
            <button
              disabled={c.busy || !ack}
              onClick={() => void c.confirm(ack, available)}
            >
              {action}
            </button>
            <button disabled={c.busy} onClick={clear}>
              Discard delivery review
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
