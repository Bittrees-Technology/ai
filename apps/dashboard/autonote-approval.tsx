import React, { useEffect, useId, useRef, useState } from "react";
type Api = (
  path: string,
  method?: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<any>;
const base = "/v1/connections/autonote-approval";
export function AutoNoteApprovalPanel({ api }: { api: Api }) {
  const [status, setStatus] = useState<any>(null),
    [pending, setPending] = useState<any>(null),
    [code, setCode] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const codeId = useId(),
    running = useRef(false);
  useEffect(() => {
    let active = true;
    api(base)
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => {
        if (active)
          setError(
            "Approval status could not be loaded. Refresh to try again.",
          );
      });
    return () => {
      active = false;
    };
  }, [api]);
  async function act(fn: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch {
      setError(
        "This step could not be confirmed. Refresh permissions; start a new setup if the exchange response was lost.",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <article className="card" aria-label="AutoNote approval setup">
      <h3>AutoNote approval permission</h3>
      <p>
        Separate permission to review and save notes for your connected meeting.
        Each exact draft will still need your approval. Setup does not save
        notes or publish to CRM.
      </p>
      {error && <p role="alert">{error}</p>}
      <button
        disabled={busy}
        onClick={() => void act(async () => setStatus(await api(base)))}
      >
        Refresh approval status
      </button>
      {!status ? (
        <p>Load approval status to begin.</p>
      ) : !status.available ? (
        <p>Approval setup is unavailable in this build.</p>
      ) : status.connection ? (
        <>
          <p>
            Approval permission: {status.connection.state}. Current source
            access is checked when used.
          </p>
          <dl>
            <dt>Meeting</dt>
            <dd>{status.connection.meetingId}</dd>
            <dt>Expires</dt>
            <dd>{new Date(status.connection.expiresAt).toLocaleString()}</dd>
          </dl>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await api(base + "/local", "DELETE", undefined, {
                  "X-Confirm-Delete": "local-autonote-approval-credential",
                });
                setCode("");
                setPending(null);
                setStatus(await api(base));
              })
            }
          >
            Remove approval from this Mac
          </button>
          <p>Local removal does not revoke the permission at AutoNote.</p>
        </>
      ) : !pending ? (
        <>
          <p>
            Connect one AutoNote transcript and enable draft review uploads
            before starting.
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
            Set up approval permission
          </button>
        </>
      ) : (
        <>
          <p>
            <a
              href={pending.consentUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Review this permission in AutoNote
            </a>
          </p>
          <p>
            Review the meeting and duration there, then enter its one-use code
            here. Setup expires at{" "}
            {new Date(pending.expiresAt).toLocaleTimeString()}.
          </p>
          <label htmlFor={codeId}>AutoNote approval code</label>
          <input
            id={codeId}
            type="password"
            autoComplete="off"
            value={code}
            maxLength={64}
            disabled={busy}
            onChange={(e) => setCode(e.target.value.trim())}
          />
          <button
            disabled={busy || !/^[a-f0-9]{64}$/.test(code)}
            onClick={() =>
              void act(async () => {
                const exchange = { id: pending.id, code };
                setCode("");
                setPending(null);
                await api(base + "/finish", "POST", exchange);
                setStatus(await api(base));
              })
            }
          >
            Save approval permission on this Mac
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await api(base + "/cancel", "POST", {});
                setPending(null);
                setCode("");
              })
            }
          >
            Cancel approval setup
          </button>
        </>
      )}
      <p>
        <a
          href="https://autonote.bittrees.org/connect/ai"
          target="_blank"
          rel="noopener noreferrer"
        >
          Review or revoke approval in AutoNote
        </a>
      </p>
    </article>
  );
}
