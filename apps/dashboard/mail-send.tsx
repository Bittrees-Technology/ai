import React, { useEffect, useRef, useState } from "react";
import { MailSendController, type MailCompose } from "./mail-send-state.js";
import type { MailSendRecord } from "../../modules/storage/mail-sends.js";
type Envelope = MailSendRecord["envelope"];
function receiptLabel(r: MailSendRecord) {
  if (r.receipt)
    return {
      uncertain: "SMTP outcome uncertain",
      accepted: "Historically accepted by SMTP",
      partially_accepted: "Some recipients accepted by SMTP",
      rejected: "All recipients refused by SMTP",
    }[r.receipt.state];
  if (r.submittedAt || r.sourceSubmission === "reserved")
    return "Submission recorded; outcome unconfirmed";
  return r.reconciliationOnly
    ? "Restored record — status checks only"
    : "Prepared locally; no send recorded here";
}
function ExactMessage({
  m,
  download,
}: {
  m: Envelope;
  download: (value: Blob, name: string) => void;
}) {
  return (
    <section className="mail-exact-message" aria-label="Complete exact message">
      <dl>
        {(["from", "to", "cc", "bcc"] as const).map((key) => (
          <React.Fragment key={key}>
            <dt>{{ from: "From", to: "To", cc: "Cc", bcc: "Bcc" }[key]}</dt>
            <dd>
              {Array.isArray(m[key])
                ? (m[key] as string[]).length
                  ? (m[key] as string[]).map((v) => <div key={v}>{v}</div>)
                  : "None"
                : m[key]}
            </dd>
          </React.Fragment>
        ))}
        <dt>Subject</dt>
        <dd className="mail-exact-text">{m.subject || "(Empty subject)"}</dd>
      </dl>
      <h5>Exact message body</h5>
      <pre className="mail-exact-text">{m.text}</pre>
      <h5>Attachments ({m.attachments.length})</h5>
      {m.attachments.length ? (
        <ul>
          {m.attachments.map((f, i) => (
            <li key={i}>
              <span>{f.filename}</span> —{" "}
              {atob(f.content).length.toLocaleString()} bytes{" "}
              <button
                type="button"
                onClick={() =>
                  download(
                    new Blob(
                      [
                        Uint8Array.from(atob(f.content), (v) =>
                          v.charCodeAt(0),
                        ),
                      ],
                      { type: "application/octet-stream" },
                    ),
                    f.filename,
                  )
                }
              >
                Download exact file {i + 1}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>No attachments.</p>
      )}
      {m.attachments.length > 0 && (
        <p className="hint">
          Download and inspect each file before confirming. Files are copied as
          data; they are not opened here.
        </p>
      )}
      {m.reply ? (
        <details open>
          <summary>Original message reference</summary>
          <dl>
            <dt>Folder</dt>
            <dd>{m.reply.folder}</dd>
            <dt>Message</dt>
            <dd>{m.reply.id}</dd>
            <dt>Version reviewed</dt>
            <dd>{m.reply.version}</dd>
          </dl>
        </details>
      ) : (
        <p>New message; no original-message reference.</p>
      )}
    </section>
  );
}
export function MailSendPanel({
  api,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
}) {
  const [, render] = useState(0),
    mounted = useRef(true),
    urls = useRef(new Set<string>());
  const [c] = useState(
    () =>
      new MailSendController(api, () => {
        if (mounted.current) render((n) => n + 1);
      }),
  );
  const revoke = () => {
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current.clear();
  };
  useEffect(() => {
    mounted.current = true;
    void c.refresh();
    const hide = () => {
      c.hide();
      revoke();
    };
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", hide);
    const timer = setInterval(() => c.expire(), 1000);
    return () => {
      mounted.current = false;
      c.dispose();
      revoke();
      clearInterval(timer);
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [c]);
  const download = (blob: Blob, name: string) => {
    if (document.hidden || !document.hasFocus()) return;
    const url = URL.createObjectURL(blob);
    urls.current.add(url);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      urls.current.delete(url);
    }, 1000);
  };
  const json = (value: unknown, name: string) =>
    download(
      new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
      name,
    );
  const connection = c.status?.connection,
    record = c.record,
    review = c.review;
  const field = (
    key: Exclude<keyof MailCompose, "attachments" | "reply">,
    label: string,
    required = false,
    multi = false,
  ) => (
    <label className="mail-compose-field" key={key}>
      {label}
      {multi ? (
        <textarea
          aria-label={label}
          required={required}
          value={c.draft[key]}
          onChange={(e) => c.edit(key, e.target.value)}
          rows={key === "text" ? 9 : 2}
          maxLength={key === "text" ? 24000 : 5200}
        />
      ) : (
        <input
          aria-label={label}
          required={required}
          value={c.draft[key]}
          onChange={(e) => c.edit(key, e.target.value)}
          autoComplete="off"
          spellCheck={false}
          maxLength={key === "subject" ? 400 : 254}
        />
      )}
    </label>
  );
  return (
    <article
      className="card mail-send-panel"
      aria-label="Reviewed Mail sending"
    >
      <h3>Send a reviewed message</h3>
      <p>
        Write a message or paste a reply you have checked. Mail approval and a
        final confirmation here are both required. The local model cannot send
        mail.
      </p>
      <p className="hint">
        Source sending must be enabled by the Mail operator. Drafting access and
        sending permission are separate.
      </p>
      <div className="mail-actions">
        <button disabled={c.busy} onClick={() => void c.refresh()}>
          Refresh sending permission
        </button>
        <button
          disabled={c.busy || !c.status?.available}
          onClick={() => void c.loadHistory()}
        >
          Load saved Mail history
        </button>
        <a
          href="https://mail.bittrees.org/connect/ai-send"
          target="_blank"
          rel="noopener noreferrer"
        >
          Manage sending permission in Mail
        </a>
      </div>
      <div role="status" aria-live="polite">
        {c.busy ? "Working…" : c.notice}
      </div>
      {c.error && <p role="alert">{c.error}</p>}
      {!c.status ? (
        <p>Sending permission has not loaded.</p>
      ) : !c.status.available ? (
        <p>This build does not include reviewed Mail sending.</p>
      ) : (
        <>
          {connection && (
            <section aria-label="Current sending permission">
              <h4>Current sending permission</h4>
              <p>
                {connection.state === "stored"
                  ? "Permission saved for one exact message."
                  : connection.state === "expired"
                    ? "Permission expired. Obtain fresh approval for the same message to check its status."
                    : "Disconnect is pending. Sending and status checks are paused."}
              </p>
              <p>
                Mailbox: {connection.mailbox}. Expires{" "}
                {new Date(connection.expiresAt).toLocaleString()}.
              </p>
              <p>
                Mail sign-in wallet:{" "}
                <span className="mail-operation">{connection.wallet}</span>
              </p>
              <button
                disabled={c.busy}
                onClick={() => void c.load(connection.operationId)}
              >
                Load permitted message
              </button>
              <button disabled={c.busy} onClick={() => void c.disconnect()}>
                {connection.state === "disconnect_pending"
                  ? "Retry sending disconnect"
                  : "Disconnect sending permission"}
              </button>
              <p className="hint">
                Disconnect revokes Mail permission. It cannot recall mail
                already dispatched. Disconnect or forget this permission before
                preparing a different message.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={c.forgetConfirmed}
                  disabled={c.busy}
                  onChange={(e) => c.setForget(e.target.checked)}
                />
                I understand forgetting here does not revoke Mail permission or
                cancel source work.
              </label>
              <button
                disabled={c.busy || !c.forgetConfirmed}
                onClick={() => void c.forget()}
              >
                Forget local sending permission
              </button>
            </section>
          )}
          {!connection && !c.pending && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void c.prepare();
              }}
              aria-label="Compose reviewed Mail"
            >
              <h4>Prepare a message</h4>
              <p>
                Use the wallet you sign into Mail with and its assigned mailbox.
                Mail verifies both before granting permission.
              </p>
              <fieldset disabled={c.busy}>
                <legend>Sender and recipients</legend>
                {field("wallet", "Mail sign-in wallet", true)}
                {field("from", "From mailbox", true)}
                <p className="hint">
                  Enter email addresses separated by commas or new lines. At
                  least one To, Cc or Bcc recipient is required; up to 20 in
                  total.
                </p>
                {field("to", "To recipients", false, true)}
                {field("cc", "Cc recipients", false, true)}
                {field("bcc", "Bcc recipients", false, true)}
              </fieldset>
              <fieldset disabled={c.busy}>
                <legend>Message and files</legend>
                {field("subject", "Subject")}
                {field("text", "Message body", true, true)}
                <label>
                  Choose attachments
                  <input
                    aria-label="Choose attachments"
                    type="file"
                    multiple
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? []);
                      e.target.value = "";
                      void c.files(files);
                    }}
                  />
                </label>
                <p className="hint">
                  Up to four files, one MiB combined. Files are attached as
                  data. HTML bodies are not supported. Subjects allow 200
                  characters; message bodies allow 24 KB of plain text.
                </p>
                {c.draft.attachments.map((f, i) => (
                  <p key={i}>
                    {f.filename} — {atob(f.content).length.toLocaleString()}{" "}
                    bytes{" "}
                    <button
                      type="button"
                      onClick={() =>
                        c.edit(
                          "attachments",
                          c.draft.attachments.filter((_, n) => n !== i),
                        )
                      }
                    >
                      Remove file {i + 1}
                    </button>
                  </p>
                ))}
                <details>
                  <summary>Reply reference, if supplied by Mail</summary>
                  <p>
                    Only add an original-message reference obtained from Mail.
                    Mail checks that exact version before sending.
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={!!c.draft.reply}
                      onChange={(e) =>
                        c.edit(
                          "reply",
                          e.target.checked
                            ? { folder: "INBOX", id: "", version: "" }
                            : null,
                        )
                      }
                    />
                    Include an original-message reference
                  </label>
                  {c.draft.reply &&
                    (["folder", "id", "version"] as const).map((key) => (
                      <label key={key}>
                        {
                          {
                            folder: "Original folder",
                            id: "Original message identifier",
                            version: "Original message version",
                          }[key]
                        }
                        <input
                          required
                          value={c.draft.reply![key]}
                          maxLength={64}
                          onChange={(e) =>
                            c.edit("reply", {
                              ...c.draft.reply!,
                              [key]: e.target.value,
                            })
                          }
                        />
                      </label>
                    ))}
                </details>
              </fieldset>
              <div className="mail-actions">
                <button disabled={c.busy || !c.draft.text.trim()}>
                  Save message for Mail approval
                </button>
                <button
                  type="button"
                  disabled={c.busy}
                  onClick={() => c.clearDraft()}
                >
                  Clear unsaved message
                </button>
              </div>
              <p className="hint">
                Saving creates an encrypted local record and does not send.
                Unsaved text remains in this form until you clear it or leave
                Connections.
              </p>
            </form>
          )}
          {c.pending && (
            <section aria-label="Approve exact message in Mail">
              <h4>Approve in Mail</h4>
              <p>
                Download this message’s review file and import it on the Mail
                approval page. Return with its one-time code. The file includes
                private message and attachment content; delete exported copies
                when you no longer need them.
              </p>
              {c.file ? (
                <>
                  <ExactMessage m={c.file.envelope} download={download} />
                  <button
                    disabled={c.busy}
                    onClick={() => json(c.file, "bittrees-mail-review.json")}
                  >
                    Download Mail approval file
                  </button>
                </>
              ) : (
                <p>
                  The private review preview was cleared. If you already
                  downloaded its file, continue with that file and paste the
                  returned code below.
                </p>
              )}
              <p>
                <a
                  href="https://mail.bittrees.org/connect/ai-send"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open Mail approval
                </a>
              </p>
              <p>
                Local approval attempt expires{" "}
                {new Date(c.pending.expiresAt).toLocaleString()}. Paste the code
                within 60 seconds of Mail approval.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void c.finish();
                }}
              >
                <label>
                  One-time sending approval code
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={64}
                    value={c.code}
                    disabled={c.busy}
                    onChange={(e) => c.setCode(e.target.value)}
                  />
                </label>
                <button
                  disabled={c.busy || !/^[a-f0-9]{64}$/.test(c.code.trim())}
                >
                  Save sending permission
                </button>
              </form>
              <button
                disabled={c.busy}
                onClick={() => void c.reconnect(c.pending!.operationId)}
              >
                Create replacement approval file
              </button>
              <p className="hint">
                A replacement file requires new approval in Mail. Earlier codes
                cannot be used with it.
              </p>
            </section>
          )}
          {c.history && (
            <section aria-label="Saved Mail history">
              <h4>Saved Mail history</h4>
              <p>
                Local records remain until you delete them. Reading or
                reapproving a record does not resend it.
              </p>
              {!c.history.items.length ? (
                <p>No saved Mail messages.</p>
              ) : (
                <ul className="mail-history">
                  {c.history.items.map((r) => (
                    <li key={r.operationId}>
                      <strong>{r.subject || "(Empty subject)"}</strong>
                      <span>
                        {r.identity.mailbox} ·{" "}
                        {new Date(r.recordedAt).toLocaleString()}
                      </span>
                      <span>
                        {r.receipt
                          ? {
                              uncertain: "SMTP outcome uncertain",
                              accepted: "SMTP acceptance recorded",
                              partially_accepted:
                                "Partial SMTP acceptance recorded",
                              rejected: "SMTP refusal recorded",
                            }[r.receipt.state]
                          : r.submittedAt || r.sourceSubmission === "reserved"
                            ? "Submission recorded; outcome unconfirmed"
                            : r.reconciliationOnly
                              ? "Restored: status checks only"
                              : "Prepared locally"}
                      </span>
                      <button
                        disabled={c.busy}
                        onClick={() => void c.load(r.operationId)}
                      >
                        Open saved message
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {record && (
            <section
              className="mail-saved-record"
              aria-label="Saved exact Mail message"
            >
              <h4>{review ? "Final send review" : "Saved message"}</h4>
              <p>
                <strong>
                  {c.unconfirmed()
                    ? "Local confirmation attempted; outcome unconfirmed"
                    : receiptLabel(record)}
                </strong>
              </p>
              {record.reconciliationOnly && (
                <p>
                  Restored history cannot authorize a send. The message may have
                  been sent after its backup. Use status checks only.
                </p>
              )}
              <ExactMessage
                m={review?.envelope ?? record.envelope}
                download={download}
              />
              <p className="hint">
                Operation:{" "}
                <span className="mail-operation">
                  {record.envelope.operationId}
                </span>
              </p>
              {record.receipt && (
                <section aria-label="Historical Mail receipt">
                  <h5>Historical SMTP receipt</h5>
                  <p>
                    Delivery is unverified. This is a historical observation,
                    not a guarantee that a recipient received the message.
                  </p>
                  <dl>
                    <dt>Recorded</dt>
                    <dd>
                      {new Date(record.receipt.recordedAt).toLocaleString()}
                    </dd>
                    <dt>Completed</dt>
                    <dd>
                      {record.receipt.completedAt
                        ? new Date(record.receipt.completedAt).toLocaleString()
                        : "Unknown"}
                    </dd>
                    <dt>Sent-folder copy</dt>
                    <dd>{record.receipt.sentCopy.replace("_", " ")}</dd>
                  </dl>
                  <ul>
                    {[
                      ...record.envelope.to,
                      ...record.envelope.cc,
                      ...record.envelope.bcc,
                    ].map((address, i) => (
                      <li key={i}>
                        {address}:{" "}
                        {record.receipt!.accepted.includes(i)
                          ? "accepted by SMTP"
                          : record.receipt!.refused.includes(i)
                            ? "refused by SMTP"
                            : "unconfirmed"}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {review ? (
                <>
                  <p>
                    Confirm every recipient, including Cc and Bcc, the exact
                    text and every file above. Review expires{" "}
                    {new Date(review.expiresAt).toLocaleString()}.
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={c.confirmed}
                      disabled={c.busy}
                      onChange={(e) => c.setConfirmed(e.target.checked)}
                    />
                    I reviewed this exact message and authorize one send
                    request.
                  </label>
                  <button
                    disabled={c.busy || !c.confirmed}
                    onClick={() => void c.confirm()}
                  >
                    Send this exact message once
                  </button>
                  <button disabled={c.busy} onClick={() => c.hide()}>
                    Cancel final review
                  </button>
                </>
              ) : c.canSend() ? (
                <button disabled={c.busy} onClick={() => void c.reviewSend()}>
                  Review final send
                </button>
              ) : (
                <p className="hint">
                  A new send is not available for this record with the current
                  permission. Keep uncertain records and check their status; do
                  not create a replacement to retry.
                </p>
              )}
              <div className="mail-actions">
                <button
                  disabled={
                    c.busy ||
                    connection?.operationId !== record.envelope.operationId ||
                    connection.state !== "stored"
                  }
                  onClick={() => void c.reconcile()}
                >
                  Check status without resending
                </button>
                <button
                  disabled={
                    c.busy ||
                    (!!connection &&
                      connection.operationId !== record.envelope.operationId) ||
                    connection?.state === "disconnect_pending"
                  }
                  onClick={() => void c.reconnect(record.envelope.operationId)}
                >
                  Prepare approval for this saved message
                </button>
                <button
                  disabled={c.busy}
                  onClick={() => json(record, "bittrees-mail-record.json")}
                >
                  Export this saved message
                </button>
              </div>
              <details>
                <summary>Delete local tracking</summary>
                <p>
                  Deletion removes the local message, tracking and matching
                  local permission. It cannot recall mail, cancel queued work,
                  revoke Mail permission or erase exported files and backups.
                </p>
                <label>
                  <input
                    type="checkbox"
                    checked={c.deleteConfirmed}
                    disabled={c.busy}
                    onChange={(e) => c.setDelete(e.target.checked)}
                  />
                  I understand deleting tracking does not cancel or unsend this
                  message.
                </label>
                <button
                  disabled={c.busy || !c.deleteConfirmed}
                  onClick={() => void c.remove()}
                >
                  Delete this local Mail record
                </button>
              </details>
            </section>
          )}
        </>
      )}
    </article>
  );
}
