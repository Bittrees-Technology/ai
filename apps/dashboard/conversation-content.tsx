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
    [connection, setConnection] = useState(""),
    [incomingPermission, setIncomingPermission] = useState(""),
    [receiptCopy, setReceiptCopy] = useState("");
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
    setIncomingPermission("");
    setReceiptCopy("");
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
    r?.action === "receipt"
      ? "Prepare storage receipt"
      : r?.action === "prepare" || r?.action === "seal"
        ? "Prepare encrypted copy"
        : r?.action === "send"
          ? r.entry?.direction === "incoming"
            ? "Upload storage receipt"
            : "Upload encrypted copy"
          : r?.action === "receive"
            ? "Receive reviewed item"
            : r?.action === "reconcile"
              ? "Check reviewed browser receipt"
              : "Stop further uploads";
  return (
    <section
      className="conversation-content"
      aria-label="Conversation message delivery"
    >
      <h4>Conversation delivery</h4>
      <p>
        Prepare one saved message or waiting AI question for your paired
        browser, or receive a selected incoming item. Uploading is a separate
        choice.
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
                      Browser {g.choices.peerId.slice(0, 8)} /{" "}
                      {g.id.slice(0, 6)}
                    </option>
                  ))}
                </select>
              </label>
              {grants.find((g) => g.id === permission) && (
                <p className="prose">
                  Selected browser:{" "}
                  {grants.find((g) => g.id === permission)!.choices.peerId}
                  <br />
                  Saved access: {permission}
                </p>
              )}
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
                    c.clearIncoming();
                    setConnection(e.target.value);
                  }}
                >
                  <option value="">Choose a connection</option>
                  {c.connections().map((v) => (
                    <option key={v.id} value={v.id}>
                      Connection {v.id.slice(0, 8)}
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
          {c.connections().some((v) => v.id === connection) && (
            <p className="prose">Selected connection: {connection}</p>
          )}
          <fieldset disabled={c.busy}>
            <legend>Incoming conversation items</legend>
            <p>
              Inspect one queued item, then review receiving it or checking a
              browser storage receipt. Inspection does not reveal or save its
              content.
            </p>
            <div className="actions">
              <button
                disabled={
                  !connection ||
                  !c.status.enabled ||
                  !c.connections().some((v) => v.id === connection)
                }
                onClick={() => void c.inspectIncoming(connection)}
              >
                Inspect incoming conversation
              </button>
              <button
                disabled={
                  !c.queue?.item || c.queue.connection.id !== connection
                }
                onClick={() => void c.inspectIncoming(connection, true)}
              >
                Inspect next conversation item
              </button>
            </div>
            {c.queue &&
              (c.queue.item ? (
                <>
                  <p className="prose">
                    Queued item {c.queue.item.selection.messageId}
                    <br />
                    Delivery window ends{" "}
                    {new Date(c.queue.item.expiresAt).toLocaleString()}.
                  </p>
                  <label>
                    Incoming browser access
                    <select
                      aria-label="Incoming browser access"
                      value={incomingPermission}
                      onChange={(e) => {
                        change();
                        setIncomingPermission(e.target.value);
                        setReceiptCopy("");
                      }}
                    >
                      <option value="">Choose saved browser access</option>
                      {grants.map((g) => (
                        <option key={g.id} value={g.id}>
                          Browser {g.choices.peerId.slice(0, 8)} /{" "}
                          {g.id.slice(0, 6)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p>
                    Choose the access for this conversation. An authenticated
                    answer may resume its exact waiting task; an ordinary
                    message does not answer a question.
                  </p>
                  <button
                    disabled={
                      !incomingPermission ||
                      !grants.some(
                        (g) =>
                          g.id === incomingPermission &&
                          (g.choices.permissions.messagesToMac ||
                            g.choices.permissions.answersToMac),
                      )
                    }
                    onClick={() => void c.reviewIncoming(incomingPermission)}
                  >
                    Review receiving conversation item
                  </button>
                  <label>
                    Sent copy for browser receipt
                    <select
                      aria-label="Sent copy for browser receipt"
                      value={receiptCopy}
                      onChange={(e) => {
                        change();
                        setReceiptCopy(e.target.value);
                      }}
                    >
                      <option value="">Choose the exact sent copy</option>
                      {items
                        .filter(
                          (e) =>
                            e.permissionId === incomingPermission &&
                            e.direction === "outgoing" &&
                            e.state === "ready" &&
                            !e.locked,
                        )
                        .map((e, i) => (
                          <option key={e.id} value={e.id}>
                            Copy {i + 1} / {e.id.slice(0, 8)}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button
                    disabled={!incomingPermission || !receiptCopy}
                    onClick={() =>
                      void c.reviewIncoming(incomingPermission, receiptCopy)
                    }
                  >
                    Review browser storage receipt
                  </button>
                </>
              ) : (
                <p>No queued item at this position.</p>
              ))}
          </fieldset>
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
                {e.direction === "incoming" && !e.receiptPrepared && (
                  <button
                    disabled={
                      c.busy ||
                      !c.status?.enabled ||
                      e.locked ||
                      e.relayStopped ||
                      e.expiresAt <= Date.now()
                    }
                    onClick={() => void c.prepareReceipt(e.id, e.permissionId)}
                  >
                    Review preparing storage receipt
                  </button>
                )}
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
            {r.action === "receipt"
              ? "Review preparing this storage receipt"
              : r.action === "prepare" || r.action === "seal"
                ? "Review the encrypted copy"
                : r.action === "send"
                  ? "Review the upload"
                  : r.action === "receive"
                    ? "Review receiving this conversation item"
                    : r.action === "reconcile"
                      ? "Review this browser storage receipt"
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
            {r.entry?.direction === "incoming"
              ? "Storage receipt for copy"
              : r.question || r.entry?.kind === "conversation.question"
                ? "AI question copy"
                : "Message copy"}
            : {r.entry?.id ?? r.request?.id ?? "Selected incoming item"}
            {r.connectionId && (
              <>
                <br />
                Selected connection: {r.connectionId}
              </>
            )}
          </p>
          {r.queue?.item && (
            <p className="prose">
              Conversation {conversationId}
              <br />
              Queued item {r.queue.item.selection.messageId}
              <br />
              Envelope fingerprint: {r.queue.item.selection.envelopeHash}
              <br />
              {r.entry && (
                <>
                  Sent copy revision: {r.entry.revision}
                  <br />
                </>
              )}
              The sender and contents will be authenticated when you confirm
              this action.
            </p>
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
            {r.action === "receipt"
              ? "Prepare an encrypted receipt for the content already stored on this Mac. This does not upload the receipt or send a new message."
              : r.action === "prepare" || r.action === "seal"
                ? "This prepares an encrypted copy on this Mac. It does not upload the message."
                : r.action === "send"
                  ? r.entry?.direction === "incoming"
                    ? "Upload the original encrypted storage receipt. This does not send a new message or run work."
                    : "Upload the original encrypted message through ai.bittrees.org to this paired browser. Server storage does not confirm recipient storage, reading or task completion."
                  : r.action === "receive"
                    ? "Receive only this selected encrypted item under the chosen browser access. A valid answer can resume its exact waiting task; ordinary messages cannot. Content is saved before acknowledging transport. Uploading a storage receipt is a separate choice."
                    : r.action === "reconcile"
                      ? "Authenticate the queued item as a storage receipt for this exact sent copy. A mismatch remains queued. This does not send content or confirm reading or task completion."
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
