import { createHash } from "node:crypto";
import { z } from "zod";
import { canonical } from "../contracts/canonical-json.js";
import type { RecurringReceipt } from "./recurring.js";

const percent = z.number().finite().min(0).max(100);
const sectors = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const readingSchema = z.object({
  var: z.object({ used_percent: percent }),
  data: z.object({ used_percent: percent }),
  smart_passed: z.boolean(),
  temperature_c: z.number().int().min(-20).max(150),
  reallocated_sectors: sectors,
  pending_sectors: sectors,
  uncorrectable_sectors: sectors,
  smb_active: z.boolean(),
  logrotate_result: z.string().max(100),
});
const envelopeSchema = z.object({
  checked_at: z.iso.datetime({ offset: true }),
  issues: z.array(z.string().max(100)).max(32),
  readings: z.unknown(),
});
export type MyCloudObservation = {
  reachable: boolean;
  temperatureC: number | null;
  varUsedPercent: number | null;
  dataUsedPercent: number | null;
  badSectors: {
    reallocated: number;
    pending: number;
    uncorrectable: number;
  } | null;
  issues: string[];
};
export type MyCloudHealthResult = {
  receipt: RecurringReceipt;
  observation: MyCloudObservation;
  notifications: string[];
};

/** Projects only reviewed health facts. Never returns stderr, credentials or arbitrary source text.
 * The caller must persist observations in its encrypted state only after accepting the receipt.
 * This parser grants no process, filesystem, SSH or network authority.
 */
export function myCloudHealthReceipt(
  raw: string,
  previous: MyCloudObservation | undefined,
  now = Date.now(),
): MyCloudHealthResult {
  if (Buffer.byteLength(raw) > 32 * 1024)
    throw Error("NAS evidence exceeds its bound");
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw Error("NAS evidence is not valid JSON");
  }
  const parsedEnvelope = envelopeSchema.safeParse(decoded);
  if (!parsedEnvelope.success)
    throw Error("NAS evidence envelope is incomplete");
  const envelope = parsedEnvelope.data;
  const checkedAt = Date.parse(envelope.checked_at);
  if (checkedAt > now + 1000 || now - checkedAt > 120000)
    throw Error("NAS evidence is stale or has an invalid clock");
  const unreachable = envelope.issues.includes("nas_unreachable");
  let observation: MyCloudObservation;
  if (unreachable) {
    observation = {
      reachable: false,
      temperatureC: null,
      varUsedPercent: null,
      dataUsedPercent: null,
      badSectors: null,
      issues: [
        ...new Set(["nas_unreachable", ...(previous?.issues ?? [])]),
      ].sort(),
    };
  } else {
    // Missing SMART counters/temperature are uncertainty, never a healthy default.
    const parsedReadings = readingSchema.safeParse(envelope.readings);
    if (!parsedReadings.success)
      throw Error("NAS health readings are incomplete");
    const r = parsedReadings.data;
    const issues: string[] = [];
    if (!r.smart_passed) issues.push("smart_failure");
    if (r.temperature_c >= 65) issues.push("disk_temperature_65C_or_above");
    if (r.var.used_percent >= 80) issues.push("var_space_low");
    if (r.data.used_percent >= 90) issues.push("data_space_low");
    if (!r.smb_active) issues.push("file_sharing_down");
    if (r.logrotate_result !== "success") issues.push("log_rotation_failed");
    for (const key of [
      "reallocated_sectors",
      "pending_sectors",
      "uncorrectable_sectors",
    ] as const)
      if (r[key] > 0) issues.push(key);
    observation = {
      reachable: true,
      temperatureC: r.temperature_c,
      varUsedPercent: r.var.used_percent,
      dataUsedPercent: r.data.used_percent,
      badSectors: {
        reallocated: r.reallocated_sectors,
        pending: r.pending_sectors,
        uncorrectable: r.uncorrectable_sectors,
      },
      issues: issues.sort(),
    };
  }
  const notifications = observation.issues
    .filter((issue) => !previous?.issues.includes(issue))
    .map((issue) => `new:${issue}`);
  if (previous) {
    // Unreachability cannot prove that an earlier disk/service problem recovered.
    for (const issue of previous.issues)
      if (!observation.issues.includes(issue) && observation.reachable)
        notifications.push(`recovered:${issue}`);
    if (observation.reachable && previous.reachable) {
      if (
        observation.temperatureC! >= 65 &&
        observation.temperatureC! > previous.temperatureC!
      )
        notifications.push("worsened:temperature");
      for (const [field, threshold] of [
        ["varUsedPercent", 80],
        ["dataUsedPercent", 90],
      ] as const)
        if (
          observation[field]! >= threshold &&
          Math.floor(observation[field]!) > Math.floor(previous[field]!)
        )
          notifications.push(`worsened:${field}`);
      for (const key of ["reallocated", "pending", "uncorrectable"] as const)
        if (observation.badSectors![key] > previous.badSectors![key])
          notifications.push(`worsened:${key}`);
    }
  }
  const fingerprint = createHash("sha256")
    .update(canonical(observation))
    .digest("hex");
  return {
    receipt: {
      state: "confirmed",
      observedAt: checkedAt,
      fingerprint,
      evidence: {
        scope: "Existing MyCloud read-only health checker",
        observation,
        notifications: [...new Set(notifications)].sort(),
        knownLimitations: [
          "64 C is the previously reported temperature baseline; initial and unchanged readings below65 C are quiet.",
          "SMART success does not establish a complete independent backup or extended disk test.",
          "No credentials, shares, mounts, services, network configuration or transfers changed.",
        ],
      },
    },
    observation,
    notifications: [...new Set(notifications)].sort(),
  };
}
