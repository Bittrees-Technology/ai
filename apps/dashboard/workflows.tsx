import { TaskSyncStatus } from "./task-sync.js";
import {
  readWorkflowPermissions,
  ownerReviewReady,
  type WorkflowReadiness,
} from "./workflow-readiness.js";
import React, { useState, useEffect } from "react";
export function Workflows({
  api,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
}) {
  const [data, setData] = useState<any>(null),
    [readiness, setReadiness] = useState<WorkflowReadiness | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [model, setModel] = useState("Rule-based supplier validation (no model)");
  const receive = (
    result: Awaited<ReturnType<typeof readWorkflowPermissions>>,
  ) => {
    setReadiness(result.readiness);
    setData(result.data);
    setError(
      result.sourceUnavailable
        ? "Workflow permissions could not be verified. Native owner approval or the current source connection may need attention."
        : "",
    );
  };
  const refresh = async () => receive(await readWorkflowPermissions(api));
  useEffect(() => {
    let active = true;
    readWorkflowPermissions(api)
      .then((d) => {
        if (active) receive(d);
      })
      .catch(() => {
        if (active) {
          setData(null);
          setReadiness(null);
          setError(
            "Local workflow readiness could not be verified. Owner review remains unavailable.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, []);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch {
      setData(null);
      setReadiness(null);
      setError(
        "The request could not be confirmed. Refresh to check the current state.",
      );
    } finally {
      setBusy(false);
    }
  }
  const g = data?.grant;
  const status = g?.revoked_at
    ? "Revoked"
    : g?.require_wallet && !g.signed_at
      ? "Awaiting wallet approval"
      : g?.paused_at
        ? "Paused"
        : g?.approval_expires_at &&
            new Date(g.approval_expires_at).getTime() <= Date.now()
          ? "Approval expired"
          : g?.signed_at
            ? "Wallet approved"
            : "Operator configured — not wallet signed";
  return (
    <section>
      <TaskSyncStatus
        api={api}
        canStartOwnerReview={ownerReviewReady(readiness, data)}
      />
      <p>
        Delegate work to this Mac with your wallet. Your app connections keep
        their own access rules.
      </p>
      {error && <p role="alert">{error}</p>}
      {readiness && !readiness.nativeTransportAvailable && (
        <section aria-label="Native workflow setup required">
          <h3>Native workflow connection needs setup</h3>
          <p>
            This Mac has not supplied the native connection capability. This
            check has not requested hosted workflow permissions.
          </p>
          <p>
            The app operator must prepare the reviewed native connection before
            owner enrollment. Once available, use the Bittrees AI menu’s Connect
            workflows… control to review enrollment transport.
          </p>
          <p>
            Connection setup, native owner consent, Roles enrollment and source
            permissions are separate steps.
          </p>
        </section>
      )}
      <button disabled={busy} onClick={() => void act(async () => {})}>
        Refresh
      </button>
      {!data && !error && !readiness && (
        <p role="status">Loading permissions…</p>
      )}
      {data && !data.connected && (
        <>
          <h3>Connect this Mac</h3>
          <p>{data.deviceLabel}</p>
          <label>
            Local model or engine{" "}
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option>Rule-based supplier validation (no model)</option>
              {data.models?.map((m: string) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <p>
            This registers the device and selected engine. App access must be
            connected separately; pairing does not start a model or grant
            publishing access.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await api("/v1/workflows/register", "POST", { model });
              })
            }
          >
            Create pairing code
          </button>
        </>
      )}
      {data?.connected && (
        <section aria-label="Workflow synchronization">
          <h3>Workflow synchronization</h3>
          <p role="status">
            {data.catalogue?.status === "synced"
              ? "Workflow catalogue synced."
              : data.catalogue?.status === "unavailable"
                ? "Workflow sync unavailable. Retrying automatically each minute while this app is running."
                : "Workflow sync is waiting for confirmation."}
          </p>
          {data.catalogue?.lastSyncedAt && (
            <p>
              Last confirmed workflow sync:{" "}
              {new Date(data.catalogue.lastSyncedAt).toLocaleString()}.
            </p>
          )}
          {data.catalogue?.checkedAt && (
            <p>
              Last sync attempt:{" "}
              {new Date(data.catalogue.checkedAt).toLocaleString()}.
            </p>
          )}
          <p>
            Device connection status does not confirm that workflows synced.
            Only process metadata and numeric counts are shared with your
            owner-only directory view.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await api("/v1/workflows/sync", "POST", {});
              })
            }
          >
            Sync workflows now
          </button>
        </section>
      )}
      {g && (
        <>
          <h3>{g.device_label}</h3>
          <p>
            <strong>{status}</strong>
          </p>
          <dl>
            <dt>Device</dt>
            <dd>{g.device_id}</dd>
            <dt>Wallet</dt>
            <dd>{g.wallet_address || "Not approved yet"}</dd>
            <dt>Engine</dt>
            <dd>{g.model_label}</dd>
            <dt>Last connected</dt>
            <dd>
              {g.last_seen_at
                ? new Date(g.last_seen_at).toLocaleString()
                : "Checking now"}
            </dd>
          </dl>
          {data.pairCode && !g.wallet_address && (
            <>
              <h3>Pair with your wallet</h3>
              <p>
                Open the approval page below. It carries this code for you;
                review this device and its permissions before signing.
              </p>
              <a
                className="primary"
                href={
                  "https://ai.bittrees.org/workflows#pair=" +
                  encodeURIComponent(data.pairCode)
                }
                target="_blank"
                rel="noreferrer"
              >
                Continue on ai.bittrees.org
              </a>
              <details>
                <summary>Use a code instead</summary>
                <pre>{data.pairCode}</pre>
                <button
                  onClick={() =>
                    void act(() =>
                      navigator.clipboard.writeText(data.pairCode!),
                    )
                  }
                >
                  Copy website pairing code
                </button>
              </details>
              <p>Expires {new Date(data.pairExpiresAt).toLocaleString()}.</p>
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api("/v1/workflows/register", "POST", {
                      model: g.model_label,
                    });
                  })
                }
              >
                Create a new code
              </button>
            </>
          )}
          <p>
            <a
              href="https://ai.bittrees.org/workflows"
              target="_blank"
              rel="noreferrer"
            >
              Open wallet approval, activity &amp; exceptions
            </a>
          </p>
          <p>
            Signing happens in your wallet browser. Resume requires a fresh
            signature. Pause and revoke block future connected-app actions; an
            accepted action may finish.
          </p>
          {!g.revoked_at && (
            <div className="actions">
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api("/v1/workflows/control", "POST", {
                      action: "pause",
                    });
                  })
                }
              >
                Pause workflow
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  if (
                    confirm(
                      "Permanently revoke this workflow’s connected access?",
                    )
                  )
                    void act(async () => {
                      await api("/v1/workflows/control", "POST", {
                        action: "revoke",
                      });
                    });
                }}
              >
                Revoke access
              </button>
            </div>
          )}
        </>
      )}
      {data?.runs && (
        <>
          <h3>Exceptions &amp; reviews</h3>
          {data.runs.flatMap((r: any) =>
            (r.outcomes || [])
              .filter(
                (o: any) =>
                  o.held ||
                  o.decision === "changes_requested" ||
                  o.state === "awaiting_review",
              )
              .map((o: any, i: number) => (
                <p key={r.run_id + ":" + i}>
                  {o.source}: {o.reason || "Awaiting review"}{" "}
                  <a
                    href={
                      o.source === "mercado"
                        ? "https://mercado.bittrees.org/admin/submissions"
                        : "https://crm.bittrees.org/connect/ai/leads"
                    }
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open review queue
                  </a>
                </p>
              )),
          )}
          <details>
            <summary>Activity</summary>
            {data.runs.map((r: any) => (
              <p key={r.run_id}>
                {new Date(r.updated_at).toLocaleString()} —{" "}
                {Object.entries(r.counts)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(", ")}
              </p>
            ))}
            {data.activity?.map((a: any, i: number) => (
              <p key={i}>
                {new Date(a.created_at).toLocaleString()} — {a.action}
              </p>
            ))}
          </details>
        </>
      )}
      <p>
        Manage your models in Models and source permissions in Connections.
        Other users pair their own Mac with their own wallet; they do not
        receive your permissions.
      </p>
    </section>
  );
}
