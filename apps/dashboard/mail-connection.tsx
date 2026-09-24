import { QuestionChoice } from "./question-choice.js";
import { profileLabel } from "./model-profile-settings.js";
import React, { useEffect, useRef, useState } from "react";
type Api = (
  path: string,
  method?: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<any>;
export function MailConnection({
  api,
  onError,
  profiles,
  onCreated,
}: {
  api: Api;
  onError: (e: unknown) => void;
  profiles: { id: string; model: string }[];
  onCreated: (id: string) => void;
}) {
  const base = "/v1/connections/mail";
  const [status, setStatus] = useState<any>(null),
    [pending, setPending] = useState<any>(null),
    [selection, setSelection] = useState<any>(null),
    [code, setCode] = useState(""),
    [busy, setBusy] = useState(false),
    [remove, setRemove] = useState(false),
    [plain, setPlain] = useState(false),
    [attachment, setAttachment] = useState(false),
    [kind, setKind] = useState<"summarize" | "draft">("summarize"),
    [profile, setProfile] = useState(profiles[0]?.id ?? ""),
    [allowQuestions, setAllowQuestions] = useState(false),
    [prompt, setPrompt] = useState(
      "Summarize the selected message. Cite the source and identify uncertainty.",
    );
  const mounted = useRef(true),
    epoch = useRef(0),
    working = useRef(false),
    attempt = useRef<{
      fingerprint: string;
      key: string;
      conversationId: string;
    } | null>(null);
  function clear() {
    epoch.current++;
    setSelection(null);
    setPlain(false);
    setAttachment(false);
    setKind("summarize");
    setCode("");
    setRemove(false);
  }
  async function refresh() {
    clear();
    const next = await api(base);
    if (mounted.current) setStatus(next);
  }
  async function act(fn: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      clear();
      onError(e);
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void act(refresh);
    const hide = () => clear();
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", hide);
    return () => {
      mounted.current = false;
      epoch.current++;
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", hide);
    };
  }, []);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(
      () => {
        setPending(null);
        setCode("");
      },
      Math.max(0, Date.parse(pending.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [pending]);
  useEffect(() => {
    if (!selection) return;
    const timer = setTimeout(
      clear,
      Math.max(0, Date.parse(selection.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [selection]);
  return (
    <article className="card">
      <h3>Mail</h3>
      <p>
        Choose one message in Mail. Summaries and suggested replies stay on this
        Mac. Creating a draft does not send or save it into your mailbox.
      </p>
      <button disabled={busy} onClick={() => void act(refresh)}>
        Refresh Mail connection
      </button>
      {!status ? (
        <p role="status">
          Connection status unavailable or loading. Refresh to try again.
        </p>
      ) : !status.available ? (
        <p>Mail adapter unavailable in this build.</p>
      ) : status.connection ? (
        <>
          <p>
            {status.connection.state === "stored"
              ? "Credential saved on this Mac. Access is checked on every read."
              : status.connection.state === "disconnect_pending"
                ? "Disconnect pending. Reads are paused; retry to confirm revocation."
                : "Credential expired. Disconnect and review a new selection in Mail."}
          </p>
          <p>
            Expires {new Date(status.connection.expiresAt).toLocaleString()}.
          </p>
          {status.connection.state === "stored" && (
            <section>
              <h4>Draft from your selected message</h4>
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    clear();
                    const generation = epoch.current;
                    const next = await api(base + "/selection", "POST", {});
                    if (
                      mounted.current &&
                      generation === epoch.current &&
                      !document.hidden &&
                      document.hasFocus()
                    )
                      setSelection(next);
                  })
                }
              >
                Load selected message headers
              </button>
              <p>
                Headers clear when permission expires or you leave this window.
                Loading them does not read the body.
              </p>
              {selection && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(async () => {
                      const fingerprint = JSON.stringify({
                        grantId: status.connection.grantId,
                        message: selection.message.id,
                        version: selection.message.sourceVersion,
                        mailbox: selection.mailbox,
                        plain,
                        attachment,
                        kind,
                        profile,
                        allowQuestions,
                        prompt,
                      });
                      if (attempt.current?.fingerprint !== fingerprint)
                        attempt.current = {
                          fingerprint,
                          key: crypto.randomUUID(),
                          conversationId: crypto.randomUUID(),
                        };
                      const task = await api(
                        base + "/drafts",
                        "POST",
                        {
                          conversationId: attempt.current.conversationId,
                          kind,
                          content: attachment
                            ? "attachment-text"
                            : plain
                              ? "plain"
                              : "metadata",
                          prompt,
                          modelProfileId: profile,
                          ...(allowQuestions ? { allowQuestions: true } : {}),
                        },
                        { "Idempotency-Key": attempt.current.key },
                      );
                      attempt.current = null;
                      if (mounted.current) onCreated(task.id);
                    });
                  }}
                >
                  <dl>
                    <dt>Mailbox</dt>
                    <dd>{selection.mailbox}</dd>
                    <dt>Folder</dt>
                    <dd>{selection.folder}</dd>
                    <dt>From</dt>
                    <dd>{selection.message.from}</dd>
                    <dt>Subject</dt>
                    <dd>{selection.message.subject}</dd>
                    <dt>Date</dt>
                    <dd>{selection.message.date || "Not supplied"}</dd>
                  </dl>
                  {selection.message.truncatedMetadata.length > 0 && (
                    <p>Some headers are truncated.</p>
                  )}
                  {selection.scopes.includes("plain") ? (
                    <label>
                      <input
                        type="checkbox"
                        checked={plain}
                        disabled={busy}
                        onChange={(e) => {
                          setPlain(e.target.checked);
                          setAttachment(false);
                          if (!e.target.checked) setKind("summarize");
                        }}
                      />
                      Include the permitted plain-text body in this draft
                    </label>
                  ) : (
                    <p>
                      This connection does not permit the message body.
                      Reconnect in Mail to permit a body.
                    </p>
                  )}
                  {selection.scopes.includes("attachment") && (
                    <label>
                      <input
                        type="checkbox"
                        checked={attachment}
                        disabled={busy}
                        onChange={(e) => {
                          setAttachment(e.target.checked);
                          setPlain(false);
                          setKind("summarize");
                        }}
                      />
                      Summarize the file reviewed in Mail (without the message
                      body)
                    </label>
                  )}
                  <label htmlFor="mail-kind">Draft type</label>
                  <select
                    id="mail-kind"
                    value={kind}
                    disabled={busy}
                    onChange={(e) => setKind(e.target.value as typeof kind)}
                  >
                    <option value="summarize">Summary</option>
                    <option value="draft" disabled={!plain}>
                      Summary and suggested reply
                    </option>
                  </select>
                  <label htmlFor="mail-profile">Local model profile</label>
                  <select
                    className="model-profile-select"
                    id="mail-profile"
                    value={profile}
                    disabled={busy}
                    onChange={(e) => setProfile(e.target.value)}
                  >
                    <option value="">Choose a profile</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {profileLabel(p)}
                      </option>
                    ))}
                  </select>
                  {!profiles.length && (
                    <p>Create a model profile in Models first.</p>
                  )}
                  <label htmlFor="mail-prompt">Draft request</label>
                  <textarea
                    id="mail-prompt"
                    required
                    maxLength={32000}
                    value={prompt}
                    disabled={busy}
                    onChange={(e) => setPrompt(e.target.value)}
                  />
                  <p>
                    HTML is excluded. The selected file is used only when its
                    summary option is checked. Review every generated claim
                    before use.
                  </p>
                  <QuestionChoice
                    checked={allowQuestions}
                    onChange={setAllowQuestions}
                    disabled={busy}
                  />
                  <button
                    disabled={
                      busy ||
                      !profile ||
                      !prompt.trim() ||
                      (kind === "draft" && !plain)
                    }
                  >
                    Create local draft
                  </button>
                </form>
              )}
            </section>
          )}
          <p>
            <a
              href="https://mail.bittrees.org/connect/ai"
              target="_blank"
              rel="noopener noreferrer"
            >
              Review or revoke access in Mail
            </a>
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                clear();
                try {
                  await api(base + "/disconnect", "POST", {});
                } finally {
                  await refresh();
                }
              })
            }
          >
            {status.connection.state === "disconnect_pending"
              ? "Retry Mail disconnect"
              : "Disconnect Mail"}
          </button>
          <p>
            Disconnect revokes the source grant before removing its credential.
            If Mail is unavailable, reads remain paused.
          </p>
          <label>
            <input
              type="checkbox"
              checked={remove}
              disabled={busy}
              onChange={(e) => setRemove(e.target.checked)}
            />
            I understand local removal alone does not revoke the grant in Mail.
          </label>
          <button
            disabled={busy || !remove}
            onClick={() =>
              void act(async () => {
                await api(base + "/local", "DELETE", undefined, {
                  "X-Confirm-Delete": "local-mail-credential",
                });
                setPending(null);
                await refresh();
              })
            }
          >
            Remove local Mail credential
          </button>
        </>
      ) : (
        <>
          <p>
            Review one message, optional body or text attachment, and expiry in
            Mail. The source integration must be enabled by its operator.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                setCode("");
                const next = await api(base + "/begin", "POST", {});
                if (mounted.current) setPending(next);
              })
            }
          >
            {pending ? "Begin again" : "Begin Mail connection"}
          </button>
          {pending && (
            <>
              <p>
                <a
                  href={pending.consentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Select and review a message in Mail
                </a>
              </p>
              <p>
                Return with the one-time code within 60 seconds of approval.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    const id = pending.id,
                      submitted = code.trim();
                    setPending(null);
                    setCode("");
                    try {
                      await api(base + "/finish", "POST", {
                        id,
                        code: submitted,
                      });
                    } finally {
                      await refresh();
                    }
                  });
                }}
              >
                <label htmlFor="mail-code">One-time Mail code</label>
                <input
                  id="mail-code"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={code}
                  maxLength={64}
                  onChange={(e) => setCode(e.target.value)}
                  required
                />
                <button disabled={busy || !/^[a-f0-9]{64}$/.test(code.trim())}>
                  Save Mail connection
                </button>
              </form>
            </>
          )}
        </>
      )}
    </article>
  );
}
