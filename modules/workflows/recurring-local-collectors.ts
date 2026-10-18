import { statfs } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { canonical } from "../contracts/canonical-json.js";
import type { RecurringReceipt } from "./recurring.js";

export const localCollectorCapabilities = {
  "local.storage.inspect": "local.storage.inspect",
  "local.home-monitor.read": "local.home-monitor.read",
} as const;
const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const gib = 1024n ** 3n;
type StorageReader = (
  path: string,
  options: { bigint: true },
) => Promise<{ bavail: bigint; bsize: bigint; blocks: bigint }>;

/** Inspection only. This grants no cache deletion, application or repository operation. */
export async function inspectLocalStorage(
  signal: AbortSignal,
  reader: StorageReader = statfs,
  now = Date.now,
): Promise<RecurringReceipt> {
  signal.throwIfAborted();
  const stats = await reader("/System/Volumes/Data", { bigint: true });
  signal.throwIfAborted();
  if (
    stats.bavail < 0n ||
    stats.bsize <= 0n ||
    stats.blocks <= 0n ||
    stats.bavail > stats.blocks
  )
    throw Error("Storage measurement unavailable");
  const available = stats.bavail * stats.bsize,
    reserve = 20n * gib;
  const evidence = {
    scope: "APFS Data volume",
    measuredAt: now(),
    availableBytes: available.toString(),
    reserveBytes: reserve.toString(),
    belowReserve: available < reserve,
    availableGiBBucket: Number(available / gib),
    cleanupPerformed: false,
    nextAction:
      available < reserve
        ? "Reviewed safe-cache adapter or owner review required; do not remove work."
        : "No cleanup needed.",
  };
  return {
    state: "confirmed",
    observedAt: now(),
    fingerprint: hash({
      belowReserve: evidence.belowReserve,
      availableGiBBucket: evidence.availableGiBBucket,
    }),
    evidence,
  };
}

async function boundedJson(response: Response) {
  if (!response.ok || !response.body) throw Error("Local monitor unavailable");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 512 * 1024)
        throw Error("Local monitor result exceeds its bound");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function addresses(raw: unknown) {
  if (!Array.isArray(raw) || raw.length > 32)
    throw Error("Address evidence unavailable");
  return raw
    .map((value) => {
      if (
        !value ||
        typeof value !== "object" ||
        typeof value.interface !== "string" ||
        !/^[A-Za-z0-9._:-]{1,64}$/.test(value.interface) ||
        typeof value.address !== "string" ||
        !isIP(value.address) ||
        !Number.isInteger(value.prefix) ||
        value.prefix < 0 ||
        value.prefix > (isIP(value.address) === 4 ? 32 : 128)
      )
        throw Error("Address evidence invalid");
      return {
        interface: value.interface,
        address: value.address,
        prefix: value.prefix,
      };
    })
    .sort((a, b) => canonical(a).localeCompare(canonical(b)));
}
function latestEvent(raw: unknown) {
  if (!Array.isArray(raw) || raw.length > 1000)
    throw Error("Address event history unavailable");
  const events = raw
    .filter(
      (value) =>
        value &&
        typeof value === "object" &&
        Number.isFinite(value.time) &&
        typeof value.kind === "string",
    )
    .sort((a, b) => b.time - a.time);
  const last = events[0];
  return last
    ? {
        time: last.time,
        kind: ["baseline", "change"].includes(last.kind)
          ? last.kind
          : "unknown",
      }
    : null;
}

/** Fixed GET on an existing loopback service; projects address facts only. No SSH or writes. */
export async function readLocalHomeMonitor(
  signal: AbortSignal,
  request: typeof fetch = fetch,
  now = Date.now,
): Promise<RecurringReceipt> {
  const response = await request("http://127.0.0.1:8766/api/status", {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    headers: { accept: "application/json" },
  });
  const value = await boundedJson(response);
  signal.throwIfAborted();
  const time = now();
  if (
    !value ||
    typeof value !== "object" ||
    !Number.isFinite(value.updated) ||
    !value.hosts ||
    !value.monitor ||
    typeof value.monitor.stale !== "boolean" ||
    !Number.isFinite(value.monitor.age_seconds)
  )
    throw Error("Local monitor evidence incomplete");
  const age = time - value.updated * 1000;
  if (
    age < -1000 ||
    age > 150000 ||
    value.monitor.stale ||
    value.monitor.age_seconds > 150
  )
    return {
      state: "held",
      observedAt: time,
      fingerprint: hash({ reason: "local-monitor-stale" }),
      evidence: {
        reason: "Local monitor stale; current host addresses are unverified.",
      },
    };
  const hosts = ["pi-firewall", "acer-isolated"].map((name) => {
    const source = value.hosts[name];
    if (
      !source ||
      typeof source.reachable !== "boolean" ||
      !Number.isFinite(source.time)
    )
      throw Error("Host evidence incomplete");
    const fresh =
      time - source.time * 1000 >= -1000 && time - source.time * 1000 <= 150000;
    return {
      host: name,
      reachable: source.reachable,
      fresh,
      addresses:
        source.reachable && fresh ? addresses(source.addresses?.current) : [],
      latestAddressEvent: source.addresses
        ? latestEvent(source.addresses.events)
        : null,
    };
  });
  const current = hosts.every((host) => host.fresh);
  return {
    state: current ? "confirmed" : "held",
    observedAt: time,
    fingerprint: hash({ hosts }),
    evidence: {
      scope: "Existing Home Server Monitor",
      monitorFresh: true,
      hosts,
      sshChangesPerformed: false,
      networkScansPerformed: false,
      limitations:
        "Reachability/address evidence only; any SSH HostName update still requires separate reviewed authority and pinned-host verification.",
    },
  };
}
