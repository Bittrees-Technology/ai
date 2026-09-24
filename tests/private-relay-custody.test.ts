import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
import { PrivateRelayCustody } from "../modules/remote/private-relay-custody.js";
import type {
  PrivateRelayEnrollment,
  PrivateRelayGrant,
} from "../modules/remote/private-relay-enrollment.js";
import type { PrivateRelayClient } from "../modules/remote/private-relay-client.js";
const owner = { userId: "synthetic", tenantId: "personal" };
class Slot {
  value?: Uint8Array;
  beforeAdd?: () => Promise<void>;
  afterAdd?: () => Promise<void>;
  failDelete = false;
  async getSecret() {
    return this.value ? Uint8Array.from(this.value) : undefined;
  }
  async addSecretIfAbsent(value: Uint8Array) {
    await this.beforeAdd?.();
    if (this.value) return false;
    this.value = Uint8Array.from(value);
    await this.afterAdd?.();
    return true;
  }
  async deleteCredential() {
    if (this.failDelete) throw Error("synthetic OS failure");
    const found = !!this.value;
    this.value = undefined;
    return found;
  }
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "relay-custody-"));
  const path = join(dir, "tasks.db"),
    vault = new Vault(randomBytes(32));
  const stores: Store[] = [];
  const db = (p = path) => {
    const s = new Store(p, vault);
    stores.push(s);
    return s;
  };
  const store = db();
  let now = 1800000000000,
    mono = 1;
  const binding = {
    ownerId: randomUUID(),
    deviceId: randomUUID(),
    credentialEpoch: 1,
    expiresAt: now + 3600000,
  };
  let grant: PrivateRelayGrant = {
    id: randomUUID(),
    ownerId: binding.ownerId,
    endpointKind: "mac",
    endpointId: binding.deviceId,
    credentialEpoch: 1,
    operationId: randomUUID(),
    revision: 1,
    state: "pending",
    createdAt: now - 1,
    expiresAt: now + 1800000,
    approvalExpiresAt: now + 60000,
    revokedAt: null,
  };
  const credential = randomBytes(32).toString("base64url");
  const slots = new Map<string, { key: Slot; attempt: Slot; deleted: Slot }>();
  const controls = {
    accepts: 0,
    revokes: 0,
    requests: 0,
    loseAccept: false,
    loseRevoke: false,
    wrongIdentity: false,
    onSlot: undefined as
      undefined | ((s: { key: Slot; attempt: Slot; deleted: Slot }) => void),
    afterAccept: undefined as undefined | (() => Promise<void>),
    transport: undefined as undefined | typeof fetch,
  };
  const entries = {
    forSlot(_owner: unknown, id: string) {
      let s = slots.get(id);
      if (!s) {
        s = { key: new Slot(), attempt: new Slot(), deleted: new Slot() };
        slots.set(id, s);
        controls.onSlot?.(s);
      }
      return s;
    },
  };
  const enrollment: PrivateRelayEnrollment = {
    async withPrivateRelayEnrollment(action) {
      let closed = false;
      try {
        return await action({
          current: () => (closed ? null : structuredClone(binding)),
          inspect: async () => structuredClone(grant),
          accept: async (raw) => {
            assert.deepEqual(raw, {
              id: grant.id,
              expectedRevision: grant.revision,
              confirmed: true,
            });
            assert.equal(grant.state, "pending");
            controls.accepts++;
            grant = {
              ...grant,
              revision: grant.revision + 1,
              state: "active",
              approvalExpiresAt: null,
            };
            await controls.afterAccept?.();
            if (controls.loseAccept) throw Error("lost acceptance response");
            return {
              grant: structuredClone(grant),
              credential,
              scope: "private:relay",
            };
          },
          identifyRelay: async (secret) => {
            assert.equal(secret, credential);
            return {
              version: 1,
              scope: "private:relay",
              ownerId: controls.wrongIdentity ? randomUUID() : binding.ownerId,
              endpointId: binding.deviceId,
              endpointKind: "mac",
              credentialEpoch: binding.credentialEpoch,
              permissionId: grant.id,
              expiresAt: grant.expiresAt,
            };
          },
          revokeRelay: async (secret, raw) => {
            assert.equal(secret, credential);
            assert.deepEqual(raw, {
              id: grant.id,
              expectedRevision: grant.revision,
              confirmed: true,
            });
            controls.revokes++;
            grant = {
              ...grant,
              state: "revoked",
              revision: grant.revision + 1,
              revokedAt: now,
            };
            if (controls.loseRevoke) throw Error("lost revoke response");
            return structuredClone(grant);
          },
        });
      } finally {
        closed = true;
      }
    },
  };
  const transport: typeof fetch = async (...args) => {
    controls.requests++;
    if (controls.transport) return controls.transport(...args);
    const response = new Response(
      JSON.stringify({ items: [], nextCursor: null }),
      { headers: { "content-type": "application/json" } },
    );
    Object.defineProperty(response, "url", { value: String(args[0]) });
    return response;
  };
  const custody = (s = store, o = owner) =>
    new PrivateRelayCustody(
      s,
      vault,
      o,
      entries,
      enrollment,
      transport,
      () => now,
      () => mono,
    );
  const c = custody();
  const activate = async (client = c) => {
    const review = await client.review({ id: grant.id });
    return client.confirm({ reviewId: review.reviewId, confirmed: true });
  };
  return {
    dir,
    path,
    vault,
    store,
    db,
    slots,
    controls,
    c,
    custody,
    activate,
    credential,
    binding,
    grant: () => grant,
    change: (patch: Partial<PrivateRelayGrant>) => {
      grant = { ...grant, ...patch };
    },
    advance: (ms: number) => {
      now += ms;
      mono += ms;
    },
    close: () => {
      for (const s of stores) s.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const target = (r: { id: string; revision: number }) => ({
  id: r.id,
  expectedRevision: r.revision,
  confirmed: true as const,
});
test("Relay custody persists only encrypted metadata, reopens OS custody and closes escaped clients", async () => {
  const f = fixture();
  try {
    const active = await f.activate();
    assert.equal(active.active, true);
    const raw = f.store.db
      .prepare("SELECT * FROM private_relay_credentials")
      .all();
    assert.ok(!JSON.stringify(raw).includes(f.credential));
    assert.ok(!JSON.stringify(f.c.list()).includes(f.credential));
    assert.equal(f.c.list().restoreAuthority, false);
    const reopened = f.custody(f.db());
    let escaped!: PrivateRelayClient;
    assert.deepEqual(
      await reopened.withClient(
        { id: active.id, expectedRevision: active.revision },
        async (client) => {
          escaped = client;
          return client.poll({ after: null, limit: 1 });
        },
      ),
      { items: [], nextCursor: null },
    );
    await assert.rejects(escaped.poll({ after: null, limit: 1 }));
    assert.equal(f.controls.requests, 1);
    assert.deepEqual(
      f.custody(f.db(), { ...owner, userId: "other" }).list().items,
      [],
    );
  } finally {
    f.close();
  }
});
test("Review is one-use, expires, and rejects an unrelated grant before issuance", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.c.review({ id: randomUUID() }), /DENIED/);
    const r = await f.c.review({ id: f.grant().id });
    f.advance(60000);
    await assert.rejects(
      f.c.confirm({ reviewId: r.reviewId, confirmed: true }),
      /DENIED/,
    );
    await assert.rejects(
      f.c.confirm({ reviewId: r.reviewId, confirmed: true }),
      /DENIED/,
    );
    assert.equal(f.controls.accepts, 0);
  } finally {
    f.close();
  }
});
test("Lost one-use acceptance stays fenced across reopen and metadata reconciliation", async () => {
  const f = fixture();
  try {
    f.controls.loseAccept = true;
    await assert.rejects(f.activate(), /lost acceptance/);
    const row = f.c.list().items[0]!;
    assert.equal(row.phase, "accepting");
    const reopened = f.custody(f.db());
    const result = await reopened.reconcile(target(row));
    assert.equal(result.active, false);
    assert.equal(result.repairRequired, true);
    await assert.rejects(
      reopened.withClient(
        { id: row.id, expectedRevision: result.revision },
        async () => true,
      ),
      /DENIED/,
    );
    await assert.rejects(f.activate(), /DENIED/);
    assert.equal(f.controls.accepts, 1);
  } finally {
    f.close();
  }
});
test("Concurrent handles reserve a grant once before its one-use response returns", async () => {
  const f = fixture(),
    entered = latch(),
    release = latch();
  try {
    const second = f.custody(f.db());
    const r1 = await f.c.review({ id: f.grant().id }),
      r2 = await second.review({ id: f.grant().id });
    f.controls.afterAccept = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = f.c.confirm({ reviewId: r1.reviewId, confirmed: true });
    await entered.promise;
    await assert.rejects(
      second.confirm({ reviewId: r2.reviewId, confirmed: true }),
      /CONFLICT/,
    );
    release.resolve();
    await pending;
    assert.equal(f.controls.accepts, 1);
  } finally {
    release.resolve();
    f.close();
  }
});
test("Deletion during a delayed native write persists a tombstone and prevents late activation", async () => {
  const f = fixture(),
    entered = latch(),
    release = latch();
  try {
    f.controls.onSlot = (slots) => {
      slots.key.beforeAdd = async () => {
        entered.resolve();
        await release.promise;
      };
    };
    const pending = f.activate();
    const rejected = assert.rejects(pending);
    await entered.promise;
    const row = f.c.list().items[0]!;
    assert.equal(row.phase, "storing");
    await f.c.remove(target(row));
    assert.ok(f.slots.get(row.id)!.deleted.value);
    release.resolve();
    await rejected;
    assert.equal(f.slots.get(row.id)!.key.value, undefined);
    assert.equal(f.c.list().items[0]!.phase, "deleted");
    await f.c.cleanup({ after: null, limit: 20, confirmed: true });
    assert.equal(f.controls.accepts, 1);
  } finally {
    release.resolve();
    f.close();
  }
});
test("Global deletion during acceptance cannot create usable credentials", async () => {
  const f = fixture(),
    entered = latch(),
    release = latch();
  try {
    f.controls.afterAccept = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = f.activate();
    const rejected = assert.rejects(pending);
    await entered.promise;
    f.store.deleteAll(owner);
    release.resolve();
    await rejected;
    const row = f.c.list().items[0]!;
    assert.equal(row.phase, "deleted");
    assert.equal(row.permission, null);
    assert.equal(f.slots.get(row.id)!.key.value, undefined);
  } finally {
    release.resolve();
    f.close();
  }
});
test("Local stop retains separate revocation ability and reconciles a lost revoke reply", async () => {
  const f = fixture();
  try {
    const a = await f.activate(),
      stopped = f.c.stop(target(a));
    await assert.rejects(
      f.c.withClient(
        { id: a.id, expectedRevision: stopped.revision },
        async () => true,
      ),
      /DENIED/,
    );
    f.controls.loseRevoke = true;
    await assert.rejects(f.c.revoke(target(stopped)), /lost revoke/);
    const row = f.c.list().items[0]!;
    assert.equal(row.locked, true);
    const reconciled = await f.c.revoke(target(row));
    assert.equal(reconciled.remoteRevocationConfirmed, true);
    assert.equal(f.controls.revokes, 1);
    assert.equal(f.c.list().items[0]!.permission!.state, "revoked");
  } finally {
    f.close();
  }
});
test("Reconciliation rejects permission replacement, rollback and resurrection", async () => {
  const f = fixture();
  try {
    const a = await f.activate(),
      original = f.grant();
    f.change({ id: randomUUID() });
    await assert.rejects(f.c.reconcile(target(a)), /INVALID_RESPONSE/);
    f.change({ ...original, revision: 1 });
    await assert.rejects(f.c.reconcile(target(a)), /INVALID_RESPONSE/);
    f.change(original);
    const revoked = await f.c.revoke(target(a)),
      state = f.grant();
    f.change({ ...original, revision: state.revision + 1 });
    await assert.rejects(f.c.reconcile(target(revoked)), /INVALID_RESPONSE/);
  } finally {
    f.close();
  }
});
test("Wrong relay identity and corrupted OS secret never reach message transport", async () => {
  const f = fixture();
  try {
    const a = await f.activate();
    f.controls.wrongIdentity = true;
    await assert.rejects(
      f.c.withClient({ id: a.id, expectedRevision: a.revision }, async (c) =>
        c.poll({ after: null, limit: 1 }),
      ),
      /DENIED/,
    );
    f.controls.wrongIdentity = false;
    f.slots.get(a.id)!.key.value = Buffer.from("{}");
    await assert.rejects(
      f.c.withClient(
        { id: a.id, expectedRevision: a.revision },
        async () => true,
      ),
      /STORAGE_UNAVAILABLE/,
    );
    assert.equal(f.controls.requests, 0);
  } finally {
    f.close();
  }
});
test("Failed native deletion remains fenced and is retryable after reopening", async () => {
  const f = fixture();
  try {
    const a = await f.activate(),
      slots = f.slots.get(a.id)!;
    slots.key.failDelete = true;
    await assert.rejects(f.c.remove(target(a)), /STORAGE_UNAVAILABLE/);
    assert.equal(f.c.list().items[0]!.phase, "deleting");
    assert.ok(slots.deleted.value);
    slots.key.failDelete = false;
    await f.custody(f.db()).cleanup({ after: null, limit: 1, confirmed: true });
    assert.equal(slots.key.value, undefined);
    assert.equal(f.c.list().items[0]!.phase, "deleted");
  } finally {
    f.close();
  }
});
test("Encrypted task backup restores metadata with relay authority locked", async () => {
  const f = fixture();
  try {
    const a = await f.activate(),
      backup = join(f.dir, "backup.enc"),
      restored = join(f.dir, "restored.db");
    await encryptedBackup(f.store, f.vault, backup);
    await restoreBackup(backup, f.vault, restored);
    const c = f.custody(f.db(restored)),
      row = c.list().items[0]!;
    assert.equal(row.locked, true);
    assert.ok(row.revision > a.revision);
    await assert.rejects(
      c.withClient(
        { id: row.id, expectedRevision: row.revision },
        async () => true,
      ),
      /DENIED/,
    );
    const result = await c.reconcile(target(row));
    assert.equal(result.active, false);
  } finally {
    f.close();
  }
});
test("Native write interruption leaves reconciliation disabled even if the OS entry exists", async () => {
  const f = fixture();
  try {
    f.controls.onSlot = (slots) => {
      slots.key.afterAdd = async () => {
        throw Error("lost OS write response");
      };
    };
    await assert.rejects(f.activate(), /STORAGE_UNAVAILABLE/);
    const row = f.c.list().items[0]!;
    assert.equal(row.phase, "storing");
    assert.ok(f.slots.get(row.id)!.key.value);
    const result = await f.custody(f.db()).reconcile(target(row));
    assert.equal(result.active, false);
    assert.equal(result.repairRequired, true);
    await f.c.remove({
      id: row.id,
      expectedRevision: result.revision,
      confirmed: true,
    });
    assert.equal(f.slots.get(row.id)!.key.value, undefined);
  } finally {
    f.close();
  }
});
test("Local stop during a delayed OS write never permits late activation", async () => {
  const f = fixture(),
    entered = latch(),
    release = latch();
  try {
    f.controls.onSlot = (slots) => {
      slots.key.beforeAdd = async () => {
        entered.resolve();
        await release.promise;
      };
    };
    const rejected = assert.rejects(f.activate());
    await entered.promise;
    const row = f.c.list().items[0]!,
      stopped = f.c.stop(target(row));
    release.resolve();
    await rejected;
    assert.equal(f.c.list().items[0]!.phase, "stopped");
    assert.ok(f.slots.get(row.id)!.key.value);
    const revoked = await f.c.revoke(target(stopped));
    assert.equal(revoked.remoteRevocationConfirmed, true);
  } finally {
    release.resolve();
    f.close();
  }
});
test("Global deletion fences a held network response through another open database handle", async () => {
  const f = fixture(),
    entered = latch(),
    release = latch();
  try {
    const a = await f.activate();
    f.controls.transport = async (url) => {
      entered.resolve();
      await release.promise;
      const response = Response.json({ items: [], nextCursor: null });
      Object.defineProperty(response, "url", { value: String(url) });
      return response;
    };
    const pending = f.c.withClient(
      { id: a.id, expectedRevision: a.revision },
      (c) => c.poll({ after: null, limit: 1 }),
    );
    const rejected = assert.rejects(pending);
    await entered.promise;
    f.db().deleteAll(owner);
    release.resolve();
    await rejected;
    assert.equal(f.c.list().items[0]!.phase, "deleting");
    assert.equal(f.controls.requests, 1);
    await f.c.cleanup({ after: null, limit: 20, confirmed: true });
  } finally {
    release.resolve();
    f.close();
  }
});
test("Returned review metadata cannot mutate the internal confirmation snapshot", async () => {
  const f = fixture();
  try {
    const review = await f.c.review({ id: f.grant().id });
    review.binding.credentialEpoch = 900;
    review.permission.id = randomUUID();
    const active = await f.c.confirm({
      reviewId: review.reviewId,
      confirmed: true,
    });
    assert.equal(active.permission.id, f.grant().id);
    assert.equal(active.permission.credentialEpoch, 1);
  } finally {
    f.close();
  }
});
