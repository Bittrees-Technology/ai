import { z } from "zod";

export const acerMaxAgeMs = 300000;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
/** Only identity digests cross this interface. Native machine/account/path configuration
 * remains private and must be pinned by the injected trusted transport and authority. */
export const acerBindingSchema = z.strictObject({
  sourceId: z.literal("acer_chat_mail_aggregate"),
  hostIdentitySha256: sha,
  helperSha256: sha,
  contractSha256: sha,
});
export type AcerSourceBinding = z.infer<typeof acerBindingSchema>;
export type AcerAggregateCheck = Readonly<{
  id: "acer_aggregate";
  binding: Readonly<AcerSourceBinding>;
  timeoutMs: 22000;
  maxBytes: 4096;
}>;
/** No command, account, URL or caller arguments are selectable here. */
export type AcerSourceTransport = (
  check: AcerAggregateCheck,
  signal: AbortSignal,
) => Promise<{ exitCode: number; output: Uint8Array }>;
const status = z.enum(["healthy", "disabled", "degraded", "unavailable"]);
const age = z.number().int().safe().nonnegative();
const component = z.strictObject({
  component: z.enum(["inbound", "outbound"]),
  status,
  reason: z
    .enum([
      "timer_not_enabled_active",
      "health_run_not_successful_idle",
      "observer_unavailable",
      "matching_fresh_aggregate_unavailable",
    ])
    .optional(),
  reportAgeMs: age.optional(),
  workerHeartbeatAgeMs: age.nullable().optional(),
});
export const acerAggregateSchema = z
  .strictObject({
    version: z.literal(1),
    status,
    components: z.array(component).length(2),
    readOnly: z.literal(true),
    workerStarted: z.literal(false),
    mailSent: z.literal(false),
  })
  .superRefine((r, ctx) => {
    if (new Set(r.components.map((c) => c.component)).size !== 2)
      ctx.addIssue({
        code: "custom",
        message: "Exact unique components required",
      });
    const derived =
      ["unavailable", "degraded", "disabled"].find((s) =>
        r.components.some((c) => c.status === s),
      ) ?? "healthy";
    if (r.status !== derived)
      ctx.addIssue({
        code: "custom",
        message: "Contradictory aggregate status",
      });
    for (const c of r.components)
      if (
        c.status === "healthy" &&
        (c.reason !== undefined ||
          c.reportAgeMs === undefined ||
          c.workerHeartbeatAgeMs == null ||
          c.reportAgeMs > acerMaxAgeMs ||
          c.workerHeartbeatAgeMs > acerMaxAgeMs)
      )
        ctx.addIssue({
          code: "custom",
          message: "Healthy requires two independently fresh ages",
        });
  });
export type AcerAggregate = z.infer<typeof acerAggregateSchema>;
export function acerFresh(report: AcerAggregate, elapsedMs: number) {
  return (
    Number.isSafeInteger(elapsedMs) &&
    elapsedMs >= 0 &&
    report.status === "healthy" &&
    report.components.every(
      (c) =>
        c.status === "healthy" &&
        c.reportAgeMs !== undefined &&
        c.workerHeartbeatAgeMs != null &&
        c.reportAgeMs + elapsedMs <= acerMaxAgeMs &&
        c.workerHeartbeatAgeMs + elapsedMs <= acerMaxAgeMs,
    )
  );
}
/** Reject ambiguous duplicate JSON keys (including escaped equivalents) and
 * excessive nesting before schema validation. JSON.parse still validates grammar. */
function uniqueJson(text: string): unknown {
  const stack: { kind: string; keys: Set<string> }[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      const start = i++;
      for (; i < text.length; i++) {
        if (text[i] === "\\") {
          i++;
          continue;
        }
        if (text[i] === '"') break;
      }
      if (i >= text.length) throw Error();
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next]!)) next++;
      if (text[next] === ":") {
        const frame = stack.at(-1);
        if (frame?.kind !== "{") throw Error();
        const key = JSON.parse(text.slice(start, i + 1)) as string;
        if (frame.keys.has(key)) throw Error();
        frame.keys.add(key);
      }
    } else if (char === "{" || char === "[") {
      stack.push({ kind: char, keys: new Set() });
      if (stack.length > 32) throw Error();
    } else if (char === "}" || char === "]") {
      if (stack.pop()?.kind !== (char === "}" ? "{" : "[")) throw Error();
    }
  }
  if (stack.length) throw Error();
  return JSON.parse(text);
}
/** Generic failures never echo raw source values or private unknown fields. */
export function parseAcerAggregate(
  output: Uint8Array,
  exitCode: number,
): AcerAggregate {
  try {
    if (
      !(output instanceof Uint8Array) ||
      output.byteLength > 4096 ||
      ![0, 2].includes(exitCode)
    )
      throw Error();
    const report = acerAggregateSchema.parse(
      uniqueJson(new TextDecoder("utf-8", { fatal: true }).decode(output)),
    );
    if ((exitCode === 0) !== (report.status === "healthy")) throw Error();
    // Normalize only after exact unique membership has been validated.
    report.components.sort((a, b) => a.component.localeCompare(b.component));
    return report;
  } catch {
    throw Error("Invalid or unavailable Acer aggregate");
  }
}
export const acerStoredResultSchema = z
  .strictObject({
    kind: z.literal("acer"),
    available: z.boolean(),
    bindingSha256: sha,
    report: acerAggregateSchema.optional(),
    failure: z
      .enum(["invalid_response", "source_unavailable", "clock_held"])
      .optional(),
  })
  .superRefine((r, ctx) => {
    if (
      (r.report !== undefined) === (r.failure !== undefined) ||
      (r.available && (!r.report || !acerFresh(r.report, 0)))
    )
      ctx.addIssue({
        code: "custom",
        message: "Bounded Acer evidence required",
      });
  });
export type AcerStoredResult = z.infer<typeof acerStoredResultSchema>;
