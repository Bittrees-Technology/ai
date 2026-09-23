import React, { useEffect, useRef, useState } from "react";
import type { ImportJob } from "../../modules/models/jobs.js";
type Api = (
  path: string,
  method?: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<any>;
const activeStates = new Set([
  "selecting",
  "reviewing",
  "downloading",
  "installing",
  "reconciling",
]);
const bytes = (n: number) => (n / 1024 ** 3).toFixed(2) + " GiB";
const stateLabels: Record<string, string> = {
  selecting: "Selecting and verifying local files",
  reviewing: "Checking repository metadata",
  download_review: "Ready for download review",
  downloading: "Downloading and verifying",
  staged: "Ready for installation review",
  installing: "Installing in local Ollama",
  reconciling: "Checking the original installation",
  installed: "Installed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  uncertain: "Outcome needs checking",
  failed: "Could not complete this operation",
};
const errorLabels: Record<string, string> = {
  CAPACITY: "The files exceed a memory, size or free-space limit.",
  REVIEW_EXPIRED: "The review expired; begin a fresh review.",
  UNSUPPORTED_FILE: "This file type or repository code is not supported.",
  CHANGED_ARTIFACT: "The file no longer matches its review or expected hash.",
  UNSUPPORTED_ARCHITECTURE: "Ollama does not support this model architecture.",
  DOWNLOAD_DENIED: "The repository or download could not be accessed.",
  RUNTIME_REJECTED: "Local Ollama could not confirm this installation.",
  IMPORT_FAILED: "Check the source files and local runtime before retrying.",
  INVALID_ARTIFACT: "A model artifact did not pass validation.",
};
export function ModelImportControls({
  api,
  onError,
  onInstalled,
}: {
  api: Api;
  onError: (e: unknown) => void;
  onInstalled: () => void;
}) {
  const [items, setItems] = useState<ImportJob[]>([]),
    [busy, setBusy] = useState(false),
    [license, setLicense] = useState(""),
    [format, setFormat] = useState("runtime_default"),
    [repo, setRepo] = useState(""),
    [revision, setRevision] = useState(""),
    [files, setFiles] = useState("");
  const live = useRef(true),
    installed = useRef(new Set<string>()),
    working = useRef(false);
  async function refresh() {
    const data = await api("/v1/imports");
    if (!live.current) return;
    setItems(data.items);
    const current = new Set<string>(
      data.items
        .filter((j: ImportJob) => j.state === "installed")
        .map((j: ImportJob) => j.id),
    );
    if ([...current].some((id) => !installed.current.has(id))) onInstalled();
    installed.current = current;
  }
  useEffect(() => {
    live.current = true;
    let running = false;
    const poll = async () => {
      if (running || document.hidden) return;
      running = true;
      try {
        await refresh();
      } catch (e) {
        if (live.current) onError(e);
      } finally {
        running = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      live.current = false;
      clearInterval(timer);
    };
  }, []);
  async function act(fn: () => Promise<unknown>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      onError(e);
    } finally {
      working.current = false;
      if (live.current) setBusy(false);
    }
  }
  const running = busy || items.some((job) => activeStates.has(job.state));
  return (
    <section>
      <h3>Import a model</h3>
      <p>
        Import compatible GGUF files or a complete Safetensors file set.
        Repository code and pickle files are rejected. Imported models have no
        extra permissions or tools; cloud fallback remains off. Installation
        does not prove model quality or compatibility with every task.
      </p>
      <p className="hint">
        Temporary copies are removed after a confirmed installation,
        cancellation or failed operation. Expired reviews and interrupted work
        are cleaned up while idle. Import history, original files and installed
        Ollama models are kept. Uncertain installations keep their files until
        checked or explicitly deleted.
      </p>
      <label htmlFor="import-format">Prompt format</label>
      <select
        id="import-format"
        value={format}
        disabled={running}
        onChange={(e) => setFormat(e.target.value)}
      >
        {["runtime_default", "chatml", "qwen3", "llama3"].map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
      <details>
        <summary>Local files on this Mac</summary>
        <label htmlFor="import-license">
          License or usage terms you reviewed
        </label>
        <textarea
          id="import-license"
          maxLength={2000}
          value={license}
          disabled={running}
          onChange={(e) => setLicense(e.target.value)}
        />
        <button
          disabled={running || !license.trim()}
          onClick={() =>
            void act(() =>
              api("/v1/imports/local", "POST", {
                license,
                promptFormat: format,
              }),
            )
          }
        >
          Select local files and prepare review
        </button>
        <p>
          A macOS file picker opens. File selection copies and verifies the
          selected artifacts locally; installing in Ollama requires a separate
          review below.
        </p>
      </details>
      <details>
        <summary>Public Hugging Face repository</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(() =>
              api("/v1/imports/huggingface", "POST", {
                repo,
                revision,
                files: files
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean),
                promptFormat: format,
              }),
            );
          }}
        >
          <label htmlFor="import-repo">Repository (owner/name)</label>
          <input
            id="import-repo"
            required
            value={repo}
            disabled={running}
            onChange={(e) => setRepo(e.target.value)}
          />
          <label htmlFor="import-revision">
            Exact commit (40 lowercase hexadecimal characters)
          </label>
          <input
            id="import-revision"
            required
            pattern="[a-f0-9]{40}"
            value={revision}
            disabled={running}
            onChange={(e) => setRevision(e.target.value)}
          />
          <label htmlFor="import-files">Artifact paths, one per line</label>
          <textarea
            id="import-files"
            required
            value={files}
            disabled={running}
            onChange={(e) => setFiles(e.target.value)}
          />
          <p>
            This contacts Hugging Face for metadata. Downloads occur only after
            you approve their sizes, revision and license below. Gated/private
            repositories are not connected by this interface.
          </p>
          <button disabled={running}>Review download</button>
        </form>
      </details>
      {items.map((job) => (
        <article className="model-import-job" key={job.id}>
          <h4>{job.review?.model ?? job.download?.repo ?? "Model import"}</h4>
          <p role="status">
            {stateLabels[job.state]}
            {job.error && errorLabels[job.error]
              ? ` · ${errorLabels[job.error]}`
              : ""}
          </p>
          {job.stagingCleanup?.state === "released" && (
            <p>Temporary import files removed. Import history is retained.</p>
          )}
          {job.stagingCleanup?.state === "pending" && (
            <p role="status">Cleaning up temporary import files…</p>
          )}
          {job.stagingCleanup?.state === "retry" && (
            <div>
              <p>
                Temporary files could not be removed. The import outcome is
                unchanged. Cleanup will retry while idle.
              </p>
              <button
                disabled={running}
                onClick={() =>
                  void act(() =>
                    api(`/v1/imports/${job.id}/cleanup`, "POST", {}),
                  )
                }
              >
                Retry temporary-file cleanup
              </button>
            </div>
          )}
          {job.download && (
            <details open={job.state === "download_review"}>
              <summary>Download review</summary>
              <p>
                {job.download.repo} · commit {job.download.revision}
              </p>
              <p>License: {job.download.license}</p>
              <p>
                Prompt format: {job.download.promptFormat}. Expires{" "}
                {new Date(job.download.expiresAt).toLocaleString()}.
              </p>
              <ul>
                {job.download.files.map((file) => (
                  <li key={file.name}>
                    {file.name} · {bytes(file.size)} · SHA-256:{" "}
                    {file.sha256 ??
                      "will be computed; repository metadata supplies no hash"}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {job.review && (
            <details open={job.state === "staged"}>
              <summary>Installation review</summary>
              <p>
                {job.review.format} · {bytes(job.review.totalBytes)} · prompt
                format {job.review.promptFormat}
              </p>
              <p>
                License: {job.review.provenance.license}. Expires{" "}
                {new Date(job.review.expiresAt).toLocaleString()}.
              </p>
              <ul>
                {job.review.files.map((file) => (
                  <li key={file.name}>
                    {file.name} · {bytes(file.size)} · SHA-256: {file.sha256}
                  </li>
                ))}
              </ul>
              <p>
                These exact files will be sent to local Ollama. Compatibility
                and output quality still need testing.
              </p>
            </details>
          )}
          {job.state === "download_review" && (
            <button
              disabled={running}
              onClick={() =>
                void act(() =>
                  api(`/v1/imports/${job.id}/download`, "POST", {
                    digest: job.download!.digest,
                  }),
                )
              }
            >
              Approve and download these files
            </button>
          )}
          {job.state === "staged" && (
            <button
              disabled={running}
              onClick={() =>
                void act(() =>
                  api(`/v1/imports/${job.id}/install`, "POST", {
                    digest: job.review!.reviewDigest,
                  }),
                )
              }
            >
              Approve installation in local Ollama
            </button>
          )}
          {job.state === "uncertain" && (
            <>
              <p>
                Installation may have completed. Check the original model before
                starting a replacement import.
              </p>
              <button
                disabled={running}
                onClick={() =>
                  void act(() =>
                    api(`/v1/imports/${job.id}/reconcile`, "POST", {}),
                  )
                }
              >
                Check installed outcome
              </button>
            </>
          )}
          {activeStates.has(job.state) && (
            <button
              disabled={busy}
              onClick={() =>
                void act(() => api(`/v1/imports/${job.id}/cancel`, "POST", {}))
              }
            >
              Cancel this operation
            </button>
          )}
          {!activeStates.has(job.state) && (
            <button
              disabled={running}
              onClick={() => {
                if (
                  window.confirm(
                    "Delete this local import history and staged files? This cannot cancel an uncertain runtime creation or uninstall a model already in Ollama.",
                  )
                )
                  void act(() =>
                    api(`/v1/imports/${job.id}`, "DELETE", undefined, {
                      "X-Confirm-Delete": "local-import-record-and-files",
                    }),
                  );
              }}
            >
              Delete local import files and history
            </button>
          )}
          {job.installation && (
            <details>
              <summary>Verified installation details</summary>
              <p>
                Architecture: {job.installation.architecture} · Quantization:{" "}
                {job.installation.quantization} · Parameters:{" "}
                {job.installation.parameterSize} ·{" "}
                {bytes(job.installation.installedBytes)}
              </p>
              <p>Installed model digest: {job.installation.modelDigest}</p>
            </details>
          )}
          {job.state === "installed" && (
            <p>
              Installed. Select this model above to create a profile, then test
              it on a synthetic task.
            </p>
          )}
          {job.state === "interrupted" && (
            <p>
              The previous operation stopped. It will not restart automatically.
              Delete its local files/history and begin again after reviewing the
              source.
            </p>
          )}
        </article>
      ))}
    </section>
  );
}
