import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { researchBatches } from "../modules/coordinator/research.js";
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
              : { product },
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
  );
  assert.equal(batches.length, 1);
  assert.equal(batches[0].crm.candidates[1].organizationIndex, 0);
  assert.equal(batches[0].mercado[0].product.price, "100.00");
  assert(checks >= 4);
  await researchBatches(db, "owner", create, async () => {}, request);
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
    ),
    /revoked/,
  );
  db.close();
});
