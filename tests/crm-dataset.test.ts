import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CrmDatasetConnector } from "../modules/connectors/crm-dataset.js";
function fixture() {
  let bytes: Uint8Array | undefined,
    revoked = false,
    wrongId = false;
  const id = randomUUID(),
    token = "a".repeat(64),
    calls: any[] = [];
  let version = 1,
    entries: any[] = [
      {
        id: randomUUID(),
        kind: "projects",
        name: "Synthetic",
        description: "Original",
      },
    ];
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
  const request: typeof fetch = async (url, init) => {
    calls.push({ url, init });
    const rpc = JSON.parse(String(init?.body));
    if (revoked) return Response.json({ error: token }, { status: 401 });
    let result: any;
    if (rpc.params.name === "dataset.read")
      result = {
        id: wrongId ? randomUUID() : id,
        name: "Synthetic",
        version,
        revision: "b".repeat(64),
        entries,
        crm: [],
        links: [],
      };
    if (rpc.params.name === "dataset.save") {
      if (rpc.params.arguments.version !== version)
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { isError: true, content: [{ type: "text", text: token }] },
        });
      entries = rpc.params.arguments.entries;
      result = { id, version: ++version };
    }
    return Response.json({
      jsonrpc: "2.0",
      id: rpc.id,
      result: { content: [{ type: "text", text: JSON.stringify(result) }] },
    });
  };
  return {
    id,
    token,
    calls,
    secret,
    request,
    connector: new CrmDatasetConnector("owner", secret, request),
    revoke() {
      revoked = true;
    },
    wrong() {
      wrongId = true;
    },
  };
}
test("dataset connector binds one dataset, saves through MCP, fences conflicts and revocation", async () => {
  const f = fixture();
  await f.connector.connect({ token: f.token });
  assert(!JSON.stringify(await f.connector.status()).includes(f.token));
  const d: any = await f.connector.read();
  d.entries[0].description = "Revised";
  const payload = { version: d.version, name: d.name, entries: d.entries };
  await f.connector.save(payload);
  assert.equal(
    ((await f.connector.read()) as any).entries[0].description,
    "Revised",
  );
  await assert.rejects(() => f.connector.save(payload), /SOURCE_CONFLICT/);
  for (const c of f.calls) {
    assert.equal(
      c.url,
      "https://crm.bittrees.org/api/integrations/datasets/mcp",
    );
    assert.equal(c.init.redirect, "error");
    assert.equal(c.init.headers.Authorization, `Bearer ${f.token}`);
  }
  await assert.rejects(
    () => new CrmDatasetConnector("other", f.secret, f.request).read(),
    /INVALID_CONNECTION/,
  );
  f.wrong();
  await assert.rejects(() => f.connector.read(), /INVALID_SOURCE/);
  f.revoke();
  await assert.rejects(() => f.connector.read(), /SOURCE_DENIED/);
  await f.connector.forget();
  assert.equal(await f.connector.status(), null);
});
test("dataset API requires local authentication and rejects origin and publication requests", async () => {
  const { createServer } = await import("node:http"),
    { Store } = await import("../modules/storage/store.js"),
    { Vault } = await import("../modules/storage/vault.js"),
    { localApi } = await import("../apps/companion/http.js");
  const f = fixture(),
    store = new Store(":memory:", new Vault(Buffer.alloc(32, 4))),
    server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port,
    token = "local-test-credential".repeat(3);
  server.on(
    "request",
    localApi({
      store,
      owner: { userId: "owner", tenantId: "personal" },
      token,
      port,
      dataset: f.connector,
    }),
  );
  const call = (path: string, body: unknown, headers = {}) =>
    fetch(`http://127.0.0.1:${port}/v1/connections/dataset` + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (await call("/connect", { token: f.token }, { Authorization: "" }))
        .status,
      401,
    );
    assert.equal(
      (
        await call(
          "/connect",
          { token: f.token },
          { Origin: "https://evil.example" },
        )
      ).status,
      403,
    );
    assert.equal((await call("/connect", { token: f.token })).status, 200);
    const read = await call("/read", {});
    assert.equal(read.status, 200);
    assert(!(await read.text()).includes(f.token));
    assert.equal((await call("/approve", {})).status, 404);
    assert.equal(
      (
        await call("/save", {
          version: 1,
          name: "Invalid",
          entries: [],
          workspaceId: randomUUID(),
        })
      ).status,
      400,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});

test("research append fences connection replacement before any source write", async () => {
  const f = fixture();
  await f.connector.connect({ token: f.token });
  const before = f.calls.length;
  await assert.rejects(() =>
    f.connector.append(
      {
        version: 1,
        entries: [{ id: randomUUID(), kind: "people", name: "Test" }],
      },
      randomUUID(),
    ),
  );
  assert.equal(f.calls.length, before);
});
