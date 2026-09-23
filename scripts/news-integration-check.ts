/** Actual News MCP and companion with disposable local/CI accounts; no live credentials. */
import { checkNewsPublication } from "./news-publication-integration.js";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { NewsConnector } from "../modules/connectors/news.js";
const target = new URL(process.env.NEWS_MCP_TEST_DATABASE_URL || "");
if (
  !["127.0.0.1", "localhost"].includes(target.hostname) ||
  !process.env.NEWS_REPO
)
  throw Error(
    "Use a disposable PostgreSQL service and the pinned News repository.",
  );
process.env.DATABASE_URL = target.toString();
const load = (name: string) =>
  import(
    pathToFileURL(resolve(process.env.NEWS_REPO!, "lib", name + ".ts")).href
  );
const { pool, schema } = await load("db"),
  { mcp, createMcpToken } = await load("mcp");
const control = new Pool({ connectionString: target.toString(), max: 1 }),
  namespace = "news_companion_" + randomUUID().replaceAll("-", "");
try {
  await control.query(`CREATE SCHEMA ${namespace}`);
  (globalThis as any).newsPool = new Pool({
    connectionString: target.toString(),
    options: `-c search_path=${namespace}`,
    max: 3,
  });
  await pool().query(
    schema.replace("REVOKE ALL ON SCHEMA public FROM PUBLIC;", ""),
  );
  const a = randomUUID(),
    b = randomUUID(),
    ids = [a, b];
  for (const account of ids)
    await pool().query("INSERT INTO accounts(id) VALUES($1)", [account]);
  const itemId = (s: string) => createHash("sha256").update(s).digest("hex");
  for (const [index, account] of ids.entries())
    await pool().query(
      "INSERT INTO items(id,source_id,topic,kind,title,url,excerpt,published_at,owner_id) VALUES($1,$2,'science','article',$3,'https://example.org/story','Synthetic source excerpt for a private account article.',now()-interval '1 hour',$4)",
      [
        itemId(account),
        "private:" + randomUUID(),
        index ? "ACCOUNT_B_PRIVATE" : "ACCOUNT_A_PRIVATE",
        account,
      ],
    );
  const calls: string[] = [];
  const transport: typeof fetch = async (url, options) => {
    assert.equal(String(url), "https://news.bittrees.org/api/mcp");
    assert.equal(options?.redirect, "error");
    const body = JSON.parse(String(options?.body));
    if (body.method === "tools/call") calls.push(body.params.name);
    return mcp(new Request(String(url), options));
  };
  async function connect(
    account: string,
    owner: string,
    scopes = ["read", "curate", "publish", "delivery"],
  ) {
    const key = (
      await createMcpToken(account, {
        name: "Synthetic companion",
        scopes,
        days: 7,
      })
    ).token;
    let bytes: Uint8Array | undefined;
    const secret = {
      getSecret: async () => bytes,
      setSecret: async (value: Uint8Array) => {
        bytes = value;
      },
      deleteCredential: async () => {
        bytes = undefined;
        return true;
      },
    };
    const client = new NewsConnector(owner, secret, transport);
    const pending = await client.prepare({ token: key });
    assert.equal(pending.connection.accountId, account);
    assert.equal(bytes, undefined);
    await client.confirm({ id: pending.id, confirmed: true });
    await client.confirm({ id: pending.id, confirmed: true });
    return { client, secret, credential: pending.connection.credentialId, key };
  }
  const first = await connect(a, "local-a"),
    second = await connect(b, "local-b");
  const one = await first.client.read(),
    two = await second.client.read();
  assert.equal(one.items.length, 1);
  assert.equal(one.items[0]!.title, "ACCOUNT_A_PRIVATE");
  assert.equal(two.items.length, 1);
  assert.equal(two.items[0]!.title, "ACCOUNT_B_PRIVATE");
  assert.ok(!JSON.stringify(one).includes("ACCOUNT_B_PRIVATE"));
  assert.ok(!JSON.stringify(two).includes("ACCOUNT_A_PRIVATE"));
  assert.ok(!JSON.stringify(await first.client.status()).includes(first.key));
  await assert.rejects(
    new NewsConnector("local-b", first.secret, transport).read(),
    /INVALID_CONNECTION/,
  );
  assert.deepEqual([...new Set(calls)].sort(), [
    "get_connection",
    "list_articles",
  ]);
  for (const table of [
    "public_job_claims",
    "public_job_events",
    "story_documents",
    "editor_jobs",
    "translations",
    "article_curation",
    "newspapers",
    "news_subscriptions",
    "deliveries",
  ])
    assert.equal(
      Number(
        (await pool().query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n,
      ),
      0,
    );
  const originalDraft = {
    front: [
      one.items[0],
      {
        ...one.items[0],
        id: itemId("untouched"),
        title: "Long unchanged story",
        excerpt: "x".repeat(10000),
      },
    ],
    feeds: [{ items: [one.items[0]] }],
  };
  for (const account of ids)
    await pool().query(
      "INSERT INTO newspapers(account_id,name,slug,draft,draft_revision,snapshot,published,auto_publish) VALUES($1,'Synthetic preview',$2,$3,7,$3,true,true)",
      [
        account,
        account,
        JSON.stringify(
          account === a
            ? originalDraft
            : { ...originalDraft, front: two.items, feeds: [] },
        ),
      ],
    );
  const original = (
    await pool().query("SELECT * FROM newspapers WHERE account_id=$1", [a])
  ).rows[0];
  const otherBefore = (
    await pool().query("SELECT * FROM newspapers WHERE account_id=$1", [b])
  ).rows[0];
  const reader = await connect(a, "local-reader", ["read"]);
  const preview = await first.client.preview();
  assert.equal(preview.revision, 7);
  assert.ok(
    !JSON.stringify(await second.client.preview()).includes(
      "ACCOUNT_A_PRIVATE",
    ),
  );
  const input = {
    revision: 7,
    itemId: one.items[0]!.id,
    title: "Reviewed owner headline",
    summary: "An exact owner edit.\nStill unverified.",
  };
  await assert.rejects(reader.client.reviewEdit(input), /CURATION_REQUIRED/);
  const review = await first.client.reviewEdit(input);
  assert.equal(
    (
      await pool().query(
        "SELECT draft_revision FROM newspapers WHERE account_id=$1",
        [a],
      )
    ).rows[0].draft_revision,
    7,
  );
  const saved = await first.client.confirmEdit({
    id: review.id,
    confirmed: true,
    curate: true,
  });
  assert.equal(saved.published, false);
  assert.equal(saved.preview.revision, 8);
  assert.equal(saved.preview.front[0]!.summary, input.summary);
  await assert.rejects(
    first.client.confirmEdit({ id: review.id, confirmed: true, curate: true }),
    /REVIEW_EXPIRED/,
  );
  const after = (
    await pool().query("SELECT * FROM newspapers WHERE account_id=$1", [a])
  ).rows[0];
  for (const field of Object.keys(original).filter(
    (k) => !["draft", "draft_revision"].includes(k),
  ))
    assert.deepEqual(after[field], original[field], field);
  assert.deepEqual(after.draft.front[1], originalDraft.front[1]);
  assert.deepEqual(after.draft.feeds, originalDraft.feeds);
  assert.deepEqual(
    (await pool().query("SELECT * FROM newspapers WHERE account_id=$1", [b]))
      .rows[0],
    otherBefore,
  );
  const oldReview = await first.client.reviewEdit({
    ...input,
    revision: 8,
    title: "Stale edit",
  });
  await pool().query(
    "UPDATE newspapers SET draft_revision=draft_revision+1 WHERE account_id=$1",
    [a],
  );
  await assert.rejects(
    first.client.confirmEdit({
      id: oldReview.id,
      confirmed: true,
      curate: true,
    }),
    /SOURCE_CONFLICT/,
  );
  const uncertain = new NewsConnector(
    "local-a",
    first.secret,
    async (url, options) => {
      const result = await transport(url, options);
      if (
        JSON.parse(String(options?.body)).params?.name === "edit_preview_item"
      )
        throw Error("Lost response after actual source commit");
      return result;
    },
  );
  const uncertainReview = await uncertain.reviewEdit({
    ...input,
    revision: 9,
    title: "Committed with lost response",
  });
  await assert.rejects(
    uncertain.confirmEdit({
      id: uncertainReview.id,
      confirmed: true,
      curate: true,
    }),
    /NEWS_SAVE_UNCONFIRMED/,
  );
  await assert.rejects(
    uncertain.confirmEdit({
      id: uncertainReview.id,
      confirmed: true,
      curate: true,
    }),
    /REVIEW_EXPIRED/,
  );
  const reconciled = await first.client.preview();
  assert.equal(reconciled.revision, 10);
  assert.equal(reconciled.front[0]!.title, "Committed with lost response");
  const revokedReview = await first.client.reviewEdit({
    ...input,
    revision: 10,
    title: "Do not commit",
  });
  await pool().query("DELETE FROM mcp_tokens WHERE id=$1", [first.credential]);
  await assert.rejects(first.client.read(), /SOURCE_DENIED/);
  await pool().query(
    "UPDATE mcp_tokens SET expires_at=now()-interval '1 second' WHERE id=$1",
    [second.credential],
  );
  await assert.rejects(second.client.read(), /SOURCE_DENIED/);
  await assert.rejects(
    first.client.confirmEdit({
      id: revokedReview.id,
      confirmed: true,
      curate: true,
    }),
    /SOURCE_DENIED/,
  );
  assert.equal(
    (
      await pool().query(
        "SELECT draft_revision FROM newspapers WHERE account_id=$1",
        [a],
      )
    ).rows[0].draft_revision,
    10,
  );
  for (const table of [
    "newspaper_editions",
    "news_subscriptions",
    "deliveries",
    "public_job_claims",
    "public_job_events",
    "editor_jobs",
    "translations",
  ])
    assert.equal(
      Number(
        (await pool().query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n,
      ),
      0,
    );
  assert.deepEqual([...new Set(calls)].sort(), [
    "edit_preview_item",
    "get_connection",
    "get_preview",
    "list_articles",
  ]);
  const removed = await first.client.forget({ confirmed: true });
  assert.equal(removed.sourceRevoked, false);
  console.log(
    "Actual News MCP + companion: reviewed reused keys, own-account reads, local-owner isolation, source expiry/revocation, explicit exact curation review, read-scope denial, stale/revoked authority, unchanged unrelated source content/snapshots/schedules, lost-response reconciliation and zero publishing/delivery/processing effects pass.",
  );
  await checkNewsPublication(pool(), mcp, createMcpToken);
} finally {
  await (globalThis as any).newsPool?.end();
  await control.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
  await control.end();
  delete (globalThis as any).newsPool;
}
