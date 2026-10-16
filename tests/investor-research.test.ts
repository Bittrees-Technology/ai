import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  InvestorResearch,
  investmentRole,
  supported,
  stableId,
} from "../modules/research/investors.js";
import {
  publicIPv4,
  sourceURL,
  pageText,
} from "../modules/research/public-pages.js";
import { Vault } from "../modules/storage/vault.js";
test("public research refuses private addresses, credentials and unapproved redirects", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "0.0.0.0",
    "198.18.0.1",
  ])
    assert.equal(publicIPv4(ip), false);
  assert.equal(publicIPv4("8.8.8.8"), true);
  for (const u of [
    "http://example.org",
    "https://x:pass@example.org",
    "https://example.org:444",
    "https://evil.org",
    "https://127.0.0.1",
  ])
    assert.throws(() => sourceURL(u, ["example.org"]));
  assert.equal(
    pageText("<script>evil</script><p>Jane &amp; Joe</p>"),
    "Jane & Joe",
  );
  assert.equal(
    supported("Jane Smith Managing Partner", "Invented quote"),
    false,
  );
});
async function fixture(
  kind: "success" | "conflict" | "unsupported" | "unconfirmed",
  options: { priorName?: string; concurrentName?: string } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "investor-research-"));
  const dataset = "bcb0d794-42bc-4171-b29e-55898a891c14";
  let rows: any[] = [];
  let saves = 0;
  let reads = 0;
  const prior = (name: string) => ({
    id: stableId(dataset, "people", name),
    kind: "people",
    name,
    organizationId: "a-different-firm",
  });
  if (options.priorName) rows.push(prior(options.priorName));
  const connector: any = {
    read: async () => {
      reads++;
      if (reads === 3 && options.concurrentName)
        rows.push(prior(options.concurrentName));
      return { id: dataset, version: 1, entries: rows };
    },
    append: async (a: any) => {
      saves++;
      if (kind === "conflict") throw new Error("SOURCE_CONFLICT");
      if (kind !== "unconfirmed") rows = a.entries;
      return { id: dataset, version: 2, added: rows.length };
    },
  };
  const runtime: any = {
    pin: async () => ({
      digest: "pinned",
      profile: { contextTokens: 16000, maxOutputTokens: 3000 },
    }),
    generate: async () =>
      JSON.stringify({
        organization: "Example Capital",
        geographyEvidence: "New York, United States",
        people: [
          {
            name: "Jane Smith",
            title: "Managing Partner",
            evidence:
              kind === "unsupported"
                ? "Invented person evidence"
                : "Jane Smith Managing Partner",
            category: "Family office / allocator",
            relevance: "Likely to invest; assume confirmed interest.",
          },
        ],
      }),
  };
  const run = new InvestorResearch(
    join(dir, "jobs.db"),
    new Vault(randomBytes(32)),
    connector,
    runtime,
    () => ({}),
    () => ({ reason: "ready", seconds: 10 }),
    async (url) => ({
      url,
      text: "Example Capital. Jane Smith Managing Partner. New York, United States",
      links: [],
    }),
  );
  try {
    await run.create({
      confirmed: true,
      profileId: "p",
      brief: "Research US investors with owner publication approval.",
      target: 1,
      urls: ["https://example.org/team"],
    });
    for (let i = 0; i < 100 && run.status()[0]!.state === "running"; i++)
      await new Promise((r) => setTimeout(r, 10));
    return { job: run.status()[0]!, rows, saves, dataset };
  } finally {
    await run.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
test("local model extracts grounded linked entries and saves only private pending research", async () => {
  const { job, rows, saves, dataset } = await fixture("success");
  assert.equal(job.state, "complete");
  assert.equal(job.added, 1);
  assert.equal(saves, 1);
  assert.equal(job.results?.[0]?.name, "Jane Smith");
  assert.equal(job.results?.[0]?.id, rows[1].id);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].organizationId, rows[0].id);
  assert.equal(rows[1].research.training, "pending");
  assert.equal(rows[1].research.verification, "unverified");
  assert.equal(
    rows[1].research.relevance,
    "Publicly listed investment professional; BBRF-PT mandate fit and investment interest require qualification.",
  );
  assert.equal(rows[1].id, stableId(dataset, "people", "Jane Smith"));
});
test("source conflict retains pending entries and pauses instead of overwriting", async () => {
  const { job, saves } = await fixture("conflict");
  assert.equal(job.state, "needs_attention");
  assert.equal(job.pendingEntries, 2);
  assert.equal(job.added, 0);
  assert.equal(saves, 1);
});
test("unsupported model claims do not reach CRM", async () => {
  const { job, saves } = await fixture("unsupported");
  assert.equal(job.state, "sources_exhausted");
  assert.equal(saves, 0);
  assert.equal(job.skipped, 1);
});

test("a save without confirmed source records is not counted as completed work", async () => {
  const { job } = await fixture("unconfirmed");
  assert.equal(job.state, "needs_attention");
  assert.equal(job.added, 0);
  assert.equal(job.pendingEntries, 2);
  assert.match(job.error!, /could not be confirmed/);
  assert.equal(job.results, undefined);
});

test("decision-maker research excludes support and ambiguous junior roles", () => {
  for (const title of [
    "Client Service Associate",
    "Executive Business Partner to the CEO",
    "Chief of Staff",
    "Account Administration Specialist",
    "CFO",
    "COO",
    "Vice President",
    "Investment Analyst",
    "Investor Relations Partner",
    "Assistant Managing Director",
  ])
    assert.equal(investmentRole(title), false, title);
  for (const title of [
    "CEO & Chief Investment Officer",
    "Managing Director Investments",
    "Managing Director (Public Assets)",
    "Managing Partner",
    "Director of Acquisitions",
  ])
    assert.equal(investmentRole(title), true, title);
});

test("name variation at another organization is held before any CRM append", async () => {
  const { job, saves, rows } = await fixture("success", {
    priorName: "Jane A. Smith, CFA",
  });
  assert.equal(saves, 0);
  assert.equal(rows.length, 1);
  assert.equal(job.added, 0);
  assert.equal(job.state, "sources_exhausted");
  assert.equal(
    job.duplicateReviews?.[0]?.matches[0]?.name,
    "Jane A. Smith, CFA",
  );
});
test("newly appeared variation blocks a pending batch and its orphan organization", async () => {
  const { job, saves, rows } = await fixture("success", {
    concurrentName: "Jane A. Smith",
  });
  assert.equal(saves, 0);
  assert.equal(rows.length, 1);
  assert.equal(job.pendingEntries, 0);
  assert.equal(job.added, 0);
  assert.equal(job.duplicateReviews?.length, 1);
});
