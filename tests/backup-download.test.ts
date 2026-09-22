import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Store } from "../modules/storage/store.js";
import { MemoryStore } from "../modules/memory/store.js";
import { Vault } from "../modules/storage/vault.js";
import { restoreContentBackup } from "../modules/storage/content-backup.js";
import { localBackupDownload } from "../apps/companion/backup.js";
import { dashboardServer } from "../apps/companion/dashboard-server.js";
import { requestBackup } from "../apps/dashboard/backup-download.js";
test("paired backup download requires confirmation, rejects foreign origins and restores both stores", async () => {
  const dir = mkdtempSync(join(tmpdir(), "backup-download-")),
    vault = new Vault(randomBytes(32)),
    owner = { userId: "local-owner", tenantId: "personal" };
  const store = new Store(":memory:", vault),
    memory = new MemoryStore(":memory:", vault, async () => true),
    server = createServer();
  let restored: Store | undefined,
    restoredMemory: MemoryStore | undefined,
    calls = 0;
  const download = localBackupDownload(store, memory, vault);
  const task = store.create(
    owner,
    {
      conversationId: "c",
      kind: "query",
      prompt: "PRIVATE_DOWNLOAD_TASK",
      modelProfileId: "p",
    },
    "task",
  );
  const item = await memory.add(owner, {
    type: "preference",
    text: "PRIVATE_DOWNLOAD_MEMORY",
    origin: "model",
    sources: [
      {
        app: "crm",
        tenantId: "personal",
        resourceId: "selected",
        revision: "1",
      },
    ],
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port,
    origin = "http://127.0.0.1:" + port;
  server.on(
    "request",
    dashboardServer({
      store,
      memory,
      owner,
      token: "a".repeat(64),
      port,
      pairCode: "b".repeat(24),
      assets: "apps/dashboard",
      backupDownload: () => {
        calls++;
        return download();
      },
    }),
  );
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(origin + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post("/v1/backup", { confirmed: true })).status, 401);
    assert.equal(calls, 0);
    const paired = await post("/pair", { code: "b".repeat(24) }),
      Cookie = paired.headers.get("set-cookie")!.split(";")[0]!;
    assert.equal(
      (
        await post(
          "/v1/backup",
          { confirmed: true },
          { Cookie, Origin: "https://foreign.invalid" },
        )
      ).status,
      403,
    );
    assert.equal(
      (await post("/v1/backup", { confirmed: false }, { Cookie })).status,
      400,
    );
    assert.equal(
      (
        await post(
          "/v1/backup",
          { confirmed: true, path: "/arbitrary" },
          { Cookie },
        )
      ).status,
      400,
    );
    assert.equal(calls, 0);
    const blob = await requestBackup(async (path, init) => {
      const response = await fetch(origin + path, {
        ...init,
        headers: { ...init?.headers, Origin: origin, Cookie },
      });
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(response.headers.get("content-disposition")!, /attachment/);
      return response;
    });
    assert.equal(calls, 1);
    const bytes = Buffer.from(await blob.arrayBuffer());
    assert.equal(bytes.includes("PRIVATE_"), false);
    const file = join(dir, "download.aib");
    writeFileSync(file, bytes);
    const target = await restoreContentBackup(file, vault, dir);
    restored = new Store(join(target, "tasks.db"), vault);
    restoredMemory = new MemoryStore(
      join(target, "memory.db"),
      vault,
      async () => true,
    );
    assert.equal(
      restored.get(owner, task.id).input.prompt,
      "PRIVATE_DOWNLOAD_TASK",
    );
    assert.equal(
      (await restoredMemory.get(owner, item.id)).text,
      "PRIVATE_DOWNLOAD_MEMORY",
    );
    const first = download();
    await assert.rejects(download(), /CONFLICT/);
    await first;
    await post("/logout", {}, { Cookie });
    assert.equal(
      (await post("/v1/backup", { confirmed: true }, { Cookie })).status,
      401,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    restoredMemory?.close();
    restored?.close();
    memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("backup client rejects invalid, oversized and failed responses without retries", async () => {
  let calls = 0;
  await assert.rejects(
    requestBackup(async () => {
      calls++;
      return Response.json({ error: "CONFLICT" }, { status: 409 });
    }),
    /CONFLICT/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    requestBackup(async () => Response.json({ unexpected: true })),
    /LOCAL_INVALID_RESPONSE/,
  );
  await assert.rejects(
    requestBackup(
      async () =>
        new Response("too big", {
          headers: { "Content-Type": "application/octet-stream" },
        }),
      1000,
      3,
    ),
    /CAPACITY/,
  );
  await assert.rejects(
    requestBackup(async () => {
      throw new TypeError("network");
    }),
    /LOCAL_UNAVAILABLE/,
  );
});

test("backup client deadline includes a stalled response body", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.write("partial");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  try {
    await assert.rejects(
      requestBackup((path, init) => fetch(origin + path, init), 200),
      /LOCAL_TIMEOUT/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
