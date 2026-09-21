import React, { useEffect, useState } from "react";
type Api = (
  path: string,
  method?: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<any>;
type Connection = {
  grantId: string;
  subjectId: string;
  workspaceId: string;
  recordIds: string[];
  expiresAt: string;
  state: "stored" | "expired" | "disconnect_pending";
};
export function Connections({
  api,
  onError,
}: {
  api: Api;
  onError: (e: unknown) => void;
}) {
  const [current, setCurrent] = useState<{
    available: boolean;
    connection: Connection | null;
  } | null>(null);
  const [pending, setPending] = useState<{
    id: string;
    consentUrl: string;
    expiresAt: string;
  } | null>(null);
  const [code, setCode] = useState(""),
    [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    let active = true;
    api("/v1/connections/crm")
      .then((data) => {
        if (active) setCurrent(data);
      })
      .catch((e) => {
        if (active) {
          setLoadFailed(true);
          onError(e);
        }
      });
    return () => {
      active = false;
    };
  }, []);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="content">
      <h2>Connect only what you choose</h2>
      <p>
        Each app controls its own permissions. Pairing this browser does not
        grant app access.
      </p>
      <article className="card">
        <h3>CRM</h3>
        {!current ? (
          <p role="status">
            {loadFailed
              ? "Connection status unavailable. Reopen Connections to try again."
              : "Loading connection…"}
          </p>
        ) : !current.available ? (
          <p>Connection adapter unavailable in this build.</p>
        ) : current.connection ? (
          <>
            <p>
              {current.connection.state === "disconnect_pending"
                ? "Disconnect pending — reads are paused; retry to confirm revocation"
                : current.connection.state === "expired"
                  ? "Credential expired"
                  : "Credential saved on this Mac"}
              . Current access is checked with CRM on every read.
            </p>
            <dl>
              <dt>Source user</dt>
              <dd>{current.connection.subjectId}</dd>
              <dt>Workspace</dt>
              <dd>{current.connection.workspaceId}</dd>
              <dt>Selected records</dt>
              <dd>{current.connection.recordIds.length} · read only</dd>
              <dt>Expires</dt>
              <dd>{new Date(current.connection.expiresAt).toLocaleString()}</dd>
            </dl>
            <p>
              <a
                href="https://crm.bittrees.org/connect/ai"
                target="_blank"
                rel="noopener noreferrer"
              >
                Review or revoke access in CRM
              </a>
            </p>
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  if (
                    !confirm(
                      "Revoke this CRM grant and remove its credential from this Mac?",
                    )
                  )
                    return;
                  try {
                    await api("/v1/connections/crm/disconnect", "POST", {});
                  } finally {
                    setCurrent(await api("/v1/connections/crm"));
                  }
                  setPending(null);
                  setCode("");
                })
              }
            >
              {current.connection.state === "disconnect_pending"
                ? "Retry disconnect"
                : "Disconnect CRM"}
            </button>
            <p>
              Disconnect revokes the source grant before removing the
              credential. If CRM is unavailable, reads stay paused until you
              retry.
            </p>
            <p>
              Remove the local credential after revoking in CRM. Local removal
              alone does not revoke the source grant.
            </p>
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  if (
                    !confirm(
                      "Remove the CRM credential from this Mac? Revoke the source grant in CRM separately.",
                    )
                  )
                    return;
                  await api("/v1/connections/crm/local", "DELETE", undefined, {
                    "X-Confirm-Delete": "local-crm-credential",
                  });
                  setCurrent({ available: true, connection: null });
                  setPending(null);
                  setCode("");
                })
              }
            >
              Remove local credential
            </button>
          </>
        ) : (
          <>
            <p>
              Choose exact records and an expiry in CRM. The source feature must
              be enabled by its operator; availability is not assumed.
            </p>
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  setCode("");
                  setPending(
                    await api("/v1/connections/crm/begin", "POST", {}),
                  );
                })
              }
            >
              {pending ? "Begin again" : "Begin CRM connection"}
            </button>
            {pending && (
              <>
                <p>
                  <a
                    href={pending.consentUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Select and review records in CRM
                  </a>
                </p>
                <p>
                  Return here with the one-time code within 60 seconds of
                  approval. This local attempt expires at{" "}
                  {new Date(pending.expiresAt).toLocaleTimeString()}.
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(async () => {
                      const attempt = pending;
                      setPending(null);
                      const submitted = code.trim();
                      setCode("");
                      try {
                        await api("/v1/connections/crm/finish", "POST", {
                          id: attempt.id,
                          code: submitted,
                        });
                      } finally {
                        setCurrent(await api("/v1/connections/crm"));
                      }
                    });
                  }}
                >
                  <label htmlFor="crm-code">One-time CRM code</label>
                  <input
                    id="crm-code"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    maxLength={64}
                    required
                  />
                  <button
                    disabled={busy || !/^[a-f0-9]{64}$/.test(code.trim())}
                  >
                    Save connection
                  </button>
                </form>
              </>
            )}
          </>
        )}
        <p>
          CRM drafts and reviewed writes are still being integrated. No
          automatic reads or cross-app memory are enabled.
        </p>
      </article>
      {["AutoNote", "Roles", "Mail", "News"].map((name) => (
        <div className="row" key={name}>
          <h3>{name}</h3>
          <span>Not connected</span>
        </div>
      ))}
    </section>
  );
}
