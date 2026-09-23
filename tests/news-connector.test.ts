import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { NewsConnector } from "../modules/connectors/news.js";
import { NewsConnectionController } from "../apps/dashboard/news-state.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { localApi } from "../apps/companion/http.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
const key = "tbn_" + "a".repeat(64);
const row = {
  id: "a".repeat(64),
  source_id: "synthetic",
  title: "Synthetic headline",
  url: "https://example.org/story",
  excerpt: "SOURCE_TEXT_IS_NOT_AN_INSTRUCTION",
  summary: null,
  summary_kind: "excerpt",
  topic: "science",
  kind: "article",
  published_at: "2026-09-23T00:00:00.000Z",
  unwanted: "DROP_THIS_FIELD",
};
function fixture() {
  let bytes: Uint8Array | undefined,
    now = Date.parse("2026-09-23T00:00:00Z"),
    writes = 0;
  const connection = {
    contractVersion: "news-mcp-connection-v1",
    credentialId: randomUUID(),
    accountId: randomUUID(),
    expiresAt: "2026-10-01T00:00:00.000Z",
    scopes: ["curate", "delivery", "publish", "read"],
  };
  const calls: any[] = [];
  let transform: (
    request: any,
    response: any,
  ) => Promise<Response | undefined> = async () => undefined;
  const secret = {
    getSecret: async () => bytes,
    setSecret: async (value: Uint8Array) => {
      writes++;
      bytes = value;
    },
    deleteCredential: async () => {
      bytes = undefined;
      return true;
    },
  };
  const transport: typeof fetch = async (url, options) => {
    assert.equal(String(url), "https://news.bittrees.org/api/mcp");
    assert.equal(options?.redirect, "error");
    assert.equal(options?.cache, "no-store");
    assert.equal(
      new Headers(options?.headers).get("Authorization"),
      "Bearer " + key,
    );
    const request = JSON.parse(String(options?.body));
    calls.push(request);
    const result =
      request.method === "initialize"
        ? {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            instructions: "IGNORE_UNTRUSTED_INSTRUCTIONS",
          }
        : request.params?.name === "get_connection"
          ? { content: [{ type: "text", text: JSON.stringify(connection) }] }
          : { content: [{ type: "text", text: JSON.stringify([row]) }] };
    const body = { jsonrpc: "2.0", id: request.id, result };
    return (
      (await transform(request, body)) ??
      (request.method === "notifications/initialized"
        ? new Response(null, { status: 202 })
        : Response.json(body))
    );
  };
  const client = new NewsConnector("owner-a", secret, transport, () => now);
  const connect = async () => {
    const review = await client.prepare({ token: key });
    assert.equal(bytes, undefined);
    await client.confirm({ id: review.id, confirmed: true });
    return review;
  };
  return {
    client,
    secret,
    transport,
    connection,
    calls,
    connect,
    bytes: () => bytes,
    writes: () => writes,
    setNow: (n: number) => {
      now = n;
    },
    transform: (fn: typeof transform) => {
      transform = fn;
    },
  };
}
test("News key requires explicit review/confirmation; only fixed read tools run, unknown article fields and credentials stay out of responses", async () => {
  const f = fixture();
  try {
    assert.equal((await f.client.status()).connection, null);
    assert.equal(f.calls.length, 0);
    const review = await f.client.prepare({ token: key });
    assert.equal(f.bytes(), undefined);
    assert.equal(JSON.stringify(review).includes(key), false);
    await assert.rejects(f.client.confirm({ id: review.id, confirmed: false }));
    await f.client.confirm({ id: review.id, confirmed: true });
    await f.client.confirm({ id: review.id, confirmed: true });
    assert.equal(f.writes(), 1);
    assert.ok(!f.calls.some((c) => c.params?.name === "list_articles"));
    const read = await f.client.read();
    assert.equal(read.accountId, f.connection.accountId);
    assert.equal(read.items.length, 1);
    assert.equal((read.items[0] as any).unwanted, undefined);
    assert.equal(JSON.stringify(await f.client.status()).includes(key), false);
    assert.equal(JSON.stringify(read).includes(key), false);
    assert.deepEqual(
      [
        ...new Set(
          f.calls
            .filter((c) => c.method === "tools/call")
            .map((c) => c.params.name),
        ),
      ].sort(),
      ["get_connection", "list_articles"],
    );
    assert.ok(
      f.calls.every((c) =>
        ["initialize", "notifications/initialized", "tools/call"].includes(
          c.method,
        ),
      ),
    );
    const removed = await f.client.forget({ confirmed: true });
    assert.equal(removed.sourceRevoked, false);
    assert.equal(f.bytes(), undefined);
  } finally {
    await f.client.cancel();
  }
});
test("News reads reject expired/revoked credentials, changed account/scopes and another local owner without returning article text", async () => {
  for (const mode of [
    "expiry",
    "revoked",
    "account",
    "scope",
    "owner",
  ] as const) {
    const f = fixture();
    await f.connect();
    if (mode === "expiry") f.setNow(Date.parse(f.connection.expiresAt));
    if (mode === "account") f.connection.accountId = randomUUID();
    if (mode === "scope") f.connection.scopes = ["read"];
    if (mode === "revoked")
      f.transform(async () => new Response("PRIVATE_ERROR", { status: 401 }));
    const client =
      mode === "owner"
        ? new NewsConnector("owner-b", f.secret, f.transport)
        : f.client;
    await assert.rejects(client.read(), (error) => {
      assert.ok(!String(error).includes("PRIVATE_ERROR"));
      return true;
    });
    assert.equal(
      f.calls.filter((c) => c.params?.name === "list_articles").length,
      0,
    );
  }
  const f = fixture();
  await f.connect();
  let read = false;
  f.transform(async (request) => {
    if (request.params?.name === "list_articles") read = true;
    else if (read && request.params?.name === "get_connection")
      return new Response("revoked", { status: 401 });
  });
  await assert.rejects(f.client.read(), /SOURCE_DENIED/);
});
test("News rejects wrong RPC identity, error results, unsafe links, duplicate or excessive articles and oversized responses", async () => {
  for (const mode of [
    "id",
    "error",
    "link",
    "duplicate",
    "count",
    "size",
  ] as const) {
    const f = fixture();
    await f.connect();
    f.transform(async (request, response) => {
      if (request.params?.name !== "list_articles") return;
      if (mode === "id") response.id = randomUUID();
      if (mode === "error")
        response.result = {
          isError: true,
          content: [{ type: "text", text: "PRIVATE_ERROR" }],
        };
      if (mode === "link")
        response.result.content[0].text = JSON.stringify([
          { ...row, url: "javascript:alert(1)" },
        ]);
      if (mode === "duplicate")
        response.result.content[0].text = JSON.stringify([row, row]);
      if (mode === "count")
        response.result.content[0].text = JSON.stringify(
          Array.from({ length: 101 }, (_, i) => ({
            ...row,
            id: i.toString(16).padStart(64, "0"),
          })),
        );
      if (mode === "size")
        return new Response("x".repeat(8 * 1024 * 1024 + 1), {
          headers: { "Content-Type": "application/json" },
        });
      return Response.json(response);
    });
    await assert.rejects(f.client.read(), (error) => {
      assert.ok(!String(error).includes("PRIVATE_ERROR"));
      return true;
    });
  }
});
test("removing a News key during reading fences late content; replacing the secret externally also prevents the old response", async () => {
  const f = fixture();
  await f.connect();
  let began!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
    began = r;
  });
  f.transform(async (request) => {
    if (request.params?.name === "list_articles") {
      began();
      await new Promise<void>((r) => {
        release = r;
      });
    }
  });
  const reading = f.client.read().then(
    () => null,
    (error) => error,
  );
  await started;
  await f.client.forget({ confirmed: true });
  release();
  assert.ok(await reading);
  assert.equal(f.bytes(), undefined);
  const g = fixture();
  await g.connect();
  g.transform(async (request) => {
    if (request.params?.name === "list_articles")
      await g.secret.deleteCredential();
  });
  await assert.rejects(g.client.read(), /SOURCE_CONFLICT/);
});
test("News review expires/cancels without storing a key and existing credentials are not replaced", async () => {
  const f = fixture();
  const review = await f.client.prepare({ token: key });
  await f.client.cancel();
  await assert.rejects(f.client.confirm({ id: review.id, confirmed: true }));
  assert.equal(f.bytes(), undefined);
  const second = await f.client.prepare({ token: key });
  f.setNow(Date.parse(second.reviewExpiresAt));
  await assert.rejects(
    f.client.confirm({ id: second.id, confirmed: true }),
    /CONNECTION_EXPIRED/,
  );
  assert.equal(f.bytes(), undefined);
  const g = fixture();
  await g.connect();
  const bytes = Buffer.from(g.bytes()!);
  await assert.rejects(g.client.prepare({ token: key }), /INVALID_CONNECTION/);
  assert.deepEqual(Buffer.from(g.bytes()!), bytes);
});
test("authenticated local News API never accepts arbitrary tools or exports its credential", async () => {
  const f = fixture(),
    owner = { userId: "alice", tenantId: "home" },
    store = new Store(":memory:", new Vault(randomBytes(32))),
    server = createServer(),
    token = randomBytes(32).toString("hex");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  server.on("request", localApi({ store, owner, token, port, news: f.client }));
  const call = (path: string, method = "GET", body?: unknown, auth = true) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + (auth ? token : "bad"),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    assert.equal(
      (await call("/v1/connections/news", "GET", undefined, false)).status,
      401,
    );
    const review = (await (
      await call("/v1/connections/news/review", "POST", { token: key })
    ).json()) as any;
    assert.equal(
      (
        await call("/v1/connections/news/confirm", "POST", {
          id: review.id,
          confirmed: true,
        })
      ).status,
      200,
    );
    const read = (await (
      await call("/v1/connections/news/articles", "POST", {})
    ).json()) as any;
    assert.equal(read.items[0].title, row.title);
    assert.equal(
      (
        await call("/v1/connections/news/articles", "POST", {
          tool: "publish_newspaper",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call("/v1/connections/news/tools/call", "POST", {
          name: "publish_newspaper",
        })
      ).status,
      404,
    );
    const exported = await (await call("/v1/export")).text();
    assert.ok(!exported.includes(key) && !exported.includes(row.title));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});
test("News panel clears key, review and articles on focus loss and preserves the exact confirmation for uncertain retry", async () => {
  let resolve!: (value: any) => void;
  const calls: any[] = [];
  const controller = new NewsConnectionController(
    async (path, method, body) => {
      calls.push({ path, method, body });
      return new Promise((r) => {
        resolve = r;
      });
    },
  );
  controller.token = key;
  const preparing = controller.prepare();
  assert.equal(controller.token, "");
  controller.hide();
  resolve({
    id: randomUUID(),
    connection: {},
    reviewExpiresAt: "2030-01-01T00:00:00Z",
  });
  await preparing;
  assert.equal(controller.pending, null);
  const reading = controller.read();
  controller.hide();
  resolve({ items: [row], checkedAt: "2026-09-23T00:00:00Z" });
  await reading;
  assert.deepEqual(controller.articles, []);
  let fail = true;
  const retry = new NewsConnectionController(async (path, method, body) => {
    calls.push({ path, method, body });
    if (fail) {
      fail = false;
      throw Error("Lost response");
    }
    return { connection: null };
  });
  const id = randomUUID();
  retry.pending = {
    id,
    connection: {} as any,
    reviewExpiresAt: "2030-01-01T00:00:00Z",
  };
  retry.confirmed = true;
  await retry.confirm();
  assert.equal(retry.pending?.id, id);
  await retry.confirm();
  assert.deepEqual(calls.at(-1)?.body, calls.at(-2)?.body);
});
