import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
// Fixed public sources only; catalog text never grants authority or executes instructions.
export const suppliers = [
  {
    host: "serverdepotus.com",
    name: "Server Depot US",
    currency: "USD",
    region: "US",
    adapter: "shopify",
  },
  {
    host: "mercadominero.com.mx",
    name: "Mercado Minero",
    currency: "MXN",
    region: "Mexico",
    adapter: "shopify",
  },
  {
    host: "dtvelectronics.com",
    name: "DTV Electronics",
    currency: "USD",
    region: "UK",
    adapter: "woo",
  },
  {
    host: "bitcoinmerch.com",
    name: "Bitcoin Merch",
    currency: "USD",
    region: "US",
    adapter: "shopify",
  },
  {
    host: "www.noxar.mx",
    name: "NOXAR",
    currency: "MXN",
    region: "Mexico",
    adapter: "shopify",
  },
  {
    host: "bitshopper.de",
    name: "bitshopper",
    currency: "EUR",
    region: "Germany",
    adapter: "woo",
  },
  {
    host: "vilros.com",
    name: "Vilros",
    currency: "USD",
    region: "US",
    adapter: "shopify",
  },
  {
    host: "thepihut.com",
    name: "The Pi Hut",
    currency: "GBP",
    region: "UK",
    adapter: "shopify",
  },
  {
    host: "shop.pimoroni.com",
    name: "Pimoroni",
    currency: "GBP",
    region: "UK",
    adapter: "shopify",
  },
  {
    host: "miners.de",
    name: "Miners.de",
    currency: "EUR",
    region: "Germany",
    adapter: "shopify",
  },
] as const;
export const RESEARCH_PRODUCT_LIMIT = 20;
export const PRODUCTS_PER_VENDOR = 3;
export const PRODUCTS_PER_BATCH = 10; // One organization and linked task per offer: CRM permits 20 candidates.
// Business contact pages are primary evidence; no inferred personal contacts.
export const vendorContacts: Record<string, { url: string; email?: string }> = {
  "serverdepotus.com": {
    url: "https://serverdepotus.com/pages/contact-us",
    email: "sales@serverdepotus.com",
  },
  "mercadominero.com.mx": {
    url: "https://mercadominero.com.mx/pages/nosotros",
    email: "contacto@mercadominero.com.mx",
  },
  "dtvelectronics.com": {
    url: "https://dtvelectronics.com/contact-us/",
    email: "info@dtvelectronics.com",
  },
  "bitcoinmerch.com": {
    url: "https://bitcoinmerch.com",
    email: "support@bitcoinmerch.com",
  },
  "www.noxar.mx": { url: "https://www.noxar.mx/pages/nosotros" },
  "bitshopper.de": {
    url: "https://www.bitshopper.de/en/legal-topics/privacy-and-data-protection/",
    email: "info@bitshopper.de",
  },
  "vilros.com": { url: "https://vilros.com/pages/contact-us" },
  "thepihut.com": {
    url: "https://business.thepihut.com/",
    email: "business@thepihut.com",
  },
  "shop.pimoroni.com": { url: "https://shop.pimoroni.com/pages/contact-us" },
  "miners.de": {
    url: "https://miners.de/pages/contact",
    email: "support@miners.de",
  },
};
export function productCollection(title: string): string | null {
  if (
    /\b(case|adapter)$/i.test(title) &&
    !/\bwith\b.*\b(case|adapter)$/i.test(title)
  )
    return null;
  if (
    /\b(axedash|display for|screen for|fan|splitter|stand|upgrade|plate|bithalo kit|blower|silencer|ventilador|enclosure|cable|sticker|heatsink|replacement|rail kit|power supply|fuente de poder|refacciones)\b|\b(case|adapter)\s*(for|only)/i.test(
      title,
    )
  )
    return null;
  if (/\b(doge|scrypt|litecoin|kaspa|ks[0-9]|l[379]\b)/i.test(title))
    return null;
  if (
    /\b(bitaxe|nerd[qa]*xe|bitforge|gekko\s*science|bitfortun|nexus s1|avalon|whatsminer|antminer s\d+|antminer t\d+)\b|bitcoin miner/i.test(
      title,
    )
  )
    return "asic";
  if (
    /\b(jetson|dgx|hailo)\b|raspberry pi.*(ai (hat|kit|camera)|llm kit)|(?:geforce|nvidia|quadro).*\brtx\s*[0-9a-z]+/i.test(
      title,
    )
  )
    return "ai-compute";
  if (
    /\b(poweredge|proliant)\b|supermicro.*server/i.test(title) &&
    /\b(server|servidor|xeon)\b/i.test(title)
  )
    return "servers";
  return null;
}
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
  create: (batch: any) => Promise<unknown>,
  authorize: (host?: string) => Promise<void>,
  request: typeof fetch = fetch,
  sources: readonly (typeof suppliers)[number][] = suppliers,
) {
  if (!sources.length) return [];
  db.exec(
    "CREATE TABLE IF NOT EXISTS marketplace_researched(owner TEXT NOT NULL,url TEXT NOT NULL,run_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(owner,url)); CREATE TABLE IF NOT EXISTS marketplace_vendor_rotation(owner TEXT PRIMARY KEY,cursor INTEGER NOT NULL)",
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
    return (
      u.hostname.replace(/^www\./, "") +
      decodeURI(u.pathname).replace(/\/$/, "")
    );
  };
  const existing = new Set(
    catalog.items.flatMap((item: any) => {
      try {
        const v = new URL(item.source_url).searchParams.get("variant");
        return [
          canonical(item.source_url) +
            (v && /^\d+$/.test(v) ? "#variant=" + v : ""),
        ];
      } catch {
        return [];
      }
    }),
  );
  const cursor =
    (
      db
        .prepare("SELECT cursor FROM marketplace_vendor_rotation WHERE owner=?")
        .get(owner) as { cursor: number } | undefined
    )?.cursor ?? 0;
  const selected: any[] = [];
  let visited = 0;
  for (
    ;
    visited < sources.length && selected.length < RESEARCH_PRODUCT_LIMIT;
    visited++
  ) {
    const vendor = sources[(cursor + visited) % sources.length]!;
    // Authority failures must abort the entire pass, never be treated as supplier outages.
    await authorize(vendor.host);
    let products: any[] = [];
    try {
      if (vendor.adapter === "shopify") {
        const cart = await json(`https://${vendor.host}/cart.js`, request);
        if (cart.currency !== vendor.currency) throw Error("Currency mismatch");
      }
      for (let page = 1; page <= 4; page++) {
        const data = await json(
          vendor.adapter === "shopify"
            ? `https://${vendor.host}/products.json?limit=250&page=${page}`
            : `https://${vendor.host}/wp-json/wc/store/v1/products?per_page=100&page=${page}`,
          request,
        );
        const items = vendor.adapter === "shopify" ? data.products : data;
        if (!Array.isArray(items)) throw Error("Unexpected catalog format");
        products.push(...items);
        if (items.length < (vendor.adapter === "shopify" ? 250 : 100)) break;
      }
    } catch {
      console.warn(`Research source unavailable: ${vendor.host}`);
      continue;
    }
    let vendorCount = 0;
    for (const product of products) {
      if (
        vendorCount >= PRODUCTS_PER_VENDOR ||
        selected.length >= RESEARCH_PRODUCT_LIMIT
      )
        break;
      const rawTitle = product.title ?? product.name;
      const title =
        typeof rawTitle === "string"
          ? rawTitle
              .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_: string, n: string) => {
                const code =
                  n[0]?.toLowerCase() === "x"
                    ? parseInt(n.slice(1), 16)
                    : Number(n);
                return code > 0 && code <= 0x10ffff
                  ? String.fromCodePoint(code)
                  : "";
              })
              .replace(/&amp;/g, "&")
              .replace(/&quot;/g, '"')
              .replace(/&apos;/g, "'")
          : rawTitle;
      if (typeof title !== "string" || title.length > 160) continue;
      const collection = productCollection(title);
      if (!collection) continue;
      let url: string;
      if (vendor.adapter === "shopify") {
        if (
          typeof product.handle !== "string" ||
          !/^[\p{L}\p{N}®™_-]+$/u.test(product.handle)
        )
          continue;
        url = `https://${vendor.host}/products/${encodeURIComponent(product.handle)}`;
      } else {
        if (
          product.type !== "simple" ||
          product.is_in_stock !== true ||
          product.is_purchasable !== true ||
          product.prices?.currency_code !== vendor.currency ||
          product.prices?.currency_minor_unit !== 2
        )
          continue;
        try {
          const u = new URL(product.permalink);
          if (
            u.protocol !== "https:" ||
            u.username ||
            u.password ||
            u.port ||
            u.hostname.replace(/^www\./, "") !==
              vendor.host.replace(/^www\./, "")
          )
            continue;
          url = u.href;
        } catch {
          continue;
        }
      }
      const baseKey = canonical(url);
      // A legacy URL-only listing or researched record is ambiguous: hold every variant.
      if (
        existing.has(baseKey) ||
        db
          .prepare(
            "SELECT 1 FROM marketplace_researched WHERE owner=? AND url=?",
          )
          .get(owner, url)
      )
        continue;
      await authorize();
      let fresh: any;
      try {
        fresh = await json(
          vendor.adapter === "shopify"
            ? `${url}.js`
            : `https://${vendor.host}/wp-json/wc/store/v1/products/${product.id}`,
          request,
        );
      } catch {
        continue;
      }
      if (
        fresh.id !== product.id ||
        String(fresh.title ?? fresh.name) !== String(rawTitle)
      )
        continue;
      const variants =
        vendor.adapter === "shopify"
          ? product.variants
          : [
              {
                id: product.id,
                available: product.is_in_stock,
                price: (Number(product.prices?.price) / 100).toFixed(2),
                title: "Exact simple product",
                sku: product.sku,
              },
            ];
      if (!Array.isArray(variants)) continue;
      for (const variant of variants) {
        if (
          vendorCount >= PRODUCTS_PER_VENDOR ||
          selected.length >= RESEARCH_PRODUCT_LIMIT
        )
          break;
        if (
          !Number.isSafeInteger(variant.id) ||
          variant.id <= 0 ||
          variant.available !== true ||
          !/^\d+(\.\d{1,2})?$/.test(String(variant.price)) ||
          Number(variant.price) <= 0
        )
          continue;
        const identity =
          vendor.adapter === "shopify"
            ? `${baseKey}#variant=${variant.id}`
            : baseKey;
        if (
          existing.has(identity) ||
          selected.some((p) => p.identity === identity) ||
          db
            .prepare(
              "SELECT 1 FROM marketplace_researched WHERE owner=? AND url=?",
            )
            .get(owner, identity)
        )
          continue;
        if (vendor.adapter === "shopify") {
          if (
            !fresh.variants?.some(
              (v: any) =>
                v.id === variant.id &&
                v.available === true &&
                v.price === Math.round(Number(variant.price) * 100) &&
                String(v.title ?? "") === String(variant.title ?? "") &&
                String(v.sku ?? "") === String(variant.sku ?? ""),
            )
          )
            continue;
        } else if (
          fresh.type !== "simple" ||
          fresh.is_in_stock !== true ||
          fresh.is_purchasable !== true ||
          fresh.prices?.currency_code !== vendor.currency ||
          fresh.prices?.currency_minor_unit !== 2 ||
          fresh.prices?.price !== product.prices.price
        )
          continue;
        const configuration = String(
            variant.title || "Default configuration",
          ).slice(0, 250),
          sku = String(variant.sku || "").slice(0, 120);
        selected.push({
          vendor,
          title,
          collection,
          url,
          price: String(variant.price),
          identity,
          variantId: vendor.adapter === "shopify" ? String(variant.id) : null,
          configuration,
          sku,
        });
        existing.add(identity);
        vendorCount++;
      }
    }
  }
  const runs: string[] = [];
  for (let offset = 0; offset < selected.length; offset += PRODUCTS_PER_BATCH) {
    const chunk = selected.slice(offset, offset + PRODUCTS_PER_BATCH);
    const time = new Date().toISOString();
    const id = uuid(
      `${owner}:${chunk
        .map((p) => p.identity)
        .sort()
        .join("|")}`,
    );
    const candidates: any[] = [];
    const organizationIndexes = new Map<string, number>();
    const mercado: any[] = [];
    const authorized = new Set<string>();
    const contactEvidence = new Map<string, { url: string; email?: string }>();
    for (const {
      vendor,
      title,
      collection,
      url,
      price,
      variantId,
      configuration,
      sku,
    } of chunk) {
      if (!authorized.has(vendor.host)) {
        await authorize(vendor.host);
        authorized.add(vendor.host);
      }
      const contact = vendorContacts[vendor.host];
      if (contact && !contactEvidence.has(vendor.host)) {
        // Only include email if this pass retrieves it from the approved public contact page.
        try {
          const response = await request(contact.url, {
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          });
          if (response.ok) {
            const reader = response.body?.getReader();
            let text = "",
              bytes = 0;
            if (reader) {
              try {
                for (;;) {
                  const r = await reader.read();
                  if (r.done) break;
                  bytes += r.value.length;
                  if (bytes > 1000000) throw Error("Contact page too large");
                  text += new TextDecoder().decode(r.value);
                }
              } finally {
                await reader.cancel();
              }
            }
            contactEvidence.set(vendor.host, {
              url: contact.url,
              ...(contact.email &&
              text.toLowerCase().includes(contact.email.toLowerCase())
                ? { email: contact.email }
                : {}),
            });
          }
        } catch {
          /* Missing contacts become follow-up work, never fabricated data. */
        }
      }
      const verifiedContact = contactEvidence.get(vendor.host);
      const evidence = {
        researchMethod: "agent",
        category: "Vendor",
        website: `https://${vendor.host}`,
        summary: `${vendor.name} (${vendor.region}) lists ${title} (${configuration}; SKU ${sku || "not supplied"}; variant ${variantId || "simple"}) at ${price} ${vendor.currency}; publicly available when checked.`,
        relevance:
          "Bitcoin mining, local AI or server equipment supplier for Mercado.",
        uncertainties:
          "Verify business contact details and confirm dealer terms, actual stock, fulfillment to Nevada and Portugal, shipping, taxes and warranty. Vendor region does not establish product origin or warehouse location.",
        fit: "high",
        evidence: "primary",
        sources: [
          { url, retrievedAt: time },
          ...(verifiedContact
            ? [{ url: verifiedContact.url, retrievedAt: time }]
            : []),
        ],
      };
      let organizationIndex = organizationIndexes.get(vendor.host);
      if (organizationIndex === undefined) {
        organizationIndex = candidates.length;
        organizationIndexes.set(vendor.host, organizationIndex);
        candidates.push({
          ...evidence,
          kind: "organizations",
          name: vendor.name,
          email: verifiedContact?.email ?? "",
        });
      }
      candidates.push({
        ...evidence,
        kind: "tasks",
        name: `${vendor.name}: verify ${title} — ${configuration}`.slice(
          0,
          200,
        ),
        organizationIndex,
      });
      mercado.push({
        product: {
          product_id: collection,
          name: title,
          description: `${title}; configuration: ${configuration}; SKU: ${sku || "not supplied"}; supplier variant: ${variantId || "simple"}. Offered by ${vendor.name}. Public listing checked ${time.slice(0, 10)}; stock and fulfillment require confirmation.`,
          specifications: JSON.stringify({
            supplierVariantId: variantId,
            sku,
            configuration,
            selectionUrl: variantId ? `${url}?variant=${variantId}` : url,
          }),
          source_name: vendor.name,
          source_url: url,
          price,
          currency: vendor.currency,
          price_checked: time.slice(0, 10),
        },
      });
    }
    await authorize();
    await create({ id, crm: { candidates }, mercado });
    db.transaction(() => {
      for (const p of chunk)
        db.prepare(
          "INSERT OR IGNORE INTO marketplace_researched VALUES(?,?,?,?)",
        ).run(owner, p.identity, id, Date.now());
    })();
    runs.push(id);
  }
  db.prepare(
    "INSERT INTO marketplace_vendor_rotation VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET cursor=excluded.cursor",
  ).run(owner, (cursor + visited) % sources.length);
  return runs;
}
