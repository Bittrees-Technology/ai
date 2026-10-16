import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SupplierReview,
  renderSupplierReview,
} from "../modules/research/supplier-review.js";
const signal = () => new AbortController().signal;
const metadata = { version: 1, urls: ["https://supplier.example/terms"] };
test("supplier pages reuse dated evidence only within the approved project and freshness window", async () => {
  let count = 0,
    now = 1_800_000_000_000;
  const review = new SupplierReview(
    async (url) => {
      count++;
      return {
        url,
        text: "Public warranty terms apply to listed products.",
        links: [],
      };
    },
    () => now,
  );
  const first = await review.sources(metadata, "project-one", signal());
  now += 1000;
  const second = await review.sources(metadata, "project-one", signal());
  assert.equal(count, 1);
  assert.equal(first.sources[0]!.retrievedAt, second.sources[0]!.retrievedAt);
  await review.sources(metadata, "project-two", signal());
  assert.equal(count, 2);
  now += 3600000;
  await review.sources(metadata, "project-one", signal());
  assert.equal(count, 3);
  const note = renderSupplierReview(
    {
      excerpts: [
        {
          sourceId: "source-1",
          quote: "Public warranty terms apply to listed products.",
        },
      ],
    },
    first.sources,
    [],
  );
  assert.match(note, /CONFIRMATIONS STILL OPEN/);
  assert.match(note, /https:\/\/supplier.example\/terms/);
  assert.match(note, /Original supplier confirmation tasks remain open/);
  assert.throws(
    () =>
      renderSupplierReview(
        {
          excerpts: [
            {
              sourceId: "source-1",
              quote: "Shipping to Portugal is confirmed.",
            },
          ],
        },
        first.sources,
        [],
      ),
    /did not match/,
  );
});
test("supplier metadata cannot turn unrelated or private URLs into research", async () => {
  let requests = 0;
  const review = new SupplierReview(async (url) => {
    requests++;
    return { url, text: "Published terms", links: [] };
  });
  for (const urls of [
    ["http://supplier.example/"],
    ["https://127.0.0.1/"],
    ["https://supplier.example/?secret=private"],
    ["https://supplier.example/", "https://different.example/"],
  ]) {
    await assert.rejects(
      review.sources({ version: 1, urls }, "project", signal()),
    );
  }
  assert.equal(requests, 0);
});
test("unavailable or changed sources never reuse expired evidence or produce invented completion", async () => {
  let now = 1_800_000_000_000,
    fail = false;
  const review = new SupplierReview(
    async (url) => {
      if (fail) throw Error("offline");
      return { url, text: "Original terms", links: [] };
    },
    () => now,
  );
  await review.sources(metadata, "project", signal());
  now += 3600000;
  fail = true;
  await assert.rejects(
    review.sources(metadata, "project", signal()),
    /remain.*open/,
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(review.sources(metadata, "project", abort.signal));
  assert.throws(
    () => renderSupplierReview({ excerpts: [] }, [], []),
    /remains open/,
  );
});
