import { z } from "zod";
import { publicPage, sourceURL } from "./public-pages.js";

export const supplierResearchSchema = z.strictObject({
  version: z.literal(1),
  urls: z.array(z.string().url().max(300)).min(1).max(16),
});
export const supplierAnswer = z.strictObject({
  excerpts: z
    .array(
      z.strictObject({
        sourceId: z.string(),
        quote: z.string().min(1).max(300),
      }),
    )
    .max(4),
});
type Source = { id: string; url: string; text: string; retrievedAt: string };
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const supplierHost = (url: string) =>
  new URL(url).hostname.replace(/^www\./, "");
/** Metadata is prepared by CRM from an owner-reviewed supplier child, never from model prose. */
export class SupplierReview {
  private cache = new Map<string, Source>();
  constructor(
    private fetchPage = publicPage,
    private now = () => Date.now(),
  ) {}
  async sources(raw: unknown, scope: string, signal: AbortSignal) {
    const input = supplierResearchSchema.parse(raw);
    const urls = [...new Set(input.urls)];
    const supplier = supplierHost(urls[0]!);
    const hosts = [...new Set(urls.map((url) => new URL(url).hostname))];
    for (const raw of urls) {
      const url = sourceURL(raw, hosts);
      if (url.search || url.hash || supplierHost(raw) !== supplier)
        throw new Error(
          "Supplier sources must stay within one approved supplier and have no query parameters.",
        );
    }
    const sources: Source[] = [],
      unavailable: string[] = [];
    for (const url of urls) {
      signal.throwIfAborted();
      const key = JSON.stringify([scope, supplier, url]);
      const cached = this.cache.get(key);
      if (cached && this.now() - Date.parse(cached.retrievedAt) < 3600000) {
        sources.push({ ...cached, id: `source-${sources.length + 1}` });
        continue;
      }
      this.cache.delete(key);
      try {
        const page = await this.fetchPage(
          url,
          hosts,
          AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        );
        if (supplierHost(page.url) !== supplier || !page.text.trim())
          throw Error("Source unavailable");
        const source = {
          id: `source-${sources.length + 1}`,
          url: page.url,
          text: normalize(page.text).slice(0, 1600),
          retrievedAt: new Date(this.now()).toISOString(),
        };
        if (this.cache.size >= 100)
          this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, source);
        sources.push(source);
      } catch {
        signal.throwIfAborted();
        unavailable.push(url);
      }
    }
    if (!sources.length)
      throw new Error("Supplier pages unavailable; research remains open.");
    return { sources, unavailable };
  }
}
export function renderSupplierReview(
  raw: unknown,
  sources: Source[],
  unavailable: string[],
) {
  const answer = supplierAnswer.parse(raw);
  if (!answer.excerpts.length)
    throw new Error(
      "No useful supplier evidence selected; research remains open.",
    );
  const excerpts = [
    ...new Set(
      answer.excerpts.map((item) => {
        const source = sources.find((s) => s.id === item.sourceId);
        if (!source || !normalize(source.text).includes(normalize(item.quote)))
          throw new Error(
            "Supplier quotation did not match its source; no result saved.",
          );
        return `${source.url}\nRetrieved ${source.retrievedAt}\n“${normalize(item.quote)}”`;
      }),
    ),
  ];
  const note = [
    "PUBLIC SUPPLIER EVIDENCE — CONFIRMATIONS STILL OPEN",
    "The local model selected exact excerpts from the approved public pages. These are supplier-published claims, not confirmation of negotiated terms or stock reserved for us. Cached pages retain their original retrieval time (up to one hour).",
    excerpts.join("\n\n"),
    `Reviewed ${sources.length} readable pages; ${unavailable.length} unavailable. Excerpts are a partial evidence inventory, not a complete verification.`,
    "Still unresolved: dealer eligibility/pricing, actual stock, dispatch origin, Nevada/Portugal fulfillment, shipping/tax, warranty and image/feed rights unless separately confirmed. Product variants and conflicting policies need reconciliation. Original supplier confirmation tasks remain open. No outreach or purchases were performed.",
  ].join("\n\n");
  if (note.length > 3500)
    throw new Error(
      "Supplier evidence note exceeds CRM size; research remains open.",
    );
  return note;
}
