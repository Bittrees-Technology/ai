import React, { useEffect, useMemo, useState } from "react";
import {
  ConversationPermissionPanelState,
  emptyConversationForm,
  type ConversationDirections,
  type ConversationChoices,
  type ConversationForm,
} from "./conversation-permission-state.js";
const directions: [keyof ConversationDirections, string][] = [
  ["messagesToMac", "Messages from this browser to the Mac"],
  ["messagesToBrowser", "Messages from the Mac to this browser"],
  ["questionsToBrowser", "Task questions from the Mac to this browser"],
  ["answersToMac", "Reviewed answers from this browser to the Mac"],
];
function Choices({ choices }: { choices: ConversationChoices }) {
  return (
    <ul>
      {directions.map(([key, label]) => (
        <li key={key}>
          {label}:{" "}
          <strong>{choices.permissions[key] ? "Allowed" : "Off"}</strong>
        </li>
      ))}
    </ul>
  );
}
export function ConversationPermissions({
  api,
  inboxId,
  conversationId,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
  inboxId: string;
  conversationId: string;
}) {
  const [, render] = useState(0);
  const c = useMemo(
    () =>
      new ConversationPermissionPanelState(
        api,
        { inboxId, conversationId },
        () => render((v) => v + 1),
      ),
    [api, inboxId, conversationId],
  );
  const [form, setForm] = useState(emptyConversationForm),
    [ack, setAck] = useState(false);
  const available = () => document.hasFocus() && !document.hidden;
  const clear = () => {
    c.hide();
    setAck(false);
    setForm(emptyConversationForm());
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
      window.removeEventListener("blur", clear);
      window.removeEventListener("keydown", escape);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [c]);
  useEffect(() => {
    setAck(false);
  }, [c.review?.id]);
  const change = (patch: Partial<ConversationForm>) => {
    c.invalidateReview();
    setAck(false);
    setForm((v) => ({ ...v, ...patch }));
  };
  const status = c.status,
    review = c.review;
  const ready =
    status?.available &&
    status.canSetup &&
    status.hasSelectedKey &&
    !status.needsFreshPairing &&
    status.peers.length > 0;
  const valid =
    form.peerId &&
    (form.permissions.messagesToMac ||
      form.permissions.messagesToBrowser ||
      form.permissions.questionsToBrowser) &&
    (!form.permissions.answersToMac || form.permissions.questionsToBrowser);
  const grants =
    status?.grants.filter(
      (g) =>
        g.choices.inboxId === inboxId &&
        g.choices.conversationId === conversationId,
    ) ?? [];
  return (
    <section
      className="conversation-permissions"
      aria-label="Conversation sharing permissions"
    >
      <h3>Share this conversation</h3>
      <p>
        Choose what one paired browser may exchange with this conversation.
        Task, app and publishing permissions stay separate.
      </p>
      <p className="hint">
        Conversation delivery is still being prepared in this development build.
        Saving choices does not send messages.
      </p>
      <button
        disabled={c.busy}
        onClick={() => {
          setAck(false);
          setForm(emptyConversationForm());
          void c.refresh();
        }}
      >
        Refresh conversation choices
      </button>
      {c.error && <p role="alert">{c.error}</p>}
      {c.notice && <p role="status">{c.notice}</p>}
      {status && !ready && (
        <p className="hint">
          To review new access, enable private setup and verify this Mac and the
          paired browser in Device. Saved access can still be revoked.
        </p>
      )}
      {!review && status && (
        <>
          {grants.map((g) => (
            <article key={g.id}>
              <h4>
                {g.state === "revoked"
                  ? "Revoked locally"
                  : g.state === "expired"
                    ? "Expired"
                    : g.state === "needs-review"
                      ? "Fresh review required"
                      : "Choices saved; connection not checked"}
              </h4>
              <p className="prose">Browser {g.choices.peerId}</p>
              <Choices choices={g.choices} />
              <p>Expires {new Date(g.choices.expiresAt).toLocaleString()}</p>
              {g.state !== "revoked" && (
                <button
                  disabled={c.busy}
                  onClick={() => {
                    setAck(false);
                    void c.revoke(g.id);
                  }}
                >
                  Review revoking conversation access
                </button>
              )}
            </article>
          ))}
          {ready && (
            <fieldset disabled={c.busy}>
              <legend>New conversation access</legend>
              <label>
                Paired browser
                <select
                  value={form.peerId}
                  onChange={(e) => change({ peerId: e.target.value })}
                >
                  <option value="">Choose a verified browser</option>
                  {status.peers.map((p) => (
                    <option key={p.peerId} value={p.peerId}>
                      {p.peerId}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Access duration
                <select
                  value={form.minutes}
                  onChange={(e) =>
                    change({ minutes: Number(e.target.value) as 15 | 60 })
                  }
                >
                  <option value={15}>15 minutes</option>
                  <option value={60}>1 hour</option>
                </select>
              </label>
              {directions.map(([key, label]) => (
                <label className="conversation-choice" key={key}>
                  <input
                    type="checkbox"
                    checked={form.permissions[key]}
                    onChange={(e) =>
                      change({
                        permissions: {
                          ...form.permissions,
                          [key]: e.target.checked,
                          ...(key === "questionsToBrowser" && !e.target.checked
                            ? { answersToMac: false }
                            : {}),
                        },
                      })
                    }
                    disabled={
                      key === "answersToMac" &&
                      !form.permissions.questionsToBrowser
                    }
                  />
                  <span>{label}</span>
                </label>
              ))}
              <button
                disabled={!valid}
                onClick={() => {
                  setAck(false);
                  void c.prepare(form);
                }}
              >
                Review conversation access
              </button>
            </fieldset>
          )}
        </>
      )}
      {review && (
        <div className="conversation-permission-review">
          <h4>
            {review.action === "grant"
              ? "Review conversation access"
              : "Revoke conversation access"}
          </h4>
          <p>
            Applies only to this conversation in Inbox {review.choices.inboxId}.
          </p>
          <p className="prose">
            Conversation {review.choices.conversationId}
            <br />
            Browser {review.peerId}
          </p>
          <p className="prose">
            Verified browser fingerprint: {review.fingerprint}
          </p>
          <Choices choices={review.choices} />
          <p>
            Access ends {new Date(review.choices.expiresAt).toLocaleString()}.
            Review ends {new Date(review.expiresAt).toLocaleString()}.
          </p>
          {review.action === "revoke" && (
            <p>
              Revoking stops future access on this Mac. Existing messages and
              copies already shared remain.
            </p>
          )}
          <label className="conversation-choice">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            <span>I reviewed this conversation, browser and access.</span>
          </label>
          <div className="actions">
            <button
              disabled={c.busy || !ack}
              onClick={() => void c.confirm(ack, available)}
            >
              {review.action === "grant"
                ? "Save conversation access"
                : "Revoke conversation access"}
            </button>
            <button disabled={c.busy} onClick={clear}>
              Discard conversation review
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
