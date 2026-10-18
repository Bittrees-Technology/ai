import { readFile } from "node:fs/promises";
const repo = "Bittrees-Technology/ai";
const api = `https://api.github.com/repos/${repo}`;
const required = [
  "checks",
  "macos-package",
  "autonote-integration",
  "remote-status-integration",
  "browser-private-protocol",
];
const sha = /^[a-f0-9]{40}$/;
export function releaseChecker(
  load: () => Promise<{ sourceCommit: string; sourceDirty: boolean }>,
  request: typeof fetch = fetch,
  now = Date.now,
) {
  let cached: any,
    until = 0,
    pending: Promise<any> | undefined;
  async function json(url: string) {
    const r = await request(url, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw Error("Update service unavailable");
    const text = await r.text();
    if (text.length > 1_000_000) throw Error("Oversized update response");
    return JSON.parse(text);
  }
  async function check() {
    const installed = await load();
    if (!sha.test(installed.sourceCommit) || installed.sourceDirty)
      return { state: "unavailable" };
    const base = {
      installed: installed.sourceCommit,
      checkedAt: new Date(now()).toISOString(),
    };
    const releases = await json(`${api}/releases?per_page=10`);
    if (!Array.isArray(releases)) throw Error("Invalid releases");
    for (const r of releases) {
      if (r.draft || !/^[A-Za-z0-9._-]+$/.test(r.tag_name)) continue;
      const prefix = `https://github.com/${repo}/releases/download/${r.tag_name}/`;
      const manifest = r.assets?.find(
        (a: any) =>
          a.name === "download.json" &&
          a.browser_download_url === prefix + "download.json",
      );
      const archive = r.assets?.find(
        (a: any) =>
          a.name === "Bittrees-AI-macOS-arm64-development.zip" &&
          a.browser_download_url === prefix + a.name,
      );
      if (!manifest || !archive) continue;
      const m = await json(manifest.browser_download_url);
      if (
        m.format !== 1 ||
        m.application !== "Bittrees AI" ||
        m.architecture !== "arm64" ||
        !sha.test(m.sourceCommit) ||
        m.workflow !== `${repo}/.github/workflows/macos-download.yml` ||
        m.filename !== archive.name ||
        !/^[a-f0-9]{64}$/.test(m.sha256)
      )
        continue;
      if (m.sourceCommit === installed.sourceCommit)
        return { ...base, state: "current" };
      let comparison = await json(
        `${api}/compare/${installed.sourceCommit}...${m.sourceCommit}`,
      );
      // A newer release date alone must never offer a source downgrade or divergent build.
      if (comparison.status === "diverged") {
        const prs = await json(
          `${api}/commits/${installed.sourceCommit}/pulls?per_page=100`,
        );
        const merged =
          Array.isArray(prs) &&
          prs.find(
            (p: any) =>
              p.merged_at &&
              p.head?.sha === installed.sourceCommit &&
              sha.test(p.merge_commit_sha),
          );
        if (merged)
          comparison = await json(
            `${api}/compare/${merged.merge_commit_sha}...${m.sourceCommit}`,
          );
      }
      if (comparison.status !== "ahead") continue;
      const checks = await json(
        `${api}/commits/${m.sourceCommit}/check-runs?per_page=100`,
      );
      if (
        !required.every(
          (name) =>
            checks.check_runs
              ?.filter(
                (c: any) => c.name === name && c.app?.slug === "github-actions",
              )
              .sort((a: any, b: any) => b.id - a.id)[0]?.conclusion ===
            "success",
        )
      )
        continue;
      return {
        ...base,
        state: "available",
        tag: r.tag_name,
        source: m.sourceCommit,
        url: `https://github.com/${repo}/releases/tag/${r.tag_name}`,
      };
    }
    return { ...base, state: "current" };
  }
  return () => {
    if (cached && now() < until) return Promise.resolve(cached);
    if (pending) return pending;
    pending = check()
      .then((value) => {
        cached = value;
        until = now() + 6 * 60 * 60 * 1000;
        return value;
      })
      .catch(() => {
        cached = {
          state: "unavailable",
          checkedAt: new Date(now()).toISOString(),
        };
        until = now() + 15 * 60 * 1000;
        return cached;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
export const checkForUpdates = releaseChecker(async () => {
  if (process.env.BITTREES_DESKTOP !== "1") throw Error("Not a packaged app");
  return JSON.parse(
    await readFile(
      new URL("../../../../build-info.json", import.meta.url),
      "utf8",
    ),
  );
});
