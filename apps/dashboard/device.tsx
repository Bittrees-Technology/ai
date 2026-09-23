import { ExecutionSettings } from "./execution-limits.js";
import React, { useEffect, useState } from "react";
import type { DeviceStatus } from "../companion/device.js";
const size = (bytes: number) => (bytes / 1024 ** 3).toFixed(1) + " GiB";
export function DeviceResources({
  api,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
}) {
  const [status, setStatus] = useState<DeviceStatus | null>(null),
    [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let active = true,
      running = false;
    const refresh = async () => {
      if (running || document.hidden) return;
      running = true;
      try {
        const next = await api("/v1/device");
        if (active) {
          setStatus(next);
          setUnavailable(false);
        }
      } catch {
        if (active) {
          setStatus(null);
          setUnavailable(true);
        }
      } finally {
        running = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return (
    <section>
      <h3>Device resources</h3>
      {!status ? (
        <p role="status">
          {unavailable
            ? "Device status is unavailable. Check that the companion is running."
            : "Reading device status…"}
        </p>
      ) : (
        <>
          <dl>
            <dt>System</dt>
            <dd>
              {status.platform === "darwin" ? "macOS" : status.platform} ·{" "}
              {status.architecture} · {status.logicalProcessors} logical
              processors
            </dd>
            <dt>Physical memory</dt>
            <dd>
              {size(status.memory.totalBytes)} total ·{" "}
              {size(status.memory.freeBytes)} currently free
            </dd>
            <dt>Companion memory</dt>
            <dd>
              {size(status.memory.companionBytes)} · excludes Ollama and other
              apps
            </dd>
            <dt>Free space on the data volume</dt>
            <dd>
              {status.diskFreeBytes === null
                ? "Unavailable"
                : size(status.diskFreeBytes)}
            </dd>
            <dt>Import limits</dt>
            <dd>
              {size(status.limits.importFileBytes)} per file;{" "}
              {size(
                Math.min(
                  status.limits.importTotalBytes,
                  status.limits.importMemoryBytes,
                ),
              )}{" "}
              total for this device
            </dd>
            <dt>Local generation</dt>
            <dd>
              {status.execution
                ? "Controlled by the local execution limits below."
                : `${status.limits.parallelGenerations} task(s) at once.`}{" "}
              Cloud fallback is off.
            </dd>
          </dl>
          {status.execution && (
            <ExecutionSettings api={api} status={status.execution} />
          )}
          <p>
            Free memory is a changing system snapshot, not a guarantee that a
            model will fit. Import limits are conservative file-size checks;
            runtime memory also depends on the model and context. Keep space for
            staged files and runtime copies.
          </p>
          <p>
            Updated {new Date(status.sampledAt).toLocaleTimeString()}. Refreshes
            every 10 seconds while this page is visible.
          </p>
        </>
      )}
    </section>
  );
}
