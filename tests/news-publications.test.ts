import test from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
import { NewsConnector } from "../modules/connectors/news.js";
import {
  newsPublicationReviewSchema,
  publicationContract,
} from "../modules/connectors/news-publication-contracts.js";
import { localApi } from "../apps/companion/http.js";
const owner = { userId: "synthetic-owner", tenantId: "personal" };
const other = { userId: "other", tenantId: "personal" };
const key = "tbn_" + "a".repeat(64);
export function sourceReview() {
  const item = {
    id: "a".repeat(64),
    source_id: "synthetic",
    url: "https://example.org/article",
    title: "EXACT_PUBLIC_HEADLINE",
    topic: "science",
    kind: "article",
    published_at: "2026-09-23T00:00:00.000Z",
    excerpt: "EXACT_PUBLIC_EXCERPT",
    summary: "Exact owner text",
    summary_kind: "user_edited",
    user_edited: true,
    original_title: "Original headline",
    authors: ["Public Author"],
    translation: {
      language: "en",
      title: "Translated headline",
      summary: "Translated summary",
      model: "synthetic",
    },
  };
  return newsPublicationReviewSchema.parse({
    contractVersion: publicationContract,
    revision: 7,
    publicationVersion: 2,
    reviewDigest: "b".repeat(64),
    url: "https://news.bittrees.org/synthetic",
    content: {
      name: "Synthetic newspaper",
      slug: "synthetic",
      description: "Public description",
      navigation: [{ name: "Live navigation name", slug: "science" }],
      snapshot: {
        front: [item],
        feeds: [
          {
            id: randomUUID(),
            name: "Saved section name",
            slug: "science",
            items: [{ ...item, title: "FEED_CONTENT_MUST_BE_REVIEWED" }],
          },
        ],
      },
    },
    eligibility: { eligible: true, blockedItemIds: [] },
    previousPublication: {
      published: true,
      lastPublishedAt: "2026-09-22T00:00:00.000Z",
      snapshotDigest: "c".repeat(64),
    },
    observedAt: "2026-09-23T00:00:00.000Z",
  });
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "news-journal-")),
    path = join(dir, "tasks.db"),
    vault = new Vault(randomBytes(32));
  let now = Date.parse("2026-09-23T00:00:00Z"),
    bytes: Uint8Array | undefined;
  let store = new Store(path, vault, () => now);
  const connection = {
    contractVersion: "news-mcp-connection-v1",
    accountId: randomUUID(),
    credentialId: randomUUID(),
    scopes: ["publish", "read"],
    expiresAt: "2026-10-01T00:00:00.000Z",
  };
  let review = sourceReview(),
    receipt: any = null,
    writeCount = 0;
  const calls: string[] = [];
  let effect: (
    name: string,
    request: any,
    result: any,
  ) => Promise<void> = async () => {};
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
    assert.equal(options?.redirect, "error");
    assert.equal(
      new Headers(options?.headers).get("Authorization"),
      "Bearer " + key,
    );
    const request = JSON.parse(String(options?.body)),
      name = request.params?.name;
    if (name) calls.push(name);
    if (request.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    let value: any;
    if (name === "get_connection") value = structuredClone(connection);
    if (name === "get_publication_review") value = structuredClone(review);
    if (name === "publish_reviewed_preview") {
      // Prove the full exact intent is already committed and readable on a second connection.
      const second = new Store(path, vault, () => now);
      try {
        assert.equal(
          second.newsPublications.read(
            owner,
            request.params.arguments.operationId,
          ).review.content.snapshot.feeds[0]!.items[0]!.title,
          "FEED_CONTENT_MUST_BE_REVIEWED",
        );
      } finally {
        second.close();
      }
      writeCount++;
      receipt = {
        contractVersion: publicationContract,
        operationId: request.params.arguments.operationId,
        reviewDigest: review.reviewDigest,
        revision: review.revision,
        publicationVersion: review.publicationVersion + 1,
        url: review.url,
        committedAt: new Date(now).toISOString(),
        status: "published",
        historical: true,
      };
      value = structuredClone(receipt);
    }
    if (name === "get_publication_receipt")
      value = {
        contractVersion: publicationContract,
        receipt: structuredClone(receipt),
      };
    await effect(name, request, value);
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result:
        request.method === "initialize"
          ? { protocolVersion: "2025-11-25", capabilities: { tools: {} } }
          : { content: [{ type: "text", text: JSON.stringify(value) }] },
    });
  };
  const make = () =>
    new NewsConnector(
      JSON.stringify(owner),
      secret,
      transport,
      () => now,
      store.newsPublications.forOwner(owner),
    );
  let client = make();
  return {
    dir,
    path,
    vault,
    connection,
    secret,
    transport,
    calls,
    get client() {
      return client;
    },
    get store() {
      return store;
    },
    get review() {
      return review;
    },
    get receipt() {
      return receipt;
    },
    get writes() {
      return writeCount;
    },
    setNow: (v: number) => {
      now = v;
    },
    effect: (fn: typeof effect) => {
      effect = fn;
    },
    clearReceipt: () => {
      receipt = null;
    },
    connect: async () => {
      const r = await client.prepare({ token: key });
      await client.confirm({ id: r.id, confirmed: true });
    },
    reopen: () => {
      store.close();
      store = new Store(path, vault, () => now);
      client = make();
    },
    close: async () => {
      await client.cancel();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const confirm = (r: { id: string }) => ({
  id: r.id,
  confirmed: true,
  audience: "public",
});
const reservation = (review = sourceReview()) => ({
  operationId: randomUUID(),
  identity: { accountId: randomUUID(), credentialId: randomUUID() },
  review,
  confirmed: true,
  audience: "public",
});

test("publication review preserves front, named feeds, translation, navigation and exact consent; commits durable intent before the only write", async () => {
  const f = fixture();
  try {
    await f.connect();
    const review = await f.client.reviewPublication();
    assert.deepEqual(review.source, f.review);
    assert.equal(f.store.newsPublications.list(owner).length, 0);
    const result = await f.client.confirmPublication(confirm(review));
    assert.equal(f.writes, 1);
    assert.deepEqual(result.receipt, f.receipt);
    assert.equal(result.receipt!.historical, true);
    assert.deepEqual(result.review, f.review);
    assert.ok(!JSON.stringify(result).includes(key));
    await assert.rejects(
      f.client.confirmPublication(confirm(review)),
      /REVIEW_EXPIRED/,
    );
    assert.equal(f.writes, 1);
    f.reopen();
    assert.deepEqual(f.store.newsPublications.read(owner, review.id), result);
    assert.equal(f.writes, 1);
    f.store.db.pragma("wal_checkpoint(TRUNCATE)");
    const raw = readFileSync(f.path);
    for (const secret of [
      key,
      "EXACT_PUBLIC_HEADLINE",
      "EXACT_PUBLIC_EXCERPT",
      f.connection.accountId,
    ])
      assert.equal(raw.includes(Buffer.from(secret)), false);
  } finally {
    await f.close();
  }
});
test("publication is unavailable by default and owner-bound; curation/key consent cannot authorize it", async () => {
  const f = fixture();
  try {
    await f.connect();
    const disabled = new NewsConnector(
      JSON.stringify(owner),
      f.secret,
      f.transport,
    );
    await assert.rejects(
      disabled.reviewPublication(),
      /PUBLICATION_UNAVAILABLE/,
    );
    assert.throws(
      () =>
        new NewsConnector(
          JSON.stringify(other),
          f.secret,
          f.transport,
          Date.now,
          f.store.newsPublications.forOwner(owner),
        ),
      /INVALID_CONNECTION/,
    );
    const r = await f.client.reviewPublication();
    for (const input of [
      { id: r.id, confirmed: true, curate: true },
      { id: r.id, confirmed: false, audience: "public" },
      { ...confirm(r), tool: "publish_newspaper" },
      { ...confirm(r), accountId: f.connection.accountId },
    ])
      await assert.rejects(f.client.confirmPublication(input));
    await f.client.cancel();
    await assert.rejects(
      f.client.confirmPublication(confirm(r)),
      /REVIEW_EXPIRED/,
    );
    await f.client.forget({ confirmed: true });
    f.connection.scopes = ["curate", "read"];
    await f.connect();
    await assert.rejects(f.client.reviewPublication(), /PUBLICATION_REQUIRED/);
    assert.equal(f.writes, 0);
  } finally {
    await f.close();
  }
});
test("strict publication contracts reject hidden/unknown fields, unsafe URLs, duplicate or unreviewable feeds and inconsistent eligibility", () => {
  const base = sourceReview();
  const changes: Array<(r: any) => void> = [
    (r) => (r.content.snapshot.front[0].private = "hidden"),
    (r) => (r.content.snapshot.front[0].translation.private = "hidden"),
    (r) => (r.url = "https://news.bittrees.org.evil.test/x"),
    (r) =>
      (r.content.snapshot.front[0].url = "https://name:pass@example.org/x"),
    (r) => r.content.snapshot.front.push(r.content.snapshot.front[0]),
    (r) => (r.content.snapshot.feeds[0].slug = "missing"),
    (r) => r.content.navigation.push(r.content.navigation[0]),
    (r) => r.eligibility.blockedItemIds.push("f".repeat(64)),
    (r) => (r.content.snapshot.front[0].user_edited = false),
  ];
  for (const change of changes) {
    const r = structuredClone(base);
    change(r);
    assert.equal(newsPublicationReviewSchema.safeParse(r).success, false);
  }
});
test("source content, navigation, sharing, versions, credential changes and expiry invalidate held publication review without dispatch", async () => {
  for (const kind of [
    "front",
    "feed",
    "navigation",
    "previous",
    "revision",
    "blocked",
    "scope",
    "expired",
  ]) {
    const f = fixture();
    try {
      await f.connect();
      const r = await f.client.reviewPublication();
      if (kind === "front")
        f.review.content.snapshot.front[0]!.title = "Changed";
      if (kind === "feed")
        f.review.content.snapshot.feeds[0]!.items[0]!.title = "Changed";
      if (kind === "navigation")
        f.review.content.navigation[0]!.name = "Changed";
      if (kind === "previous")
        f.review.previousPublication.snapshotDigest = "d".repeat(64);
      if (kind === "revision") f.review.revision++;
      if (kind === "blocked")
        f.review.eligibility = {
          eligible: false,
          blockedItemIds: ["a".repeat(64)],
        };
      if (kind === "scope") f.connection.scopes = ["read"];
      if (kind === "expired") f.setNow(Date.parse(r.expiresAt));
      await assert.rejects(
        f.client.confirmPublication(confirm(r)),
        /SOURCE_CONFLICT|REVIEW_EXPIRED/,
      );
      assert.equal(f.writes, 0);
      assert.equal(f.store.newsPublications.list(owner).length, 0);
    } finally {
      await f.close();
    }
  }
});
test("cancel during an in-flight review cannot restore permission; caller mutation cannot alter held content; blocked source is inspectable only", async () => {
  const f = fixture();
  try {
    await f.connect();
    f.effect(async (name) => {
      if (name === "get_publication_review") await f.client.cancel();
    });
    await assert.rejects(f.client.reviewPublication(), /REVIEW_EXPIRED/);
    f.effect(async () => {});
    const r = await f.client.reviewPublication();
    r.source.content.snapshot.front[0]!.title = "FORGED";
    const saved = await f.client.confirmPublication(confirm(r));
    assert.equal(
      saved.review.content.snapshot.front[0]!.title,
      "EXACT_PUBLIC_HEADLINE",
    );
    f.review.eligibility = {
      eligible: false,
      blockedItemIds: ["a".repeat(64)],
    };
    const blocked = await f.client.reviewPublication();
    assert.equal(blocked.source.eligibility.eligible, false);
    await assert.rejects(
      f.client.confirmPublication(confirm(blocked)),
      /PUBLICATION_BLOCKED/,
    );
    assert.equal(f.writes, 1);
  } finally {
    await f.close();
  }
});
test("response loss survives restart, prevents replacement publication and reconciles read-only without another write", async () => {
  const f = fixture();
  try {
    await f.connect();
    const r = await f.client.reviewPublication();
    f.effect(async (name) => {
      if (name === "publish_reviewed_preview") throw Error("lost response");
    });
    await assert.rejects(
      f.client.confirmPublication(confirm(r)),
      /NEWS_PUBLICATION_UNCONFIRMED/,
    );
    assert.equal(f.store.newsPublications.read(owner, r.id).receipt, null);
    f.reopen();
    f.effect(async () => {});
    await assert.rejects(
      f.client.confirmPublication(confirm(r)),
      /REVIEW_EXPIRED/,
    );
    await assert.rejects(
      f.client.reviewPublication(),
      /NEWS_PUBLICATION_UNCONFIRMED/,
    );
    const result = await f.client.reconcilePublication({ operationId: r.id });
    assert.deepEqual(result.receipt, f.receipt);
    assert.equal(f.writes, 1);
    f.clearReceipt();
    const again = await f.client.reconcilePublication({ operationId: r.id });
    assert.deepEqual(again.receipt, result.receipt);
  } finally {
    await f.close();
  }
});
test("source denial/absent receipt remains unconfirmed; a read-only replacement key on same account may reconcile, foreign account cannot", async () => {
  const f = fixture();
  try {
    await f.connect();
    const r = await f.client.reviewPublication();
    f.effect(async (name) => {
      if (name === "publish_reviewed_preview") throw Error("uncertain");
    });
    await assert.rejects(f.client.confirmPublication(confirm(r)));
    f.clearReceipt();
    f.effect(async () => {});
    const absent = await f.client.reconcilePublication({ operationId: r.id });
    assert.equal(absent.receipt, null);
    assert.ok(absent.lastCheckedAt);
    await f.client.forget({ confirmed: true });
    assert.equal(f.store.newsPublications.list(owner).length, 1);
    f.connection.credentialId = randomUUID();
    f.connection.scopes = ["read"];
    await f.connect();
    assert.equal(
      (await f.client.reconcilePublication({ operationId: r.id })).receipt,
      null,
    );
    await f.client.forget({ confirmed: true });
    f.connection.accountId = randomUUID();
    await f.connect();
    const before = f.calls.filter(
      (n) => n === "get_publication_receipt",
    ).length;
    await assert.rejects(
      f.client.reconcilePublication({ operationId: r.id }),
      /SOURCE_CONFLICT/,
    );
    assert.equal(
      f.calls.filter((n) => n === "get_publication_receipt").length,
      before,
    );
    assert.equal(f.writes, 1);
  } finally {
    await f.close();
  }
});
test("failed reservation and uncertain local commit never dispatch; failed receipt persistence leaves an explicitly reconcilable operation", async () => {
  for (const stage of ["before", "after", "receipt"]) {
    const f = fixture();
    try {
      await f.connect();
      const reserve = f.store.newsPublications.reserve.bind(
          f.store.newsPublications,
        ),
        reconcile = f.store.newsPublications.reconcile.bind(
          f.store.newsPublications,
        );
      if (stage !== "receipt")
        f.store.newsPublications.reserve = (o, v) => {
          if (stage === "after") reserve(o, v);
          throw Error("storage fault");
        };
      else
        f.store.newsPublications.reconcile = () => {
          throw Error("receipt persistence fault");
        };
      const r = await f.client.reviewPublication();
      await assert.rejects(f.client.confirmPublication(confirm(r)));
      assert.equal(f.writes, stage === "receipt" ? 1 : 0);
      assert.equal(
        f.store.newsPublications.list(owner).length,
        stage === "before" ? 0 : 1,
      );
      f.store.newsPublications.reserve = reserve;
      f.store.newsPublications.reconcile = reconcile;
      f.reopen();
      if (stage !== "before") {
        const result = await f.client.reconcilePublication({
          operationId: r.id,
        });
        assert.equal(!!result.receipt, stage === "receipt");
      }
      assert.equal(f.writes, stage === "receipt" ? 1 : 0);
    } finally {
      await f.close();
    }
  }
});
test("mismatched receipts cannot resolve an operation; parallel confirmation has one source effect", async () => {
  const f = fixture();
  try {
    await f.connect();
    const r = await f.client.reviewPublication();
    f.effect(async (name, _request, value) => {
      if (name === "publish_reviewed_preview")
        value.url = "https://news.bittrees.org/wrong";
    });
    const outcomes = await Promise.allSettled([
      f.client.confirmPublication(confirm(r)),
      f.client.confirmPublication(confirm(r)),
    ]);
    assert.ok(outcomes.every((o) => o.status === "rejected"));
    assert.equal(f.writes, 1);
    assert.equal(f.store.newsPublications.read(owner, r.id).receipt, null);
    f.effect(async (name, _request, value) => {
      if (name === "get_publication_receipt")
        value.receipt.operationId = randomUUID();
    });
    await assert.rejects(
      f.client.reconcilePublication({ operationId: r.id }),
      /INVALID_SOURCE/,
    );
    assert.equal(f.store.newsPublications.read(owner, r.id).receipt, null);
    f.effect(async () => {});
    assert.ok(
      (await f.client.reconcilePublication({ operationId: r.id })).receipt,
    );
  } finally {
    await f.close();
  }
});
test("journal requires a standalone durable transaction, isolates owners, fences duplicate unresolved intents and rejects swapped ciphertext", async () => {
  const f = fixture();
  try {
    const input = reservation();
    assert.throws(
      () =>
        f.store.db.transaction(() =>
          f.store.newsPublications.reserve(owner, input),
        )(),
      /CONFLICT/,
    );
    f.store.db.pragma("synchronous=NORMAL");
    assert.throws(
      () => f.store.newsPublications.reserve(owner, input),
      /CONFLICT/,
    );
    f.store.db.pragma("synchronous=FULL");
    const record = f.store.newsPublications.reserve(owner, input);
    assert.throws(
      () => f.store.newsPublications.reserve(owner, input),
      /CONFLICT/,
    );
    assert.throws(
      () =>
        f.store.newsPublications.reserve(owner, {
          ...input,
          operationId: randomUUID(),
        }),
      /CONFLICT/,
    );
    assert.throws(
      () => f.store.newsPublications.read(other, input.operationId),
      /NOT_FOUND/,
    );
    assert.deepEqual(f.store.newsPublications.list(other), []);
    const different = reservation();
    f.store.newsPublications.reserve(other, different);
    f.store.db
      .prepare(
        "UPDATE news_publications SET payload=(SELECT payload FROM news_publications WHERE id=?) WHERE id=?",
      )
      .run(record.operationId, different.operationId);
    assert.throws(() =>
      f.store.newsPublications.read(other, different.operationId),
    );
  } finally {
    await f.close();
  }
});
test("encrypted backup/restore retains exact pending intent without replay; explicit deletion stays owner-scoped", async () => {
  const f = fixture();
  let restored: Store | undefined;
  try {
    const input = reservation();
    const record = f.store.newsPublications.reserve(owner, input);
    f.store.newsPublications.reserve(other, reservation());
    const backup = join(f.dir, "backup.aib"),
      destination = join(f.dir, "restored.db");
    await encryptedBackup(f.store, f.vault, backup);
    await restoreBackup(backup, f.vault, destination);
    restored = new Store(destination, f.vault);
    assert.deepEqual(
      restored.newsPublications.read(owner, input.operationId),
      record,
    );
    assert.equal(f.writes, 0);
    assert.throws(() =>
      restored!.newsPublications.remove(owner, {
        operationId: input.operationId,
        confirmed: true,
      }),
    );
    restored.newsPublications.remove(owner, {
      operationId: input.operationId,
      confirmed: true,
      forgetPublicationTracking: true,
    });
    assert.deepEqual(restored.newsPublications.list(owner), []);
    assert.equal(restored.newsPublications.list(other).length, 1);
    f.store.deleteAll(owner);
    assert.deepEqual(f.store.newsPublications.list(owner), []);
    assert.equal(f.store.newsPublications.list(other).length, 1);
  } finally {
    restored?.close();
    await f.close();
  }
});
test("local export includes only own approved publication history without credentials; publication HTTP paths remain unavailable", async () => {
  const f = fixture();
  const token = "test-token-".repeat(8);
  const server = createServer();
  try {
    await f.connect();
    const held = await f.client.reviewPublication();
    f.store.newsPublications.reserve(owner, reservation());
    f.store.newsPublications.reserve(other, reservation());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    server.on(
      "request",
      localApi({ store: f.store, owner, token, port, news: f.client }),
    );
    const call = (path: string, method = "GET") =>
      fetch(`http://127.0.0.1:${port}/v1/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
    const data = (await (await call("export")).json()) as any;
    assert.equal(data.newsPublications.length, 1);
    assert.ok(!JSON.stringify(data).includes(key));
    for (const route of [
      "publication/review",
      "publication/confirm",
      "publication/reconcile",
    ])
      assert.equal(
        (await call("connections/news/" + route, "POST")).status,
        404,
      );
    const deleted = await fetch(`http://127.0.0.1:${port}/v1/data`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Confirm-Delete": "all-local-task-data",
      },
    });
    assert.equal(deleted.status, 204);
    assert.deepEqual(f.store.newsPublications.list(owner), []);
    assert.equal(f.store.newsPublications.list(other).length, 1);
    await assert.rejects(
      f.client.confirmPublication(confirm(held)),
      /REVIEW_EXPIRED/,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.close();
  }
});

// The child exits without Store.close(): verify committed WAL survives process loss.
test("committed intent survives abrupt child exit before dispatch without creating a resume action", async () => {
  const dir = mkdtempSync(join(tmpdir(), "news-journal-crash-"));
  const path = join(dir, "tasks.db"),
    keyBytes = randomBytes(32),
    input = reservation();
  let store: Store | undefined;
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      import {Store} from './modules/storage/store.ts';
      import {Vault} from './modules/storage/vault.ts';
      const [path,key,owner,input] = process.argv.slice(1);
      const s = new Store(path,new Vault(Buffer.from(key,'hex')));
      s.newsPublications.reserve(JSON.parse(owner),JSON.parse(input));
      process.exit(17);
    `,
        path,
        keyBytes.toString("hex"),
        JSON.stringify(owner),
        JSON.stringify(input),
      ],
      { cwd: new URL("../", import.meta.url), encoding: "utf8" },
    );
    assert.equal(result.status, 17, result.stderr);
    store = new Store(path, new Vault(keyBytes));
    const recovered = store.newsPublications.read(owner, input.operationId);
    assert.equal(recovered.receipt, null);
    assert.deepEqual(recovered.review, input.review);
    let requests = 0;
    const client = new NewsConnector(
      JSON.stringify(owner),
      {
        getSecret: async () => undefined,
        setSecret: async () => {},
        deleteCredential: async () => true,
      },
      async () => {
        requests++;
        throw Error("Unexpected dispatch");
      },
      Date.now,
      store.newsPublications.forOwner(owner),
    );
    await assert.rejects(
      client.confirmPublication({
        id: input.operationId,
        confirmed: true,
        audience: "public",
      }),
      /REVIEW_EXPIRED/,
    );
    assert.equal(requests, 0);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
