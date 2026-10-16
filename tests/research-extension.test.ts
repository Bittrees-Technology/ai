import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { InvestorResearch } from "../modules/research/investors.js";
import { Vault } from "../modules/storage/vault.js";
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "research-extension-")),
    dataset = randomUUID();
  let rows: any[] = [
      { id: randomUUID(), kind: "people", name: "Existing Person" },
    ],
    readDataset = dataset,
    url = "";
  const seen: string[] = [];
  const run = new InvestorResearch(
    join(dir, "jobs.db"),
    new Vault(randomBytes(32)),
    {
      read: async () => ({ id: readDataset, version: 1, entries: rows }),
      append: async (a: any) => {
        rows.push(...a.entries);
        return { id: dataset, version: 2 };
      },
    } as any,
    {
      pin: async () => ({
        digest: "same",
        profile: { contextTokens: 16000, maxOutputTokens: 3000 },
      }),
      generate: async () =>
        JSON.stringify({
          organization: "Example Capital",
          geographyEvidence: "New York, United States",
          people: url.includes("new.example")
            ? [
                {
                  name: "Jane Smith",
                  title: "Managing Partner",
                  evidence: "Jane Smith Managing Partner",
                  category: "Family office / allocator",
                  relevance: "Unverified.",
                },
                {
                  name: "John Smith",
                  title: "Managing Partner",
                  evidence: "John Smith Managing Partner",
                  category: "Family office / allocator",
                  relevance: "Unverified.",
                },
              ]
            : [],
        }),
    } as any,
    () => ({}),
    () => ({ reason: "ready", seconds: 10 }),
    async (u, hosts) => {
      url = u;
      seen.push(u);
      assert.ok(hosts.includes(new URL(u).hostname));
      return {
        url: u,
        text: "Example Capital. New York, United States. Jane Smith Managing Partner. John Smith Managing Partner.",
        links: [],
      };
    },
  );
  const idle = async () => {
    for (let i = 0; i < 100 && run.isRunning; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(run.isRunning, false);
  };
  await run.create({
    confirmed: true,
    profileId: "p",
    brief: "Find sourced US investment decision makers.",
    target: 10,
    urls: ["https://old.example/team"],
  });
  await idle();
  return {
    run,
    idle,
    seen,
    rows,
    changeDataset() {
      readDataset = randomUUID();
    },
    async close() {
      await run.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("extend preserves one run and existing records, adds exact hosts, and caps the combined dataset target", async () => {
  const f = await setup();
  try {
    const before = f.run.status()[0]!;
    assert.equal(before.state, "sources_exhausted");
    await f.run.extend({
      confirmed: true,
      id: before.id,
      urls: ["https://new.example/team", "https://new.example/team"],
      totalPeopleTarget: 2,
    });
    await f.idle();
    const after = f.run.status()[0]!;
    assert.equal(after.id, before.id);
    assert.equal(f.run.list().length, 1);
    assert.equal(after.state, "complete");
    assert.equal(after.totalPeopleTarget, 2);
    assert.equal(after.crmProgress?.researchPeople, 2);
    assert.equal(after.added, 1);
    assert.equal(f.rows[0].name, "Existing Person");
    assert.equal(f.seen.filter((u) => u.includes("new.example")).length, 1);
  } finally {
    await f.close();
  }
});
test("extend rejects unconfirmed, insecure, processed, over-budget and changed-dataset sources without executing them", async () => {
  const f = await setup();
  try {
    const id = f.run.status()[0]!.id,
      base = {
        confirmed: true,
        id,
        urls: ["https://new.example/team"],
        totalPeopleTarget: 2,
      };
    await assert.rejects(f.run.extend({ ...base, confirmed: false }));
    await assert.rejects(
      f.run.extend({ ...base, urls: ["http://new.example/team"] }),
    );
    await assert.rejects(
      f.run.extend({ ...base, urls: ["https://old.example/team"] }),
      /already/,
    );
    await assert.rejects(
      f.run.extend({
        ...base,
        urls: Array.from({ length: 9 }, (_, i) => "https://new.example/" + i),
      }),
      /eight/,
    );
    f.changeDataset();
    await assert.rejects(f.run.extend(base), /connection changed/);
    assert.deepEqual(f.seen, ["https://old.example/team"]);
  } finally {
    await f.close();
  }
});
