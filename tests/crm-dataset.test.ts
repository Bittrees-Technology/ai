import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CrmDatasetConnector } from "../modules/connectors/crm-dataset.js";
function fixture(initialCount = 1, paged = false) {
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
  if (initialCount > 1)
    entries = Array.from({ length: initialCount }, (_, i) => ({
      id: randomUUID(),
      kind: "people",
      name: `Synthetic ${i}`,
      ...(paged ? { description: "Grounded source text ".repeat(150) } : {}),
    }));
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
    if (rpc.params.name === "dataset.read") {
      const a = rpc.params.arguments,
        offset = a.offset || 0;
      if (
        a.pageRevision &&
        a.pageRevision !== version.toString(16).padStart(64, "0")
      )
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { isError: true, content: [] },
        });
      result = {
        id: wrongId ? randomUUID() : id,
        name: "Synthetic",
        version,
        revision: paged
          ? version.toString(16).padStart(64, "0")
          : "b".repeat(64),
        entries: paged ? entries.slice(offset, offset + a.pageSize) : entries,
        ...(paged
          ? {
              pagination: {
                offset,
                totalEntries: entries.length,
                nextOffset:
                  offset + a.pageSize < entries.length
                    ? offset + a.pageSize
                    : null,
              },
            }
          : {}),
        crm: [],
        links: [],
      };
    }
    if (rpc.params.name === "dataset.patch") {
      const a = rpc.params.arguments;
      if (a.version !== version)
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { isError: true, content: [] },
        });
      const changed = new Map(a.changes.map((e: any) => [e.id, e]));
      const ids = new Set(entries.map((e) => e.id));
      entries = entries
        .filter((e) => !a.removeIds.includes(e.id))
        .map((e) => changed.get(e.id) || e);
      entries.push(...a.changes.filter((e: any) => !ids.has(e.id)));
      if (a.entryOrder) {
        const byId = new Map(entries.map((e) => [e.id, e]));
        entries = a.entryOrder.map((id: string) => byId.get(id));
      }
      result = { id, version: ++version };
    }
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

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
test("research and task requests queue in order, and a failed write does not stop research", async () => {
  const f = fixture(),
    held = gate(),
    entered = gate();
  let block = false;
  const names: string[] = [];
  const connector = new CrmDatasetConnector(
    "owner",
    f.secret,
    async (url, init) => {
      const rpc = JSON.parse(String(init?.body));
      names.push(rpc.params.name);
      if (block && rpc.params.name === "dataset.read") {
        entered.release();
        await held.promise;
      }
      if (rpc.params.name.startsWith("tasks.")) {
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            ...(rpc.params.name === "tasks.update" ? { isError: true } : {}),
            content: [
              {
                type: "text",
                text: JSON.stringify({ id: randomUUID(), version: 1 }),
              },
            ],
          },
        });
      }
      return f.request(url, init);
    },
  );
  await connector.connect({ token: f.token });
  block = true;
  const read = connector.read();
  await entered.promise;
  const create = connector.project("tasks.create", {}, f.id);
  const update = assert.rejects(
    connector.project("tasks.update", {}, f.id),
    /SOURCE_CONFLICT/,
  );
  const nextRead = connector.read();
  assert.deepEqual(names, ["dataset.read", "dataset.read"]);
  held.release();
  await Promise.all([read, create, update, nextRead]);
  assert.deepEqual(names, [
    "dataset.read",
    "dataset.read",
    "tasks.create",
    "tasks.update",
    "dataset.read",
  ]);
});
for (const change of ["connect", "forget"] as const) {
  test(`queued writes cannot cross a ${change} credential boundary`, async () => {
    const f = fixture(),
      held = gate(),
      entered = gate();
    let block = false;
    const connector = new CrmDatasetConnector(
      "owner",
      f.secret,
      async (url, init) => {
        if (block) {
          block = false;
          entered.release();
          await held.promise;
        }
        return f.request(url, init);
      },
    );
    await connector.connect({ token: f.token });
    block = true;
    const read = connector.read();
    await entered.promise;
    const mutation =
      change === "connect"
        ? connector.connect({ token: "c".repeat(64) })
        : connector.forget();
    const save = assert.rejects(
      connector.save({ version: 1, name: "Old draft", entries: [] }),
      /INVALID_CONNECTION/,
    );
    held.release();
    await Promise.all([read, mutation, save]);
    assert.equal(
      f.calls.filter(
        (c) => JSON.parse(String(c.init.body)).params.name === "dataset.save",
      ).length,
      0,
    );
  });
}

test("source throttling stops repeated reads without starving task writes", async () => {
  const f = fixture();
  let limited = false,
    requests = 0;
  const connector = new CrmDatasetConnector(
    "owner",
    f.secret,
    async (url, init) => {
      requests++;
      const rpc = JSON.parse(String(init?.body));
      if (limited && rpc.params.name === "dataset.read")
        return new Response(null, { status: 429 });
      if (rpc.params.name === "tasks.create")
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ id: randomUUID(), version: 1 }),
              },
            ],
          },
        });
      return f.request(url, init);
    },
  );
  await connector.connect({ token: f.token });
  limited = true;
  await assert.rejects(connector.read(), /SOURCE_RATE_LIMITED/);
  const before = requests;
  await assert.rejects(
    connector.project("tasks.list", {}, f.id),
    /SOURCE_RATE_LIMITED/,
  );
  assert.equal(requests, before);
  await connector.project("tasks.create", {}, f.id);
  assert.equal(requests, before + 1);
});

test("large private datasets can be read and saved without a 600-entry ceiling", async () => {
  const f = fixture(2000);
  await f.connector.connect({ token: f.token });
  const data: any = await f.connector.read();
  assert.equal(data.entries.length, 2000);
  await f.connector.save({
    version: data.version,
    name: data.name,
    entries: data.entries,
  });
  assert.equal(((await f.connector.read()) as any).entries.length, 2000);
});

test("large revision-paged snapshots save small edits atomically and preserve ordering", async () => {
  const f = fixture(2000, true);
  await f.connector.connect({ token: f.token });
  const snapshot: any = await f.connector.read();
  assert.equal(snapshot.entries.length, 2000);
  assert(Buffer.byteLength(JSON.stringify(snapshot)) > 4_000_000);
  assert.equal(
    f.calls.filter(
      (c) => JSON.parse(c.init.body).params.name === "dataset.read",
    ).length,
    40,
  );
  snapshot.entries.reverse();
  snapshot.entries[0].description = "Corrected public business profile";
  await f.connector.save({
    version: snapshot.version,
    name: snapshot.name,
    entries: snapshot.entries,
  });
  const writes = f.calls
    .map((c) => JSON.parse(c.init.body))
    .filter((c) => c.params.name !== "dataset.read");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].params.name, "dataset.patch");
  assert.equal(writes[0].params.arguments.changes.length, 1);
  assert(Buffer.byteLength(JSON.stringify(writes[0])) < 100_000);
  assert.deepEqual(
    ((await f.connector.read()) as any).entries,
    snapshot.entries,
  );
  await assert.rejects(
    () =>
      f.connector.patch({
        version: 1,
        name: snapshot.name,
        changes: [],
        removeIds: [],
      }),
    /SOURCE_CONFLICT/,
  );
});

test("paged reads reject a changed source before returning a partial portfolio", async () => {
  const f = fixture(200, true);
  let conflict = false;
  const connector = new CrmDatasetConnector(
    "owner",
    f.secret,
    async (url, init) => {
      const response = await f.request(url, init),
        rpc = JSON.parse(String(init?.body));
      if (conflict && rpc.params.arguments.offset) {
        const body = await response.json();
        const page = JSON.parse(body.result.content[0].text);
        page.revision = "e".repeat(64);
        body.result.content[0].text = JSON.stringify(page);
        return Response.json(body);
      }
      return response;
    },
  );
  await connector.connect({ token: f.token });
  conflict = true;
  await assert.rejects(() => connector.read(), /SOURCE_CONFLICT/);
  assert(
    !f.calls.some(
      (c) => JSON.parse(c.init.body).params.name !== "dataset.read",
    ),
  );
});
