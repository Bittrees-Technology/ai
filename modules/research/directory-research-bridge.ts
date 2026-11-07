import { createHash } from "node:crypto";
import { z } from "zod";
import { groundedDirectoryAnswer } from "./crypto-directory.js";
import { sourceURL } from "./public-pages.js";

const pair = z.strictObject({
  originalReceiptId: z.uuid(),
  lastRecordedRetryReceiptId: z.uuid(),
});
const item = pair.extend({
  reviewedResearchUrl: z.url({ protocol: /^https$/ }),
  historicalAttempts: z.int().min(0).max(3),
});
const request = z.strictObject({
  originalValidationRunId: z.uuid(),
  pairs: z.array(pair).length(9),
});
const manifest = z.strictObject({
  originalValidationRunId: z.uuid(),
  items: z.array(item).length(9),
});
const modelEvidence = z.strictObject({
  model: z.string().min(1).max(160),
  modelDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  answer: z.unknown(),
});

type Item = Readonly<z.infer<typeof item>>;
type Scope = Readonly<{
  digest: string;
  originalValidationRunId: string;
  items: readonly Item[];
}>;
type Host = {
  authorize(
    scope: Scope,
    item: Item,
    action: "source" | "model" | "release-evidence",
    signal: AbortSignal,
  ): Promise<boolean>;
  /** Atomically reserve this scope before I/O. A prior or uncertain reservation denies. */
  reserve(scope: Scope, signal: AbortSignal): Promise<boolean>;
  /** Fetch the exact reviewed HTTPS URL, without redirects or secondary fetches. */
  readSource(
    url: string,
    signal: AbortSignal,
  ): Promise<{ url: string; text: string }>;
  /** Use the approved pinned local model. Treat all evidence text as untrusted data. */
  analyze(
    source: Readonly<{ url: string; text: string }>,
    signal: AbortSignal,
  ): Promise<unknown>;
  allowedTags: readonly string[];
};

const sha256 = (input: string) =>
  createHash("sha256").update(input).digest("hex");

/** The manifest and digest come from trusted staging configuration, never the caller. */
export function createDirectoryResearchBridge(
  manifestJson: string,
  reviewedDigest: string,
  host: Host,
) {
  if (sha256(manifestJson) !== reviewedDigest)
    throw Error("Directory research manifest digest mismatch");
  const approved = manifest.parse(JSON.parse(manifestJson));
  const parents = new Map(
    approved.items.map((entry) => [
      entry.originalReceiptId,
      entry.lastRecordedRetryReceiptId,
    ]),
  );
  if (
    parents.size !== 9 ||
    new Set(parents.values()).size !== 9 ||
    [...parents.keys()].some((id) => [...parents.values()].includes(id))
  )
    throw Error("Directory research manifest has duplicate receipts");
  const items = approved.items.map((entry) => {
    const url = new URL(entry.reviewedResearchUrl);
    const normalized = sourceURL(entry.reviewedResearchUrl, [url.hostname]);
    if (url.hash)
      throw Error("Directory research manifest URL contains a fragment");
    return Object.freeze({ ...entry, reviewedResearchUrl: normalized.href });
  });
  const scope = Object.freeze({
    digest: reviewedDigest,
    originalValidationRunId: approved.originalValidationRunId,
    items: Object.freeze(items),
  });
  const tags = [...host.allowedTags];

  function review(raw: unknown) {
    const input = request.parse(raw);
    if (
      input.originalValidationRunId !== scope.originalValidationRunId ||
      new Set(input.pairs.map((entry) => entry.originalReceiptId)).size !== 9 ||
      input.pairs.some(
        (entry) =>
          parents.get(entry.originalReceiptId) !==
          entry.lastRecordedRetryReceiptId,
      )
    )
      throw Error("Directory research batch is outside the reviewed scope");

    return {
      scopeDigest: scope.digest,
      pairCount: scope.items.length,
      exhausted: scope.items.filter((entry) => entry.historicalAttempts === 3)
        .length,
    };
  }

  return {
    review,
    async research(raw: unknown, parentSignal: AbortSignal) {
      if (review(raw).exhausted)
        throw Error("Directory research retry budget exhausted");
      const signal = AbortSignal.any([
        parentSignal,
        AbortSignal.timeout(15 * 60_000),
      ]);
      const authorize = async (
        entry: Item,
        action: Parameters<Host["authorize"]>[2],
      ) => {
        signal.throwIfAborted();
        if (!(await host.authorize(scope, entry, action, signal)))
          throw Error("Directory research authorization unavailable");
        signal.throwIfAborted();
      };
      for (const entry of scope.items) await authorize(entry, "source");
      if (!(await host.reserve(scope, signal)))
        throw Error("Directory research batch already reserved or uncertain");

      const receipts = [];
      for (const entry of scope.items) {
        await authorize(entry, "source");
        const page = await host.readSource(
          entry.reviewedResearchUrl,
          AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
        );
        if (
          page.url !== entry.reviewedResearchUrl ||
          !page.text.trim() ||
          Buffer.byteLength(page.text) > 1_000_000
        )
          throw Error(
            "Directory research source did not match reviewed evidence",
          );
        const source = Object.freeze({
          url: page.url,
          text: page.text.slice(0, 14_000),
        });
        await authorize(entry, "model");
        const evidence = modelEvidence.parse(
          await host.analyze(source, signal),
        );
        const answer = groundedDirectoryAnswer(
          evidence.answer,
          source.text,
          tags,
        );
        receipts.push({
          originalReceiptId: entry.originalReceiptId,
          lastRecordedRetryReceiptId: entry.lastRecordedRetryReceiptId,
          url: source.url,
          sourceHash: sha256(source.text),
          model: evidence.model,
          modelDigest: evidence.modelDigest,
          answer,
        });
      }
      for (const entry of scope.items)
        await authorize(entry, "release-evidence");
      return { scopeDigest: scope.digest, receipts };
    },
  };
}
