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
    [includePolicy, setIncludePolicy] = useState(false),
    [policy, setPolicy] = useState<any>(null),
    [report, setReport] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [remove, setRemove] = useState(false);
  const epoch = useRef(0),
    working = useRef(false),
    mounted = useRef(true);
  function clear() {
    epoch.current++;
    setReport(null);
    setPolicy(null);
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
  useEffect(() => {
    if (!policy) return;
    const timer = setTimeout(
      clear,
      Math.max(
        0,
        Math.min(
          Date.parse(policy.expiresAt),
          Date.parse(policy.projection.validUntil),
          Date.now() + 15000,
        ) - Date.now(),
      ),
    );
    return () => clearTimeout(timer);
  }, [policy]);
  async function loadPolicy() {
    clear();
    const generation = epoch.current;
    const result = await api(base + "/policy", "POST", {});
    if (
      mounted.current &&
      generation === epoch.current &&
      !document.hidden &&
      document.hasFocus() &&
      Date.parse(result.projection.validUntil) > Date.now()
    )
      setPolicy(result);
  }
  const connection = status?.connection;
  const hasPolicy = connection?.actions?.includes("read_own_policy") === true;
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
          <label className="check">
            <input
              type="checkbox"
              checked={includePolicy}
              disabled={busy}
              onChange={(e) => {
                setIncludePolicy(e.target.checked);
                setPending(null);
                setCode("");
              }}
            />{" "}
            Request my own policy records as well
          </label>
          <p>
            Optional: stored grants for your linked identities and personal
            profile, including actions, resource scopes, expiry and suspension.
            Resource scopes may identify people. You must also approve this
            option in Roles. It does not enable role changes or prove effective
            access.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                clear();
                setPending(
                  await api(base + "/begin", "POST", { includePolicy }),
                );
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
            Allowed scope:{" "}
            {hasPolicy
              ? "Wallet observations and own policy records"
              : "Wallet observations only"}
            .
          </p>
          {!hasPolicy && (
            <p>
              To include policy records, disconnect and make a new connection
              with that option approved in Roles.
            </p>
          )}
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
          {hasPolicy && (
            <button
              disabled={busy || connection.state !== "stored"}
              onClick={() => void act(loadPolicy)}
            >
              Load my policy records
            </button>
          )}
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
      {policy && (
        <section>
          <h4>Your stored policy records</h4>
          <p>{policy.projection.coverage}</p>
          <p>
            {policy.projection.policyStatus === "absent"
              ? "No stored policy is available."
              : policy.projection.policyStatus === "expired"
                ? "The stored policy has expired."
                : "Current stored policy"}{" "}
            {policy.projection.policyRevision !== null && (
              <>· Revision {policy.projection.policyRevision}</>
            )}
          </p>
          <p>
            Checked {new Date(policy.projection.checkedAt).toLocaleString()}.
            This view clears within 15 seconds, at snapshot expiry, or when you
            leave this window. Load again to check for changes.
          </p>
          <p>
            These records do not prove effective access or downstream
            enforcement and cannot authorize actions. Email subject references
            conceal the address field; exact resource scopes may still identify
            people.
          </p>
          {!policy.projection.items.length && (
            <p>
              No matching stored grants. This does not mean you have no
              permissions in other apps.
            </p>
          )}
          {policy.projection.items.map((item: any) => (
            <article key={item.grantId}>
              <strong>{item.roleId}</strong>
              <p>
                {
                  (
                    {
                      recorded_current: "Recorded in the current policy",
                      expired: "Expired record",
                      suspended: "Suspended",
                      source_owned: "Authority stays with the source app",
                      wallet_required: "Wallet authentication required",
                    } as Record<string, string>
                  )[item.status]
                }
              </p>
              <p>
                Subject: {item.subject.kind} · {item.subject.reference}
              </p>
              <p>
                Scope: {item.scope} · Domain: {item.domain}
              </p>
              <p>Actions: {item.actions.join(", ")}</p>
              <p>Resources: {item.resources.join(", ")}</p>
              <p>Expires: {new Date(item.expiresAt).toLocaleString()}</p>
              <p>
                Authority confirmation:{" "}
                {item.authorityConfirmed === "recorded_in_current_policy"
                  ? "recorded in current policy only"
                  : "not confirmed"}
                . Effective access: not verified. Enforcement acknowledgement:
                not verified.
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
