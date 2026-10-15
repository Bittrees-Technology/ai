import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  researchBatches,
  suppliers,
  productCollection,
} from "../modules/coordinator/research.js";
test("catalog research filters products, verifies stock, generates linked proposals and deduplicates", async () => {
  const db = new Database(":memory:");
  const product = {
    id: 1,
    title: "Raspberry Pi LLM Kit",
    handle: "llm-kit",
    variants: [{ id: 1, available: true, price: "100.00" }],
  };
  let checks = 0;
  const batches: any[] = [];
  const request: typeof fetch = async (url) =>
    new Response(
      JSON.stringify(
        String(url).includes("mercado.bittrees.org")
          ? { items: [] }
          : String(url).endsWith("cart.js")
            ? { currency: "USD" }
            : String(url).includes("products.json")
              ? {
                  products: [
                    product,
                    { ...product, id: 2, title: "AI slides" },
                    { ...product, id: 3, title: "Jetson case" },
                    {
                      ...product,
                      id: 4,
                      title: "Jetson",
                      variants: [{ available: false, price: "5" }],
                    },
                  ],
                }
              : {
                  ...product,
                  variants: [{ ...product.variants[0], price: 10000 }],
                },
      ),
    );
  const create = async (b: any) => {
    batches.push(b);
  };
  await researchBatches(
    db,
    "owner",
    create,
    async () => {
      checks++;
    },
    request,
    [suppliers[6]],
  );
  assert.equal(batches.length, 1);
  assert.equal(batches[0].crm.candidates[1].organizationIndex, 0);
  assert.equal(batches[0].mercado[0].product.price, "100.00");
  assert(checks >= 4);
  await researchBatches(db, "owner", create, async () => {}, request, [
    suppliers[6],
  ]);
  assert.equal(batches.length, 1);
  await assert.rejects(
    researchBatches(
      db,
      "other",
      create,
      async () => {
        throw Error("revoked");
      },
      request,
      [suppliers[6]],
    ),
    /revoked/,
  );
  db.close();
});

test("scope separates miners, GPUs and complete servers from accessories and altcoin equipment", () => {
  for (const title of [
    "Bitaxe Gamma with PSU and case",
    "CANAAN AVALON Q 90TH/S",
    "Antminer S21 200TH/s",
    "Bitcoin Merch® Nexus S1 Hydro Bitcoin Miner",
  ])
    assert.equal(productCollection(title), "asic");
  assert.equal(
    productCollection("ASUS NVIDIA GeForce RTX 5070 Ti"),
    "ai-compute",
  );
  assert.equal(productCollection("HPE ProLiant DL380 Xeon server"), "servers");
  for (const title of [
    "Jetson case",
    "Antminer L7 DOGE miner",
    "PowerEdge rail kit",
    "Raspberry Pi cable",
  ])
    assert.equal(productCollection(title), null);
});

test("mixed regional batches rotate vendors, verify Woo stock and link every task", async () => {
  const db = new Database(":memory:");
  const batches: any[] = [];
  const request: typeof fetch = async (input) => {
    const u = new URL(String(input));
    const vendor = suppliers.find((s) => s.host === u.hostname);
    if (!vendor) return Response.json({ items: [] });
    if (u.pathname === "/cart.js")
      return Response.json({ currency: vendor.currency });
    const title =
      vendor.host === "serverdepotus.com"
        ? "HPE ProLiant Xeon server"
        : vendor.host === "www.noxar.mx"
          ? "NVIDIA GeForce RTX 5080"
          : "Bitaxe Gamma with case";
    if (vendor.adapter === "woo") {
      const p = {
        id: 1,
        name: title,
        type: "simple",
        is_in_stock: true,
        is_purchasable: true,
        permalink: `https://${vendor.host}/product/bitaxe/`,
        prices: {
          price: "10000",
          currency_code: vendor.currency,
          currency_minor_unit: 2,
        },
      };
      return Response.json(u.search ? [p] : p);
    }
    const p = {
      id: 1,
      title,
      handle: "bitaxe®",
      variants: [
        {
          id: 1,
          available: true,
          price: u.pathname.endsWith(".js") ? 10000 : "100.00",
        },
      ],
    };
    return Response.json(
      u.pathname.endsWith("products.json") ? { products: [p] } : p,
    );
  };
  for (let i = 0; i < 3; i++)
    await researchBatches(
      db,
      "owner",
      async (b) => {
        batches.push(b);
      },
      async () => {},
      request,
    );
  assert.deepEqual(
    batches.map((b) => b.mercado.length),
    [3, 3, 1],
  );
  assert.equal(
    new Set(
      batches.flatMap((b) => b.mercado.map((p: any) => p.product.source_name)),
    ).size,
    7,
  );
  for (const b of batches)
    b.crm.candidates.forEach((c: any, i: number) => {
      if (c.kind === "tasks") assert.equal(c.organizationIndex, i - 1);
    });
  const calls = batches.length;
  await researchBatches(
    db,
    "owner",
    async (b) => {
      batches.push(b);
    },
    async () => {},
    request,
  );
  assert.equal(batches.length, calls);
  assert.equal(
    productCollection("MINI SILENCER BLOWER PARA WHATSMINER Y ANTMINER"),
    null,
  );
  db.close();
});

test("revocation after discovery stops submission, and currency or stale stock cannot qualify", async () => {
  const db = new Database(":memory:");
  let creates = 0,
    checks = 0;
  const request: typeof fetch = async (input) => {
    const u = String(input);
    if (u.includes("mercado.bittrees")) return Response.json({ items: [] });
    if (u.endsWith("cart.js")) return Response.json({ currency: "USD" });
    const p = {
      id: 1,
      title: "Jetson",
      handle: "jetson",
      variants: [
        { id: 1, available: true, price: u.endsWith(".js") ? 10000 : "100.00" },
      ],
    };
    return Response.json(u.includes("products.json") ? { products: [p] } : p);
  };
  await assert.rejects(
    researchBatches(
      db,
      "owner",
      async () => {
        creates++;
      },
      async () => {
        if (++checks === 4) throw Error("revoked");
      },
      request,
      [suppliers[6]],
    ),
    /revoked/,
  );
  assert.equal(creates, 0);
  assert.equal(
    (
      db.prepare("SELECT count(*) AS n FROM marketplace_researched").get() as {
        n: number;
      }
    ).n,
    0,
  );
  const stale: typeof fetch = async (input) =>
    String(input).endsWith("/jetson.js")
      ? Response.json({
          id: 1,
          variants: [{ id: 1, available: false, price: 10000 }],
        })
      : request(input);
  await researchBatches(
    db,
    "owner",
    async () => {
      creates++;
    },
    async () => {},
    stale,
    [suppliers[6]],
  );
  assert.equal(creates, 0);
  db.close();
});
