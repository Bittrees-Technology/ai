/** Invoked inside the disposable pinned News schema by news-integration-check.ts. */
import { createServer } from "node:http";
import { localApi } from "../apps/companion/http.js";
import { NewsConnectionController } from "../apps/dashboard/news-state.js";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { NewsConnector } from "../modules/connectors/news.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
export async function checkNewsPublication(
  db: Pool,
  mcp: (r: Request) => Promise<Response>,
  createMcpToken: (account: string, input: any) => Promise<any>,
) {
  const account = randomUUID(),
    feed = randomUUID(),
    privateSource = randomUUID(),
    owner = { userId: "publication-pilot", tenantId: "synthetic" };
  const dir = await mkdtemp(join(tmpdir(), "news-publication-integration-")),
    path = join(dir, "tasks.db"),
    vault = new Vault(randomBytes(32));
  let store = new Store(path, vault),
    restored: Store | undefined;
  const items = ["front", "feed"].map((section) => ({
    id: createHash("sha256")
      .update(account + section)
      .digest("hex"),
    source_id: "synthetic-public",
    url: "https://example.org/" + section,
    title: "Exact " + section + " headline",
    topic: "science",
    kind: "article",
    published_at: new Date().toISOString(),
    excerpt: "Original source excerpt " + section,
    summary: "Reviewed owner wording " + section,
    summary_kind: "user_edited",
    user_edited: true,
    original_title: "Original " + section,
    authors: ["Synthetic Author"],
    translation: {
      language: "en",
      title: "Translated " + section,
      summary: "Translated wording " + section,
      model: "synthetic",
    },
    ranking_score: 999,
    private_context: "OMIT_PRIVATE_CONTEXT",
  }));
  let bytes: Uint8Array | undefined,
    loseResponse = false,
    writes = 0;
  const calls: string[] = [];
  const secret = {
    getSecret: async () => bytes,
    setSecret: async (v: Uint8Array) => {
      bytes = v;
    },
    deleteCredential: async () => {
      bytes = undefined;
      return true;
    },
  };
  const transport: typeof fetch = async (url, options) => {
    assert.equal(String(url), "https://news.bittrees.org/api/mcp");
    const request = JSON.parse(String(options?.body)),
      name = request.params?.name;
    if (name) calls.push(name);
    if (name === "publish_reviewed_preview") {
      writes++;
      const durable = new Store(path, vault);
      try {
        assert.equal(
          durable.newsPublications.read(
            owner,
            request.params.arguments.operationId,
          ).review.content.snapshot.feeds.length,
          1,
        );
      } finally {
        durable.close();
      }
    }
    const response = await mcp(new Request(String(url), options));
    if (loseResponse && name === "publish_reviewed_preview")
      throw Error("Source committed; response deliberately lost");
    return response;
  };
  const make = () =>
    new NewsConnector(
      JSON.stringify(owner),
      secret,
      transport,
      Date.now,
      store.newsPublications.forOwner(owner),
    );
  let client = make();
  const server = createServer(),
    localToken = randomBytes(32).toString("hex");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  server.on("request", (req, res) =>
    localApi({ store, owner, token: localToken, port, news: client })(req, res),
  );
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/connections/news/publication/${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: "Bearer " + localToken,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    const value = (await response.json()) as any;
    if (!response.ok) throw Error(value.error);
    return value;
  };
  const controller = new NewsConnectionController((path, _method, body) =>
    api(path.replace("/v1/connections/news/publication/", ""), body),
  );
  try {
    await db.query("INSERT INTO accounts(id) VALUES($1)", [account]);
    for (const i of items)
      await db.query(
        "INSERT INTO items(id,source_id,url,title,excerpt,published_at,topic,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          i.id,
          i.source_id,
          i.url,
          i.title,
          i.excerpt,
          i.published_at,
          i.topic,
          i.kind,
        ],
      );
    await db.query(
      "INSERT INTO connections(id,account_id,name,url,topic,share_public) VALUES($1,$2,'Synthetic private source','https://example.org/private','science',false)",
      [privateSource, account],
    );
    const draft = {
      front: [items[0]],
      feeds: [
        {
          id: feed,
          name: "Saved feed name",
          slug: "science",
          items: [items[1]],
        },
      ],
    };
    await db.query(
      "INSERT INTO newspapers(account_id,name,slug,description,draft,draft_revision,publication_version,auto_publish) VALUES($1,'Publication pilot',$2,'Public description',$3,7,0,true)",
      [account, account, JSON.stringify(draft)],
    );
    await db.query(
      "INSERT INTO newspaper_feeds(id,account_id,name,slug) VALUES($1,$2,'Live navigation name','science')",
      [feed, account],
    );
    const token = await createMcpToken(account, {
      name: "Synthetic publication pilot",
      scopes: ["read", "publish"],
      days: 7,
    });
    const keyReview = await client.prepare({ token: token.token });
    await client.confirm({ id: keyReview.id, confirmed: true });
    const before = (
      await db.query("SELECT * FROM newspapers WHERE account_id=$1", [account])
    ).rows[0];
    await controller.reviewPublication();
    assert.equal(controller.publicationError, "");
    const review = controller.publicReview!;
    assert.equal(
      review.source.content.navigation[0]!.name,
      "Live navigation name",
    );
    assert.equal(
      review.source.content.snapshot.feeds[0]!.name,
      "Saved feed name",
    );
    assert.ok(!JSON.stringify(review).includes("OMIT_PRIVATE_CONTEXT"));
    assert.ok(!JSON.stringify(review).includes("ranking_score"));
    controller.publicationConfirmed = true;
    await controller.publish();
    assert.equal(controller.publicationError, "");
    const committed = controller.publicationRecord!;
    assert.equal(committed.receipt!.operationId, review.id);
    assert.equal(writes, 1);
    const after = (
      await db.query("SELECT * FROM newspapers WHERE account_id=$1", [account])
    ).rows[0];
    assert.deepEqual(after.snapshot, review.source.content.snapshot);
    assert.deepEqual(after.draft, draft);
    for (const field of Object.keys(before).filter(
      (k) =>
        ![
          "snapshot",
          "published",
          "last_published_at",
          "publication_version",
          "publish_error",
        ].includes(k),
    ))
      assert.deepEqual(after[field], before[field], field);
    const stale = await api("review", {});
    await db.query(
      "UPDATE newspaper_feeds SET name='Changed navigation' WHERE id=$1",
      [feed],
    );
    await assert.rejects(
      api("confirm", {
        id: stale.id,
        confirmed: true,
        audience: "public",
      }),
      /SOURCE_CONFLICT/,
    );
    assert.equal(writes, 1);
    const uncertain = await api("review", {});
    loseResponse = true;
    await assert.rejects(
      api("confirm", {
        id: uncertain.id,
        confirmed: true,
        audience: "public",
      }),
      /NEWS_PUBLICATION_UNCONFIRMED/,
    );
    assert.equal(writes, 2);
    assert.equal(
      Number(
        (
          await db.query(
            "SELECT count(*) n FROM newspaper_editions WHERE account_id=$1",
            [account],
          )
        ).rows[0].n,
      ),
      2,
    );
    const backup = join(dir, "pending.aib");
    await encryptedBackup(store, vault, backup);
    store.close();
    store = new Store(path, vault);
    client = make();
    loseResponse = false;
    await assert.rejects(api("review", {}), /NEWS_PUBLICATION_UNCONFIRMED/);
    await assert.rejects(
      api("confirm", {
        id: uncertain.id,
        confirmed: true,
        audience: "public",
      }),
      /REVIEW_EXPIRED/,
    );
    // Simulate later visibility withdrawal before checking the historical commit. No resend restores it.
    await db.query(
      "UPDATE newspapers SET snapshot=NULL,published=false WHERE account_id=$1",
      [account],
    );
    const reconciled = await api("reconcile", {
      operationId: uncertain.id,
    });
    assert.equal(reconciled.receipt!.historical, true);
    assert.equal(writes, 2);
    const restorePath = join(dir, "restored.db");
    await restoreBackup(backup, vault, restorePath);
    restored = new Store(restorePath, vault);
    assert.equal(
      restored.newsPublications.read(owner, uncertain.id).receipt,
      null,
    );
    const restoredClient = new NewsConnector(
      JSON.stringify(owner),
      secret,
      transport,
      Date.now,
      restored.newsPublications.forOwner(owner),
    );
    assert.deepEqual(
      (await restoredClient.reconcilePublication({ operationId: uncertain.id }))
        .receipt,
      reconciled.receipt,
    );
    assert.equal(writes, 2);
    assert.equal(
      (
        await db.query("SELECT snapshot FROM newspapers WHERE account_id=$1", [
          account,
        ])
      ).rows[0].snapshot,
      null,
    );
    // An unshared private item anywhere in named feeds denies publication, even with a publish-scoped key.
    await db.query("UPDATE items SET owner_id=$2,source_id=$3 WHERE id=$1", [
      items[1]!.id,
      account,
      "private:" + privateSource,
    ]);
    draft.feeds[0]!.items[0]!.source_id = "private:" + privateSource;
    await db.query(
      "UPDATE newspapers SET draft=$2,draft_revision=draft_revision+1 WHERE account_id=$1",
      [account, JSON.stringify(draft)],
    );
    const blocked = await api("review", {});
    assert.equal(blocked.source.eligibility.eligible, false);
    await assert.rejects(
      api("confirm", {
        id: blocked.id,
        confirmed: true,
        audience: "public",
      }),
      /PUBLICATION_BLOCKED/,
    );
    assert.equal(writes, 2);
    await db.query("DELETE FROM mcp_tokens WHERE id=$1", [
      keyReview.connection.credentialId,
    ]);
    await assert.rejects(
      api("reconcile", { operationId: uncertain.id }),
      /SOURCE_DENIED/,
    );
    await client.forget({ confirmed: true });
    const readKey = await createMcpToken(account, {
      name: "Read-only receipt recovery",
      scopes: ["read"],
      days: 7,
    });
    const next = await client.prepare({ token: readKey.token });
    await client.confirm({ id: next.id, confirmed: true });
    assert.deepEqual(
      (await api("reconcile", { operationId: uncertain.id })).receipt,
      reconciled.receipt,
    );
    await assert.rejects(api("review", {}), /PUBLICATION_REQUIRED/);
    assert.equal(writes, 2);
    assert.deepEqual([...new Set(calls)].sort(), [
      "get_connection",
      "get_publication_receipt",
      "get_publication_review",
      "publish_reviewed_preview",
    ]);
    for (const table of [
      "news_subscriptions",
      "deliveries",
      "public_job_claims",
      "public_job_events",
      "editor_jobs",
      "translations",
    ])
      assert.equal(
        Number((await db.query(`SELECT count(*) n FROM ${table}`)).rows[0].n),
        0,
      );
    await controller.loadPublicationHistory();
    assert.equal(controller.publicationHistory!.length, 2);
    await controller.openPublication(uncertain.id);
    assert.deepEqual(controller.publicationRecord!.receipt, reconciled.receipt);
    controller.deletePublicationConfirmed = true;
    await controller.deletePublication();
    assert.equal(controller.publicationRecord, null);
    assert.equal(store.newsPublications.list(owner).length, 1);
    assert.equal(
      Number(
        (
          await db.query(
            "SELECT count(*) n FROM newspaper_editions WHERE account_id=$1",
            [account],
          )
        ).rows[0].n,
      ),
      2,
    );
    console.log(
      "Actual News MCP + authenticated Mac HTTP/controller publication: exact full projection, durable pre-dispatch intent, one write per approval, stale navigation/private-feed denial, response loss, restart and encrypted restore, historical read-only reconciliation after visibility withdrawal, revoked/read-only replacement key, unchanged schedules and zero delivery/processing effects pass.",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await client.cancel();
    restored?.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}
