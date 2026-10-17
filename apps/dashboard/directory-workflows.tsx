import React, { useEffect, useState } from "react";
export function DirectoryWorkflows({
  api,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
}) {
  const [data, setData] = useState<any>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [repository, setRepository] = useState(""),
    [profileId, setProfile] = useState(""),
    [profiles, setProfiles] = useState<any[]>([]);
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const d = await api("/v1/research/directory");
        if (alive) setData(d);
      } catch {
        if (alive) setError("Directory workflow status is unavailable.");
      }
    };
    void refresh();
    void api("/v1/profiles")
      .then((d) => {
        if (alive) {
          setProfiles(d.items);
          setProfile(d.defaultProfile?.id || d.items[0]?.id || "");
        }
      })
      .catch(() => {});
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  async function act(pause = false) {
    setBusy(true);
    setError("");
    try {
      setData(
        await api(
          pause
            ? "/v1/research/directory/pause"
            : "/v1/research/directory/configure",
          "POST",
          pause
            ? {}
            : {
                enabled: true,
                confirmed: true,
                repository: repository || data.configuration?.repository,
                profileId: data.configuration?.profileId || profileId,
              },
        ),
      );
    } catch {
      setError(
        "Could not update the workflows. Check the checkout path and selected model.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="CryptoDirectory workflows">
      <h3>CryptoDirectory</h3>
      <p>
        This Mac finds projects daily and checks directory information hourly.
        Both use the local model and save source evidence. Findings do not
        change published listings.
      </p>
      {error && <p role="alert">{error}</p>}
      {!data?.configured && (
        <>
          <label>
            Directory checkout{" "}
            <input
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
              placeholder="Absolute path to crypto-directory"
            />
          </label>
          <label>
            Local model{" "}
            <select
              value={profileId}
              onChange={(e) => setProfile(e.target.value)}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.model}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <button disabled={busy} onClick={() => void act(!!data?.enabled)}>
        {data?.enabled
          ? "Pause directory workflows"
          : "Enable directory workflows"}
      </button>
      <p>
        Discovery starts with the DeFiLlama catalogue. Coverage outside its
        projects is limited; a missing result does not mean a tag has no
        projects.
      </p>
      {data?.workflows?.map((w: any) => (
        <div key={w.id}>
          <h4>{w.label}</h4>
          <p>
            {w.cadence} · {w.state || "Not configured"} · {w.processed || 0}{" "}
            assessments saved this run · {w.failures || 0} unsuccessful checks
          </p>
          <p>{w.message}</p>
          {w.nextAt > 0 && (
            <p>Next eligible run: {new Date(w.nextAt).toLocaleString()}</p>
          )}
        </div>
      ))}
      <h4>Recent findings</h4>
      <p>
        Source-assessed means the model supplied matching quotations. It is not
        a security audit, endorsement, or manual verification.
      </p>
      {data?.results?.slice(0, 20).map((r: any) => (
        <details key={r.mode + r.url}>
          <summary>
            {r.name || r.url} — {r.mode} — {r.status}
          </summary>
          <p>{r.summary}</p>
          <a href={r.url} target="_blank" rel="noreferrer">
            Source
          </a>
          <p>
            {r.tags?.join(", ")} · {r.checkedAt}
          </p>
          {r.claims?.map((c: any, i: number) => (
            <p key={i}>
              {c.field}: {c.value}
              <br />
              Evidence: “{c.quote}”
            </p>
          ))}
          {r.uncertainties?.map((s: string, i: number) => (
            <p key={i}>Unconfirmed: {s}</p>
          ))}
        </details>
      ))}
    </section>
  );
}
