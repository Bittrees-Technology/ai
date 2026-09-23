import { PrivateCheckPanel } from "./private-checks.js";
import { PrivatePermissionPanel } from "./private-permissions.js";
import { PrivatePeerPanel } from "./private-peers.js";
import { PrivateKeyPanel } from "./private-keys.js";
import { RemoteConnectionPanel } from "./remote-connection.js";
import { MailConnection } from "./mail-connection.js";
import { RolesConnection } from "./roles-connection.js";
import { AutoNoteDrafts } from "./autonote-drafts.js";
import { CrmDrafts } from "./crm-drafts.js";
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
  recordIds?: string[];
  meetingId?: string;
  expiresAt: string;
  state: "stored" | "expired" | "disconnect_pending";
};
function ConnectionCard({
  app,
  api,
  onError,
  profiles,
  onCreated,
}: {
  app: "crm" | "autonote";
  profiles: { id: string; model: string }[];
  onCreated: (id: string) => void;
  api: Api;
  onError: (e: unknown) => void;
}) {
  const label = app === "crm" ? "CRM" : "AutoNote";
  const base = "/v1/connections/" + app;
  const manage = `https://${app}.bittrees.org/connect/ai`;
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
    api(base)
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
    <article className="card">
      <h3>{label}</h3>
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
            . Current access is checked with {label} on every read.
          </p>
          {current.connection.state === "stored" &&
            (app === "crm" ? (
              <CrmDrafts
                api={api}
                onError={onError}
                profiles={profiles}
                onCreated={onCreated}
              />
            ) : (
              <AutoNoteDrafts
                api={api}
                onError={onError}
                profiles={profiles}
                onCreated={onCreated}
              />
            ))}
          <dl>
            <dt>Source user</dt>
            <dd>{current.connection.subjectId}</dd>
            <dt>Workspace</dt>
            <dd>{current.connection.workspaceId}</dd>
            <dt>Selected scope</dt>
            <dd>
              {app === "crm"
                ? `${current.connection.recordIds?.length ?? 0} records`
                : "One meeting transcript"}{" "}
              · read only
            </dd>
            <dt>Expires</dt>
            <dd>{new Date(current.connection.expiresAt).toLocaleString()}</dd>
          </dl>
          <p>
            <a href={manage} target="_blank" rel="noopener noreferrer">
              Review or revoke access in {label}
            </a>
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                if (
                  !confirm(
                    `Revoke this ${label} grant and remove its credential from this Mac?`,
                  )
                )
                  return;
                try {
                  await api(base + "/disconnect", "POST", {});
                } finally {
                  setCurrent(await api(base));
                }
                setPending(null);
                setCode("");
              })
            }
          >
            {current.connection.state === "disconnect_pending"
              ? "Retry disconnect"
              : `Disconnect ${label}`}
          </button>
          <p>
            Disconnect revokes the source grant before removing the credential.
            If {label} is unavailable, reads stay paused until you retry.
          </p>
          <p>
            Remove the local credential after revoking in {label}. Local removal
            alone does not revoke the source grant.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                if (
                  !confirm(
                    `Remove the ${label} credential from this Mac? Revoke the source grant in ${label} separately.`,
                  )
                )
                  return;
                await api(base + "/local", "DELETE", undefined, {
                  "X-Confirm-Delete": `local-${app}-credential`,
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
            Choose {app === "crm" ? "exact records" : "one meeting transcript"}{" "}
            and an expiry in {label}. The source feature must be enabled by its
            operator; availability is not assumed.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                setCode("");
                setPending(await api(base + "/begin", "POST", {}));
              })
            }
          >
            {pending ? "Begin again" : `Begin ${label} connection`}
          </button>
          {pending && (
            <>
              <p>
                <a
                  href={pending.consentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Select and review {app === "crm" ? "records" : "a meeting"} in{" "}
                  {label}
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
                      await api(base + "/finish", "POST", {
                        id: attempt.id,
                        code: submitted,
                      });
                    } finally {
                      setCurrent(await api(base));
                    }
                  });
                }}
              >
                <label htmlFor={`${app}-code`}>One-time {label} code</label>
                <input
                  id={`${app}-code`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  maxLength={64}
                  required
                />
                <button disabled={busy || !/^[a-f0-9]{64}$/.test(code.trim())}>
                  Save connection
                </button>
              </form>
            </>
          )}
        </>
      )}
      <p>
        {app === "crm"
          ? "Drafts stay local until you explicitly send a proposal for CRM review."
          : "Drafts stay local until you explicitly send them for review in AutoNote."}{" "}
        Cross-app memory is not enabled.
      </p>
    </article>
  );
}

export function Connections(props: {
  api: Api;
  onError: (e: unknown) => void;
  profiles: { id: string; model: string }[];
  onCreated: (id: string) => void;
}) {
  return (
    <section className="content">
      <h2>Connect only what you choose</h2>
      <p>
        Each app controls its own permissions. Pairing this browser does not
        grant app access.
      </p>
      <RemoteConnectionPanel api={props.api} />
      <PrivateKeyPanel api={props.api} />
      <PrivatePeerPanel api={props.api} />
      <PrivateCheckPanel api={props.api} />
      <PrivatePermissionPanel api={props.api} />
      <ConnectionCard app="crm" {...props} />
      <ConnectionCard app="autonote" {...props} />
      <RolesConnection api={props.api} onError={props.onError} />
      <MailConnection {...props} />
      {["News"].map((name) => (
        <div className="row" key={name}>
          <h3>{name}</h3>
          <span>Not connected</span>
        </div>
      ))}
    </section>
  );
}
