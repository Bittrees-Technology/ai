import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { Vault } from "../modules/storage/vault.js";
import { LocalRunStore } from "../modules/coordinator/local-store.js";
import {
  syncLocalStatus,
  syncAuthority,
} from "../modules/coordinator/status-sync.js";
test("Local encrypted runs preserve leases and only sync allowlisted progress after receipt", async () => {
  const db = new Database(":memory:"),
    vault = new Vault(randomBytes(32)),
    store = new LocalRunStore(db, vault),
    owner = randomUUID(),
    id = randomUUID();
  const steps = [
    {
      source: "crm" as const,
      operationId: randomUUID(),
      payload: { secret: "private evidence" },
      state: "pending",
    },
  ];
  await store.create(owner, id, { secret: "private evidence" }, steps);
  await store.create(owner, id, { secret: "private evidence" }, steps);
  assert(
    !JSON.stringify(
      db.prepare("SELECT * FROM marketplace_local_runs").get(),
    ).includes("private evidence"),
  );
  await assert.rejects(store.get(randomUUID(), id));
  assert(await store.claim(owner, id, "first"));
  assert.equal(await store.claim(owner, id, "other"), undefined);
  await assert.rejects(store.save(id, "other", steps));
  await store.save(id, "first", steps);
  await store.release(id, "first");
  await assert.rejects(
    syncLocalStatus(store, owner, "x", async () => {
      throw Error("offline");
    }),
  );
  assert.equal(store.pending(owner).length, 1);
  await syncLocalStatus(store, owner, "x", async (_u, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(body), ["runId", "revision", "counts"]);
    assert(!JSON.stringify(body).includes("private evidence"));
    return new Response(JSON.stringify(body));
  });
  assert.equal(store.pending(owner).length, 0);
  db.close();
});
test("Sync authority requires exact expiring owner-bound bearer", () => {
  const token = "a".repeat(64),
    grant = {
      ownerId: randomUUID(),
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: 100,
    };
  assert.equal(syncAuthority("Bearer " + token, [grant], 99), grant);
  assert.throws(() => syncAuthority("Bearer " + token, [grant], 100));
  assert.throws(() => syncAuthority("Bearer " + "b".repeat(64), [grant], 99));
});
