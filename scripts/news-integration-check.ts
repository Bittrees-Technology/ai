/** Actual News MCP and companion with disposable local/CI accounts; no live credentials. */
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
  async function connect(account: string, owner: string) {
    const key = (
      await createMcpToken(account, {
        name: "Synthetic companion",
        scopes: ["read", "curate", "publish", "delivery"],
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
  await pool().query("DELETE FROM mcp_tokens WHERE id=$1", [first.credential]);
  await assert.rejects(first.client.read(), /SOURCE_DENIED/);
  await pool().query(
    "UPDATE mcp_tokens SET expires_at=now()-interval '1 second' WHERE id=$1",
    [second.credential],
  );
  await assert.rejects(second.client.read(), /SOURCE_DENIED/);
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
  const removed = await first.client.forget({ confirmed: true });
  assert.equal(removed.sourceRevoked, false);
  console.log(
    "Actual News MCP + companion: reviewed reused keys, own-account reads, local-owner isolation, source expiry/revocation, fixed read-only calls and unchanged curation/processing/delivery tables pass.",
  );
} finally {
  await (globalThis as any).newsPool?.end();
  await control.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
  await control.end();
  delete (globalThis as any).newsPool;
}
