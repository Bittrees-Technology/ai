import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { researchBatches, suppliers } from "../modules/coordinator/research.js";
import {
  weeklyResearchDue,
  WEEKLY_RESEARCH_INTERVAL,
  requireResearchBrief,
} from "../modules/coordinator/research-brief.js";
const product = {
  id: 42,
  title: "Apollo III Bitcoin Miner",
  handle: "apollo-iii",
  variants: [
    { id: 101, title: "NO SSD", sku: "A0", available: true, price: "1099.99" },
    {
      id: 102,
      title: "1 TB SSD",
      sku: "A1",
      available: true,
      price: "1299.99",
    },
    {
      id: 103,
      title: "2 TB SSD",
      sku: "A2",
      available: true,
      price: "1399.99",
    },
  ],
};
function fixture(items: any[] = [], changed = false) {
  let fetches = 0;
  const request: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("mercado.bittrees.org")) return Response.json({ items });
    if (url.endsWith("/cart.js")) return Response.json({ currency: "USD" });
    if (url.includes("products.json"))
      return Response.json({ products: [product] });
    if (url.endsWith(".js")) {
      fetches++;
      return Response.json({
        ...product,
        variants: product.variants.map((v) => ({
          ...v,
          title: changed && v.id === 102 ? "wrong configuration" : v.title,
          price: Math.round(Number(v.price) * 100),
        })),
      });
    }
    return new Response("contact");
  };
  return { request, getFetches: () => fetches };
}
test("three storage variants retain SKU, configuration, unique identities and task links across replay", async () => {
  const db = new Database(":memory:"),
    batches: any[] = [],
    f = fixture();
  const create = async (b: any) => {
    batches.push(b);
  };
  await researchBatches(db, "owner", create, async () => {}, f.request, [
    suppliers[0],
  ]);
  assert.equal(batches.length, 1);
  const b = batches[0];
  assert.equal(b.mercado.length, 3);
  assert.equal(b.crm.candidates.length, 4);
  assert.equal(f.getFetches(), 1);
  assert.deepEqual(
    b.mercado.map(
      (p: any) => JSON.parse(p.product.specifications).supplierVariantId,
    ),
    ["101", "102", "103"],
  );
  assert.deepEqual(
    b.mercado.map((p: any) => JSON.parse(p.product.specifications).sku),
    ["A0", "A1", "A2"],
  );
  assert(
    b.crm.candidates.slice(1).every((t: any) => t.organizationIndex === 0),
  );
  assert(b.crm.candidates[2].name.includes("1 TB SSD"));
  const rows = db
    .prepare("SELECT url FROM marketplace_researched")
    .all() as any[];
  assert.equal(new Set(rows.map((r) => r.url)).size, 3);
  await researchBatches(db, "owner", create, async () => {}, f.request, [
    suppliers[0],
  ]);
  assert.equal(batches.length, 1);
  db.close();
});
test("legacy product matches stay held and existing variant only excludes its exact offer", async () => {
  for (const [url, count] of [
    ["https://serverdepotus.com/products/apollo-iii", 0],
    ["https://serverdepotus.com/products/apollo-iii?variant=102", 2],
  ] as const) {
    const db = new Database(":memory:"),
      b: any[] = [];
    await researchBatches(
      db,
      "owner",
      async (x) => {
        b.push(x);
      },
      async () => {},
      fixture([{ source_url: url }]).request,
      [suppliers[0]],
    );
    assert.equal(b.flatMap((x) => x.mercado).length, count);
    db.close();
  }
});
test("fresh variant configuration mismatch cannot inherit another configuration price or stock", async () => {
  const db = new Database(":memory:"),
    b: any[] = [];
  await researchBatches(
    db,
    "owner",
    async (x) => {
      b.push(x);
    },
    async () => {},
    fixture([], true).request,
    [suppliers[0]],
  );
  assert.deepEqual(
    b[0].mercado.map((x: any) => JSON.parse(x.product.specifications).sku),
    ["A0", "A2"],
  );
  db.close();
});
test("weekly budget does not become due at six hours or after a backward clock", () => {
  const now = 2 * WEEKLY_RESEARCH_INTERVAL;
  assert.equal(weeklyResearchDue(now - 6 * 3600000, now), false);
  assert.equal(weeklyResearchDue(now - WEEKLY_RESEARCH_INTERVAL, now), true);
  assert.equal(weeklyResearchDue(now + 1, now), false);
  assert.equal(weeklyResearchDue(NaN, now), false);
});
test("brief diagnostics distinguish transport, tasks and supplier scope without leaking server messages", async () => {
  await assert.rejects(
    requireResearchBrief(
      Response.json(
        { error: { code: -32000, message: "Source connection unavailable" } },
        { status: 403 },
      ),
      "example.com",
    ),
    /MCP source connection unavailable/,
  );
  await assert.rejects(
    requireResearchBrief(
      Response.json({
        result: {
          structuredContent: {
            brief: { allowTasks: false, sourceDomains: [] },
          },
        },
      }),
    ),
    /CRM did not authorize/,
  );
  await assert.rejects(
    requireResearchBrief(
      Response.json({
        result: {
          structuredContent: { brief: { allowTasks: true, sourceDomains: [] } },
        },
      }),
      "example.com",
    ),
    /outside approved scope/,
  );
  await assert.rejects(
    requireResearchBrief(new Response("x".repeat(64001))),
    /exceeds limit/,
  );
  await assert.rejects(
    requireResearchBrief(
      Response.json({
        error: { code: -1, message: "private detail not echoed" },
      }),
    ),
    (e) => !String(e).includes("private detail"),
  );
  const brief = await requireResearchBrief(
    Response.json({
      result: {
        structuredContent: {
          brief: { allowTasks: true, sourceDomains: ["example.com"] },
        },
      },
    }),
    "example.com",
  );
  assert.equal(brief.allowTasks, true);
});
