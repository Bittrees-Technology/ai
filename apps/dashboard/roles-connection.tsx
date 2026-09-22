import React, { useEffect, useRef, useState } from "react";
type Api = (
  path: string,
  method?: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<any>;
export function RolesConnection({
  api,
  onError,
}: {
  api: Api;
  onError: (e: unknown) => void;
}) {
  const base = "/v1/connections/roles";
  const [status, setStatus] = useState<any>(null),
    [pending, setPending] = useState<any>(null),
    [code, setCode] = useState(""),
    [report, setReport] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [remove, setRemove] = useState(false);
  const epoch = useRef(0),
    working = useRef(false),
    mounted = useRef(true);
  function clear() {
    epoch.current++;
    setReport(null);
    setCode("");
    setRemove(false);
  }
  async function refresh() {
    clear();
    const data = await api(base);
    if (mounted.current) setStatus(data);
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
    if (!report) return;
    const deadlines = [
      Date.now() + 15000,
      Date.parse(report.expiresAt),
      ...report.projection.items.map(
        (i: any) => Date.parse(i.observedAt) + 300000,
      ),
      ...report.projection.items
        .filter((i: any) => i.observation === "current" && i.expiresAt)
        .map((i: any) => Date.parse(i.expiresAt)),
    ];
    const timer = setTimeout(
      clear,
      Math.max(0, Math.min(...deadlines) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [report]);
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
  const connection = status?.connection;
  return (
    <article className="card roles-connection">
      <h3>Roles</h3>
      <p>
        View your own linked-wallet observations. Reported roles and permissions
        do not establish confirmed, effective or enforced access. Role changes
        stay in Roles and the responsible source app.
      </p>
      <a
        href="https://roles.bittrees.org/connect/ai"
        target="_blank"
        rel="noopener noreferrer"
      >
        Manage Roles connection permission
      </a>
      <button disabled={busy} onClick={() => void act(refresh)}>
        Refresh Roles connection
      </button>
      {status && !status.available && (
        <p>The Roles connector is unavailable in this companion build.</p>
      )}
      {status?.available && !connection && (
        <>
          <p>No saved Roles connection.</p>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                clear();
                setPending(await api(base + "/begin", "POST", {}));
              })
            }
          >
            Connect Roles
          </button>
        </>
      )}
      {pending && !connection && (
        <section>
          <a
            href={pending.consentUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Review your own-access scope in Roles
          </a>
          <p>
            After approving there, paste the single-use code here. It expires
            after 60 seconds. Pasted codes clear when leaving this window.
          </p>
          <label>
            Roles connection code
            <input
              type="password"
              autoComplete="off"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <button
            disabled={busy || !/^[a-f0-9]{64}$/.test(code)}
            onClick={() =>
              void act(async () => {
                const selected = code;
                setCode("");
                const id = pending.id;
                setPending(null);
                await api(base + "/finish", "POST", { id, code: selected });
                await refresh();
              })
            }
          >
            Finish Roles connection
          </button>
        </section>
      )}
      {connection && (
        <section>
          <p>Profile: {connection.profileId}</p>
          <p>
            {connection.state === "stored"
              ? "Credential saved; source access is checked when loaded"
              : connection.state === "expired"
                ? "Connection expired"
                : "Disconnect is pending; access is paused"}{" "}
            · expires {new Date(connection.expiresAt).toLocaleString()}
          </p>
          <button
            disabled={busy || connection.state !== "stored"}
            onClick={() =>
              void act(async () => {
                clear();
                const generation = epoch.current;
                const result = await api(base + "/access", "POST", {});
                if (
                  mounted.current &&
                  generation === epoch.current &&
                  !document.hidden &&
                  document.hasFocus()
                )
                  setReport(result);
              })
            }
          >
            Load my access observations
          </button>
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
            Disconnect at Roles
          </button>
          <p>
            Local removal only deletes this device’s credential. Revoke in Roles
            to stop source access. Existing independent exports have their own
            deletion controls.
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={remove}
              onChange={(e) => setRemove(e.target.checked)}
            />{" "}
            I understand local removal does not revoke source access.
          </label>
          <button
            disabled={busy || !remove}
            onClick={() =>
              void act(async () => {
                clear();
                await api(base + "/local", "DELETE", undefined, {
                  "X-Confirm-Delete": "local-roles-credential",
                });
                await refresh();
              })
            }
          >
            Remove local Roles credential
          </button>
        </section>
      )}
      {report && (
        <section>
          <h4>Current source observations</h4>
          <p>{report.projection.coverage}</p>
          <p>
            This view clears after 15 seconds, when observations expire, or when
            leaving this window. Load again to recheck access.
          </p>
          {!report.projection.items.length && (
            <p>
              No matching wallet observations. This does not mean you have no
              source permissions.
            </p>
          )}
          {report.projection.items.map((item: any, index: number) => (
            <article key={index}>
              <strong>{item.label}</strong>
              <p>
                Source: {item.source} · Scope: {item.scope ?? "Not specified"}
              </p>
              <p>Wallet: {item.beneficiary}</p>
              <p>
                Observed: {new Date(item.observedAt).toLocaleString()} ·{" "}
                {item.observation === "expired"
                  ? "Expired report"
                  : "Current observation"}
              </p>
              {item.kind === "permission" && (
                <p>
                  Reported effect: {item.reportedEffect ?? "Not supplied"} ·
                  Reported status: {item.reportedStatus ?? "Not supplied"}
                </p>
              )}
              <p>
                Authority confirmation: not verified. Effective access: not
                verified. Enforcement acknowledgement: not verified.
              </p>
              <a
                href={item.manageUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Inspect in Roles
              </a>
            </article>
          ))}
        </section>
      )}
    </article>
  );
}
