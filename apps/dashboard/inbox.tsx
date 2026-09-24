import { InboxMessageController } from "./inbox-message-state.js";
import { InboxConversationController } from "./inbox-conversation-state.js";
import { InboxTaskMessage } from "./inbox-task-message.js";
import React, { useState, useEffect, useRef } from "react";
type Api = (
  path: string,
  method?: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<any>;
export function Inbox({
  api,
  onError,
}: {
  api: Api;
  onError: (error: unknown) => void;
}) {
  const [inboxes, setInboxes] = useState<{ id: string; ownerType: string }[]>(
      [],
    ),
    [inbox, setInbox] = useState(""),
    [conversation, setConversation] = useState("");
  const [content, setContent] = useState(""),
    [reply, setReply] = useState(""),
    [expected, setExpected] = useState(false),
    [due, setDue] = useState(""),
    [busy, setBusy] = useState(false);
  const [, renderConversations] = useState(0);
  const [conversationPages] = useState(
    () =>
      new InboxConversationController(api, () =>
        renderConversations((v) => v + 1),
      ),
  );
  const [, renderMessages] = useState(0);
  const [messagePages] = useState(
    () => new InboxMessageController(api, () => renderMessages((v) => v + 1)),
  );
  const { messages, checkins, more } = messagePages;
  const pending = useRef<{ fingerprint: string; key: string } | null>(null);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  async function loadInboxes() {
    const data = await api("/v1/inboxes");
    setInboxes(data.items);
    setInbox((old) => old || data.items[0]?.id || "");
  }
  useEffect(() => {
    void loadInboxes().catch(onError);
  }, []);
  useEffect(() => {
    void conversationPages.refresh(inbox).catch(onError);
    return () => conversationPages.clear();
  }, [inbox]);
  useEffect(() => {
    messagePages.select(inbox, conversation);
    setReply("");
    const poll = () => void messagePages.load().catch(onError);
    poll();
    const timer = setInterval(poll, 3000);
    return () => {
      clearInterval(timer);
      messagePages.select();
    };
  }, [inbox, conversation]);
  const select = (id: string) => {
    if (content && !confirm("Discard this unsaved message?")) return;
    setContent("");
    setDue("");
    setExpected(false);
    setReply("");
    pending.current = null;
    setConversation(id);
  };
  return (
    <div className="workspace">
      <section className="queue">
        <h2>Your personal inbox</h2>
        <p className="hint">
          Messages are saved on this Mac. Ordinary replies do not start work.
          Use the separate task-answer review to answer a waiting task.
        </p>
        {!inboxes.length ? (
          <button
            disabled={busy}
            onClick={() =>
              action(async () => {
                await api("/v1/inboxes/personal", "POST", {});
                await loadInboxes();
              })
            }
          >
            Create personal inbox
          </button>
        ) : (
          <>
            <label>
              Inbox
              <select
                value={inbox}
                disabled={busy}
                onChange={(e) => {
                  if (content && !confirm("Discard this unsaved message?"))
                    return;
                  setContent("");
                  setConversation("");
                  setInbox(e.target.value);
                }}
              >
                {inboxes.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.id} ({i.ownerType})
                  </option>
                ))}
              </select>
            </label>
            <button disabled={busy} onClick={() => select(crypto.randomUUID())}>
              New conversation
            </button>
            <h3>Recent conversations</h3>
            <div className="tasklist">
              {conversationPages.items.map((c) => (
                <button
                  className={c.id === conversation ? "chosen" : ""}
                  key={c.id}
                  disabled={busy}
                  onClick={() => select(c.id)}
                >
                  {c.preview}
                </button>
              ))}
            </div>
            <button
              disabled={conversationPages.busy}
              onClick={() =>
                void conversationPages.refresh(inbox).catch(onError)
              }
            >
              Refresh conversations
            </button>
            {conversationPages.nextCursor && (
              <button
                disabled={conversationPages.busy}
                onClick={() => void conversationPages.more().catch(onError)}
              >
                Load earlier conversations
              </button>
            )}
            <p className="hint">
              Conversations are shown newest first, in pages of 100. Refresh to
              include new messages.
            </p>
          </>
        )}
      </section>
      <section className="detail">
        {conversation ? (
          <>
            <h2>Conversation</h2>
            {!messages.length && (
              <p className="hint">Write the first message below.</p>
            )}
            {messages.map((m) => (
              <article className="memory" key={m.id}>
                <div className="status">
                  {m.input.replyToId ? "Reply" : "Message"} ·{" "}
                  {new Date(m.createdAt).toLocaleString()}
                </div>
                {m.input.requestId ? (
                  <InboxTaskMessage message={m} api={api} />
                ) : (
                  <p className="prose">{m.input.content}</p>
                )}
                {m.input.replyExpected && (
                  <p className="hint">
                    Reply expected
                    {m.input.replyDueAt
                      ? " by " + new Date(m.input.replyDueAt).toLocaleString()
                      : ""}
                    {checkins.find((c) => c.message_id === m.id)
                      ? " · " +
                        checkins.find((c) => c.message_id === m.id)!.status
                      : ""}
                  </p>
                )}
                <p className="hint">
                  {m.receipts.map((r) => r.kind).join(", ") ||
                    "No receipt recorded"}
                </p>
                <div className="actions">
                  <button
                    disabled={busy}
                    onClick={() => {
                      setReply(m.id);
                      document.getElementById("inbox-message")?.focus();
                    }}
                  >
                    Reply
                  </button>
                  {["read", "acknowledged"].map((kind) => (
                    <button
                      key={kind}
                      disabled={busy || m.receipts.some((r) => r.kind === kind)}
                      onClick={() =>
                        action(async () => {
                          await api(
                            "/v1/messages/" + m.id + "/receipts",
                            "POST",
                            { kind },
                          );
                          messagePages.receipt(m.id, kind);
                        })
                      }
                    >
                      {kind === "read" ? "Mark read" : "Acknowledge"}
                    </button>
                  ))}
                </div>
              </article>
            ))}
            {more && (
              <button
                disabled={busy || messagePages.busy}
                onClick={() => void messagePages.load(true).catch(onError)}
              >
                Load later messages
              </button>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  const body = {
                    conversationId: conversation,
                    recipientInboxId: inbox,
                    type: reply ? "reply" : "notification",
                    content,
                    replyExpected: expected,
                    ...(reply ? { replyToId: reply } : {}),
                    ...(expected && due
                      ? { replyDueAt: new Date(due).toISOString() }
                      : {}),
                  };
                  const fingerprint = JSON.stringify(body);
                  if (pending.current?.fingerprint !== fingerprint)
                    pending.current = { fingerprint, key: crypto.randomUUID() };
                  const saved = await api("/v1/messages", "POST", body, {
                    "Idempotency-Key": pending.current.key,
                  });
                  pending.current = null;
                  messagePages.saved(saved);
                  setContent("");
                  setReply("");
                  setDue("");
                  setExpected(false);
                });
              }}
            >
              <h3>{reply ? "Write a reply" : "Write a message"}</h3>
              {reply && (
                <button type="button" onClick={() => setReply("")}>
                  Cancel reply
                </button>
              )}
              <label>
                Message
                <textarea
                  id="inbox-message"
                  required
                  maxLength={32000}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={expected}
                  onChange={(e) => setExpected(e.target.checked)}
                />
                Expect a reply
              </label>
              {expected && (
                <label>
                  Reply due (optional)
                  <input
                    type="datetime-local"
                    value={due}
                    onChange={(e) => setDue(e.target.value)}
                  />
                </label>
              )}
              <button className="primary" disabled={busy}>
                Save {reply ? "reply" : "message"}
              </button>
              <p className="hint">
                Reading or acknowledging does not finish a task. A saved reply
                closes the related check-in.
              </p>
            </form>
          </>
        ) : (
          <div className="empty">
            <h2>Keep the conversation together.</h2>
            <p>Open a conversation or start a new one.</p>
          </div>
        )}
      </section>
    </div>
  );
}
