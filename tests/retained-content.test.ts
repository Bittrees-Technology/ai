import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  rm,
  readdir,
  symlink,
} from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../modules/storage/store.js";
import { MemoryStore } from "../modules/memory/store.js";
import { Vault } from "../modules/storage/vault.js";
import { createContentBackup } from "../modules/storage/content-backup.js";
import { activateContentBackup } from "../apps/companion/active-content.js";
import { retainedContent } from "../apps/companion/retained-content.js";
import { dashboardServer } from "../apps/companion/dashboard-server.js";
const owner = { userId: "local-owner", tenantId: "personal" };
test("retained copies protect active/rollback stores and delete only reviewed older data", async () => {
  const base = await mkdtemp(join(tmpdir(), "retained-content-")),
    key = randomBytes(32),
    vault = new Vault(key);
  const entry = {
    getSecret: async () => key,
    setSecret: async () => {
      throw Error();
    },
  };
  try {
    const tasks = new Store(join(base, "tasks.db"), vault),
      memory = new MemoryStore(
        join(base, "memory.db"),
        vault,
        async () => false,
      );
    const file = join(base, "keep-backup.aib");
    try {
      tasks.create(
        owner,
        {
          conversationId: "c",
          kind: "query",
          prompt: "synthetic",
          modelProfileId: "p",
        },
        "seed",
      );
      await createContentBackup(tasks, memory, vault, file);
    } finally {
      tasks.close();
      memory.close();
    }
    await mkdir(join(base, "model-imports"));
    await writeFile(join(base, "model-imports", "jobs.db"), "keep imports");
    await writeFile(join(base, "pairing-code.txt"), "keep pairing");
    const first = await activateContentBackup(file, base, entry, 0);
    const previous = await activateContentBackup(file, base, entry, 0);
    const active = await activateContentBackup(file, base, entry, 0);
    const manager = retainedContent(base, active.directory),
      page = await manager.list();
    assert.equal(page.items.length, 4);
    for (const id of [
      basename(previous.directory),
      basename(active.directory),
    ]) {
      const row = page.items.find((item) => item.id === id)!;
      assert.ok(row.protectedAs);
      await assert.rejects(manager.remove(id, row.review), /CONFLICT/);
    }
    const pending = manager.list();
    await assert.rejects(
      manager.remove("original", "a".repeat(64)),
      /CONFLICT/,
    );
    await pending;
    const old = page.items.find(
      (item) => item.id === basename(first.directory),
    )!;
    await writeFile(
      join(first.directory, "RECOVERY.json"),
      "changed since review",
    );
    await assert.rejects(manager.remove(old.id, old.review), /CONFLICT/);
    const fresh = (await manager.list()).items.find(
      (item) => item.id === old.id,
    )!;
    await manager.remove(fresh.id, fresh.review);
    assert.equal((await readdir(join(base, "stores"))).includes(old.id), false);
    const original = (await manager.list()).items.find(
      (item) => item.id === "original",
    )!;
    assert.equal(original.protectedAs, null);
    await manager.remove(original.id, original.review);
    assert.equal((await readdir(base)).includes("tasks.db"), false);
    assert.equal((await readdir(base)).includes("memory.db"), false);
    assert.equal(
      await readFile(join(base, "pairing-code.txt"), "utf8"),
      "keep pairing",
    );
    assert.equal(
      await readFile(join(base, "model-imports", "jobs.db"), "utf8"),
      "keep imports",
    );
    assert.ok((await readFile(file)).length > 0);
    assert.equal((await manager.list()).items.length, 2);
    // A changed on-disk selection cannot let an old running engine delete content.
    await activateContentBackup(file, base, entry, 0);
    await assert.rejects(manager.list(), /CONFLICT/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
test("retained copy pagination is bounded and symlinks, unexpected files and path injection cannot be deleted", async () => {
  const base = await mkdtemp(join(tmpdir(), "retained-pages-"));
  try {
    await writeFile(join(base, "tasks.db"), "active");
    await mkdir(join(base, "stores"));
    for (let i = 0; i < 105; i++) {
      const dir = join(
        base,
        "stores",
        "bittrees-ai-recovered-" + String(i).padStart(6, "0"),
      );
      await mkdir(dir);
      await writeFile(join(dir, "tasks.db"), "synthetic");
    }
    const manager = retainedContent(base, base);
    const first = await manager.list(),
      second = await manager.list(first.nextCursor!),
      third = await manager.list(second.nextCursor!);
    assert.deepEqual(
      [first.items.length, second.items.length, third.items.length],
      [50, 50, 6],
    );
    assert.equal(
      new Set(
        [...first.items, ...second.items, ...third.items].map((x) => x.id),
      ).size,
      106,
    );
    assert.equal(third.nextCursor, null);
    await assert.rejects(
      manager.remove("../tasks.db", "a".repeat(64)),
      /INVALID_INPUT/,
    );
    await assert.rejects(manager.list("../"), /INVALID_INPUT/);
    const row = first.items[0]!,
      path = join(base, "stores", row.id);
    await writeFile(join(path, "unrelated.txt"), "keep");
    await assert.rejects(manager.remove(row.id, row.review), /INVALID_INPUT/);
    assert.equal(await readFile(join(path, "unrelated.txt"), "utf8"), "keep");
    await rm(join(path, "unrelated.txt"));
    await rm(join(path, "tasks.db"));
    await symlink(join(base, "tasks.db"), join(path, "tasks.db"));
    await assert.rejects(manager.remove(row.id, row.review), /INVALID_INPUT/);
    assert.equal(await readFile(join(base, "tasks.db"), "utf8"), "active");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
test("paired retained-copy routes reject unpaired, cross-origin, unconfirmed and caller-path deletion", async () => {
  const base = await mkdtemp(join(tmpdir(), "retained-http-")),
    vault = new Vault(randomBytes(32));
  const store = new Store(join(base, "tasks.db"), vault),
    server = createServer();
  const id = "bittrees-ai-recovered-ABC123";
  await mkdir(join(base, "stores", id), { recursive: true });
  await writeFile(join(base, "stores", id, "tasks.db"), "synthetic older copy");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port,
    origin = "http://127.0.0.1:" + port;
  server.on(
    "request",
    dashboardServer({
      store,
      owner,
      token: "a".repeat(64),
      port,
      pairCode: "b".repeat(24),
      assets: "apps/dashboard",
      retainedCopies: retainedContent(base, base),
    }),
  );
  const post = (
    path: string,
    body: unknown,
    extra: Record<string, string> = {},
  ) =>
    fetch(origin + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, ...extra },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await fetch(origin + "/v1/recovery-copies")).status, 401);
    const pairing = await post("/pair", { code: "b".repeat(24) }),
      Cookie = pairing.headers.get("set-cookie")!.split(";")[0]!;
    const response = await fetch(origin + "/v1/recovery-copies", {
      headers: { Cookie },
    });
    assert.equal(response.status, 200);
    const page = await response.json(),
      row = page.items.find((item: { id: string }) => item.id === id);
    assert.equal(JSON.stringify(page).includes(base), false);
    const body = { id, review: row.review, confirmed: true };
    assert.equal((await post("/v1/recovery-copies/delete", body)).status, 401);
    assert.equal(
      (
        await post("/v1/recovery-copies/delete", body, {
          Cookie,
          Origin: "https://foreign.invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await post(
          "/v1/recovery-copies/delete",
          { ...body, confirmed: false },
          { Cookie },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await post(
          "/v1/recovery-copies/delete",
          { ...body, path: base },
          { Cookie },
        )
      ).status,
      400,
    );
    const original = page.items.find(
      (item: { id: string }) => item.id === "original",
    );
    assert.equal(
      (
        await post(
          "/v1/recovery-copies/delete",
          { ...body, id: "original", review: original.review },
          { Cookie },
        )
      ).status,
      409,
    );
    assert.equal(
      (await post("/v1/recovery-copies/delete", body, { Cookie })).status,
      200,
    );
    assert.equal((await readdir(join(base, "stores"))).length, 0);
    assert.equal((await post("/logout", {}, { Cookie })).status, 204);
    assert.equal(
      (await fetch(origin + "/v1/recovery-copies", { headers: { Cookie } }))
        .status,
      401,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    await rm(base, { recursive: true, force: true });
  }
});
