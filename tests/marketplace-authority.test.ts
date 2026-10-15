import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import {
  LocalAuthority,
  AuthorityDenied,
} from "../modules/coordinator/local-authority.js";
import { MarketplaceCoordinator } from "../modules/coordinator/workflow.js";
import { LocalRunStore } from "../modules/coordinator/local-store.js";
import { Vault } from "../modules/storage/vault.js";

test("explicit standing grant is owner-bound, scoped, and revocable", () => {
  const db = new Database(":memory:");
  const auth = new LocalAuthority(db);
  const id = auth.grant("owner", "until-revoked");
  auth.check("owner", id, "crm:preview");
  assert.throws(() => auth.check("other", id, "crm:preview"), AuthorityDenied);
  assert.throws(() => auth.check("owner", id, "crm:approve"), AuthorityDenied);
  assert.throws(() => auth.grant("owner", undefined as any));
  auth.revoke("other", id);
  auth.check("owner", id, "sync");
  auth.revoke("owner", id);
  assert.throws(() => auth.check("owner", id, "sync"), AuthorityDenied);
  assert.equal(
    (
      db
        .prepare("SELECT count(*) AS n FROM marketplace_authority_events")
        .get() as { n: number }
    ).n,
    2,
  );
  db.close();
});

test("revocation during status prevents the subsequent proposal and releases the lease", async () => {
  const db = new Database(":memory:");
  const auth = new LocalAuthority(db),
    owner = randomUUID();
  const grant = auth.grant(owner, "until-revoked");
  const store = new LocalRunStore(db, new Vault(randomBytes(32)));
  let calls = 0;
  const coordinator = new MarketplaceCoordinator(
    store,
    [{ ownerId: owner, token: "a".repeat(64), expiresAt: Date.now() + 60000 }],
    async () => {
      calls++;
      auth.revoke(owner, grant);
      return new Response(
        JSON.stringify({
          result: { structuredContent: { state: "not_found" } },
        }),
      );
    },
    (who, action) => auth.check(who, grant, action),
  );
  const id = randomUUID();
  await coordinator.create(owner, {
    id,
    crm: { candidates: [{}] },
    mercado: [{ product: {} }],
  });
  await assert.rejects(coordinator.advance(owner, id), AuthorityDenied);
  assert.equal(calls, 1);
  assert(await store.claim(owner, id, "new-lease"));
  db.close();
});

test("expired grants fail closed and remote denial stops without retry", async () => {
  const db = new Database(":memory:");
  const auth = new LocalAuthority(db),
    owner = randomUUID();
  const grant = auth.grant(owner, Date.now() + 60000);
  db.prepare("UPDATE marketplace_authority SET expires_at=1 WHERE id=?").run(
    grant,
  );
  assert.throws(() => auth.check(owner, grant, "crm:status"), AuthorityDenied);
  const active = auth.grant(owner, "until-revoked");
  const store = new LocalRunStore(db, new Vault(randomBytes(32)));
  let calls = 0;
  const coordinator = new MarketplaceCoordinator(
    store,
    [{ ownerId: owner, token: "a".repeat(64), expiresAt: Date.now() + 60000 }],
    async () => {
      calls++;
      return new Response("denied", { status: 403 });
    },
    (who, action) => auth.check(who, active, action),
  );
  const id = randomUUID();
  await coordinator.create(owner, {
    id,
    crm: { candidates: [{}] },
    mercado: [{ product: {} }],
  });
  await assert.rejects(coordinator.advance(owner, id), AuthorityDenied);
  assert.equal(calls, 1);
  db.close();
});
