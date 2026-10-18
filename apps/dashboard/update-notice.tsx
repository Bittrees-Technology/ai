import React, { useEffect, useState } from "react";
export function UpdateNotice({ api }: { api: (path: string) => Promise<any> }) {
  const [update, setUpdate] = useState<any>(null);
  const [dismissed, setDismissed] = useState("");
  useEffect(() => {
    let active = true;
    const check = () => {
      void api("/v1/updates")
        .then((value) => {
          if (active) setUpdate(value);
        })
        .catch(() => {});
    };
    check();
    const timer = setInterval(check, 15 * 60 * 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api]);
  if (
    update?.state !== "available" ||
    update.tag === dismissed ||
    !/^https:\/\/github\.com\/Bittrees-Technology\/ai\/releases\/tag\/[A-Za-z0-9._-]+$/.test(
      update.url,
    )
  )
    return null;
  return (
    <section className="card" role="status" aria-label="App update available">
      <strong>Bittrees AI update available: {update.tag}</strong>
      <p>
        Installed {update.installed?.slice(0, 12)} · Available{" "}
        {update.source?.slice(0, 12)}. Download the published Mac release when
        you are ready. Your running work is not interrupted.
      </p>
      <a href={update.url} target="_blank" rel="noopener noreferrer">
        View release and download
      </a>{" "}
      <button onClick={() => setDismissed(update.tag)}>Later</button>
    </section>
  );
}
