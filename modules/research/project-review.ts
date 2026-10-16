import { z } from "zod";

export const groundedReviewSchema = z.strictObject({
  canComplete: z.boolean(),
  excerpts: z
    .array(
      z.strictObject({
        sourceId: z.string(),
        quote: z.string().min(1).max(500),
      }),
    )
    .max(4),
});
type ReviewSource = { id: string; text: string };
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Task claims remain unverified references. Never turn model prose into evidence. */
export function reviewSources(
  description: string,
  context: string,
): ReviewSource[] {
  const claims = [
    ...description.matchAll(/^Saved source claim:\s*(.+)$/gm),
  ].map((m) => m[1]!);
  const sources: ReviewSource[] = (claims.length ? claims : [description]).map(
    (text, i) => ({ id: `task-${i + 1}`, text: norm(text).slice(0, 3000) }),
  );
  // Context is already restricted to explicit links. A truncated JSON string is
  // not usable structured evidence; the task's own supplied claims remain usable.
  try {
    const parsed = JSON.parse(context);
    for (const record of parsed.records ?? []) {
      if (typeof record.id === "string" && record.data)
        sources.push({
          id: record.id,
          text: JSON.stringify(record.data).slice(0, 3000),
        });
    }
  } catch {
    /* Missing evidence stays missing. */
  }
  let remaining = 6000;
  return sources.slice(0, 8).flatMap((source) => {
    const text = source.text.slice(0, remaining);
    remaining -= text.length;
    return text ? [{ ...source, text }] : [];
  });
}

export function renderGroundedReview(
  raw: unknown,
  sources: ReviewSource[],
  investorReview = false,
) {
  const result = groundedReviewSchema.parse(raw);
  if (!result.canComplete)
    throw new Error(
      "Task needs review: cannot complete this as a review of supplied records.",
    );
  const excerpts = result.excerpts.map((item) => {
    const source = sources.find((s) => s.id === item.sourceId);
    if (!source || !norm(source.text).includes(norm(item.quote)))
      throw new Error(
        "Review evidence did not match the supplied source; no result saved.",
      );
    return `[${source.id}] ${norm(item.quote)}`;
  });
  return [
    "REVIEW OF SUPPLIED RECORDS — NOT INDEPENDENT VERIFICATION",
    "The local model selected the following verbatim excerpts. They are supplied claims, not newly verified facts; no websites were fetched by this task.",
    excerpts.length
      ? excerpts.join("\n\n")
      : "No usable source excerpt was selected. Evidence is insufficient.",
    investorReview
      ? "Evidence gaps: This review does not establish current role, personal US location, Bitcoin/leverage mandate, Portugal/Luxembourg scope, vehicle eligibility or ticket capacity. Use the source-backed qualification workflow for those checks. No investor qualification label was changed."
      : "Evidence gaps: Currency, accuracy and completeness of these supplied records are not independently verified. No linked profile or permission was changed.",
    investorReview
      ? "Next steps: verify the named person's current biography and obtain an explicit allocation-policy source for missing requirements. Questions remain open; no outreach was performed."
      : "Next steps: resolve missing or conflicting evidence at its source before relying on these excerpts. No outside action was performed.",
  ].join("\n\n");
}
