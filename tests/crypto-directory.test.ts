import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  CryptoDirectoryResearch,
  groundedDirectoryAnswer,
  directoryURL,
} from "../modules/research/crypto-directory.js";
import { Vault } from "../modules/storage/vault.js";
const text =
  "Example is an onchain lending protocol. It offers lending markets.";
const answer = {
  fits: true,
  name: "Example",
  summary: "A lending protocol.",
  tags: ["DeFi"],
  claims: [
    {
      field: "name",
      value: "Example",
      quote: "Example is an onchain lending protocol.",
    },
    {
      field: "description",
      value: "Lending",
      quote: "It offers lending markets.",
    },
  ],
  uncertainties: ["Founding year unconfirmed"],
};
test("source assessment rejects invented quotes, tags, and missing project evidence", () => {
  assert.equal(groundedDirectoryAnswer(answer, text, ["DeFi"]).fits, true);
  assert.throws(() =>
    groundedDirectoryAnswer({ ...answer, tags: ["Invented"] }, text, ["DeFi"]),
  );
  assert.throws(() =>
    groundedDirectoryAnswer(
      {
        ...answer,
        claims: [
          {
            field: "name",
            value: "Example",
            quote: "This quote is fabricated",
          },
        ],
      },
      text,
      ["DeFi"],
    ),
  );
  assert.throws(() =>
    groundedDirectoryAnswer({ ...answer, claims: [] }, text, ["DeFi"]),
  );
  for (const url of [
    "http://example.com",
    "https://user:pass@example.com",
    "https://example.com:123",
  ])
    assert.throws(() => directoryURL(url));
});
test("enabled validation saves grounded local results, respects cadence, preserves repository and pause", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "directory-workflow-")),
  );
  await mkdir(join(root, "content/projects"), { recursive: true });
  const path = join(root, "content/projects/example.md");
  const original =
    "---\nname: Example\nprimary_url: https://example.org\ntags: [DeFi]\nlead_category: DeFi\n---\n";
  await writeFile(path, original);
  let calls = 0,
    admission = "ready";
  const runtime: any = {
    pin: async () => ({
      profile: { model: "local", contextTokens: 32000, maxOutputTokens: 2000 },
      digest: "abc",
    }),
    generate: async () => {
      calls++;
      return JSON.stringify(answer);
    },
  };
  const worker = new CryptoDirectoryResearch(
    join(root, "state.db"),
    new Vault(randomBytes(32)),
    runtime,
    () => ({ id: "test" }),
    () => ({ reason: admission, seconds: 60 }),
    async (_signal, work) => work(),
    { page: async () => ({ url: "https://example.org/", text, links: [] }) },
  );
  try {
    await worker.configure({
      confirmed: true,
      enabled: true,
      repository: root,
      profileId: "test",
    });
    admission = "paused";
    await worker.tick();
    assert.equal(calls, 0);
    admission = "ready";
    await worker.tick();
    assert.equal(calls, 1);
    assert.equal(worker.status().results[0].status, "source-assessed");
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal(
      worker.status().workflows.find((w) => w.mode === "validation")?.state,
      "waiting",
    );
    await worker.pause();
    await worker.tick();
    assert.equal(calls, 1);
    assert.equal(worker.status().enabled, false);
  } finally {
    await worker.close();
    await rm(root, { recursive: true });
  }
});
