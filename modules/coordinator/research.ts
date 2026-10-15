import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
// Operator-approved suppliers only. Catalog text is data, never executable instructions.
export const suppliers = [
  {
    host: "vilros.com",
    name: "Vilros",
    collection: "ai-compute",
    currency: "USD",
    region: "US",
  },
] as const;
const eligible =
  /\b(jetson|dgx|bitaxe|nerdqaxe|hailo)\b|raspberry pi.*(ai (hat|kit|camera)|llm kit)/i;
const excluded =
  /\b(case|cable|adapter|slides|lesson|book|sticker|heatsink)\b/i;
const uuid = (input: string) => {
  const h = createHash("sha256").update(input).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
async function json(url: string, request: typeof fetch) {
  const r = await request(url, {
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw Error("Supplier catalog unavailable");
  if (Number(r.headers.get("content-length")) > 4000000)
    throw Error("Catalog too large");
  const reader = r.body?.getReader();
  if (!reader) throw Error("Empty catalog");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 4000000) throw Error("Catalog too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function researchBatches(
  db: Database.Database,
  owner: string,
  create: (batch: unknown) => Promise<unknown>,
  authorize: () => Promise<void>,
  request: typeof fetch = fetch,
) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS marketplace_researched(owner TEXT NOT NULL,url TEXT NOT NULL,run_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(owner,url))",
  );
  await authorize();
  const catalog = await json(
    "https://mercado.bittrees.org/api/catalog",
    request,
  );
  if (!Array.isArray(catalog.items))
    throw Error("Marketplace catalog unavailable");
  const canonical = (url: string) => {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/$/, "");
  };
  const existing = new Set(
    catalog.items.flatMap((item: any) => {
      try {
        return [canonical(item.source_url)];
      } catch {
        return [];
      }
    }),
  );
  const runs: string[] = [];
  for (const vendor of suppliers) {
    await authorize();
    const cart = await json(`https://${vendor.host}/cart.js`, request);
    if (cart.currency !== vendor.currency)
      throw Error("Supplier currency changed; operator review required");
    for (let page = 1; page <= 4; page++) {
      await authorize();
      const data = await json(
        `https://${vendor.host}/products.json?limit=250&page=${page}`,
        request,
      );
      if (!Array.isArray(data.products))
        throw Error("Unexpected catalog format");
      for (const product of data.products) {
        if (runs.length >= 3) return runs; // Three proposals per scheduled discovery pass.
        if (
          typeof product.title !== "string" ||
          product.title.length > 160 ||
          !eligible.test(product.title) ||
          excluded.test(product.title) ||
          !/^[a-z0-9-]+$/.test(product.handle)
        )
          continue;
        const variant = product.variants?.find(
          (v: any) =>
            v.available === true &&
            /^\d+(\.\d{1,2})?$/.test(v.price) &&
            Number(v.price) > 0,
        );
        if (!variant) continue;
        const url = `https://${vendor.host}/products/${product.handle}`;
        if (existing.has(canonical(url))) continue;
        if (
          db
            .prepare(
              "SELECT 1 FROM marketplace_researched WHERE owner=? AND url=?",
            )
            .get(owner, url)
        )
          continue;
        // Fetch the individual product again: stale catalog entries cannot become proposals.
        await authorize();
        const fresh = await json(`${url}.json`, request);
        if (
          fresh.product?.id !== product.id ||
          !fresh.product.variants?.some(
            (v: any) =>
              v.id === variant.id &&
              v.available === true &&
              v.price === variant.price,
          )
        )
          continue;
        const time = new Date().toISOString(),
          id = uuid(`${owner}:${url}`);
        const evidence = {
          researchMethod: "agent",
          category: "Vendor",
          website: `https://${vendor.host}`,
          summary: `Public ${vendor.name} catalog lists ${product.title}.`,
          relevance: "Local AI hardware supplier for Mercado.",
          uncertainties:
            "Dealer terms, stock reservation, shipping and tax require confirmation.",
          fit: "high",
          evidence: "primary",
          sources: [{ url, retrievedAt: time }],
        };
        const batch = {
          id,
          crm: {
            candidates: [
              { ...evidence, kind: "organizations", name: vendor.name },
              {
                ...evidence,
                kind: "tasks",
                name: `Verify dealer terms: ${product.title}`.slice(0, 200),
                organizationIndex: 0,
              },
            ],
          },
          mercado: [
            {
              product: {
                product_id: vendor.collection,
                name: product.title,
                description: `${product.title}, offered by ${vendor.name}. Public vendor listing checked ${time.slice(0, 10)}; stock and fulfillment require confirmation.`,
                source_name: vendor.name,
                source_url: url,
                price: variant.price,
                currency: vendor.currency,
                price_checked: time.slice(0, 10),
              },
            },
          ],
        };
        await authorize();
        await create(batch); // Durable run before dedup marker; retries keep the same run ID.
        db.prepare(
          "INSERT OR IGNORE INTO marketplace_researched VALUES(?,?,?,?)",
        ).run(owner, url, id, Date.now());
        runs.push(id);
      }
      if (data.products.length < 250) break;
    }
  }
  return runs;
}
