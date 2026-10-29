import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { NativeInitialPairing } from "../modules/task-sync/initial-pairing.js";
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { encryptedInitialPairingStore } from "../modules/task-sync/initial-pairing-store.js";
import Database from "better-sqlite3";
import { Vault } from "../modules/storage/vault.js";
const identity = {
  principal: "agent:" + randomUUID(),
  keyFingerprint: "a".repeat(64),
};
const state = {
  phase: "starting",
  request: { ...identity, operationId: randomUUID() },
  calls: 1,
  pollSecret: "PRIVATE_SYNTHETIC_MARKER",
  consentId: randomUUID(),
  lastPoll: 0,
} as any;
function fixture(id = identity) {
  const folder = mkdtempSync(join(tmpdir(), "bittrees-pair-journal-")),
    path = join(folder, "fixture.db"),
    db = new Database(path),
    vault = new Vault(randomBytes(32));
  return {
    folder,
    path,
    db,
    vault,
    store: encryptedInitialPairingStore(db, vault, id),
    close() {
      db.close();
      rmSync(folder, { recursive: true });
    },
  };
}
test("actual SQLite encrypted operation survives close/reopen with exact stable operation ID", async () => {
  const f = fixture();
  try {
    assert.equal(await f.store.load(), null);
    await f.store.save(state);
    f.db.close();
    const db = new Database(f.path);
    try {
      const loaded = await encryptedInitialPairingStore(
        db,
        f.vault,
        identity,
      ).load();
      assert.deepEqual(loaded, state);
      assert.equal(
        readFileSync(f.path).includes(Buffer.from(state.pollSecret)),
        false,
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(f.folder, { recursive: true });
  }
});
test("separate SQLite connections cannot both start or overwrite a newer poll", async () => {
  const f = fixture(),
    second = new Database(f.path);
  try {
    const other = encryptedInitialPairingStore(second, f.vault, identity);
    assert.equal(await f.store.load(), null);
    assert.equal(await other.load(), null);
    await f.store.save(state);
    await assert.rejects(other.save(state), /changed/);
    assert.deepEqual(await other.load(), state);
    await f.store.save({ ...state, phase: "held" });
    await assert.rejects(other.save({ ...state, phase: "pending" }), /changed/);
    assert.equal(((await other.load()) as any).phase, "held");
  } finally {
    second.close();
    f.close();
  }
});
test("tampered ciphertext fails closed and cannot be silently replaced", async () => {
  const f = fixture();
  try {
    await f.store.load();
    await f.store.save(state);
    const row = f.db
      .prepare("SELECT sealed FROM native_initial_pairing_journal")
      .get() as { sealed: Buffer };
    row.sealed[30] = row.sealed[30]! ^ 1;
    f.db
      .prepare("UPDATE native_initial_pairing_journal SET sealed=?")
      .run(row.sealed);
    const fresh = encryptedInitialPairingStore(f.db, f.vault, identity);
    await assert.rejects(fresh.load());
    await assert.rejects(fresh.save(state), /Inspect/);
  } finally {
    f.close();
  }
});
test("wrong vault, cross-key state and oversized state are rejected without overwriting existing row", async () => {
  const f = fixture();
  try {
    await f.store.load();
    await f.store.save(state);
    await assert.rejects(
      encryptedInitialPairingStore(
        f.db,
        new Vault(randomBytes(32)),
        identity,
      ).load(),
    );
    await assert.rejects(
      f.store.save({
        ...state,
        request: { ...state.request, keyFingerprint: "b".repeat(64) },
      }),
      /rejected/,
    );
    await assert.rejects(
      f.store.save({ ...state, padding: "x".repeat(65536) }),
      /rejected/,
    );
    assert.deepEqual(await f.store.load(), state);
  } finally {
    f.close();
  }
});

test("real journal keeps unknown start held across NativeInitialPairing restart with no network replay", async () => {
  const keys = generateKeyPairSync("ed25519"),
    publicKey = keys.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    local = { principal: "agent:" + randomUUID(), publicKey },
    keyFingerprint = createHash("sha256").update(publicKey).digest("hex");
  const id = { principal: local.principal, keyFingerprint },
    f = fixture(id),
    consent = { id: randomUUID(), ...id, expiresAt: Date.now() + 60000 };
  let calls = 0;
  const options = {
    identity: local,
    signLocal: async (message: string) =>
      sign(null, Buffer.from(message), keys.privateKey).toString("base64"),
    currentConsent: () => consent,
    rolesPublicKey: publicKey,
    transport: async () => {
      calls++;
      throw Error("source outcome unknown");
    },
  };
  try {
    await assert.rejects(
      new NativeInitialPairing({ ...options, store: f.store }).start(),
      /unknown/,
    );
    const held = (await f.store.load()) as any;
    assert.equal(held.phase, "held");
    f.db.close();
    const db = new Database(f.path);
    try {
      const store = encryptedInitialPairingStore(db, f.vault, id);
      await assert.rejects(
        new NativeInitialPairing({ ...options, store }).start(),
        /Reconcile/,
      );
      assert.equal(
        ((await store.load()) as any).request.operationId,
        held.request.operationId,
      );
      assert.equal(calls, 1);
    } finally {
      db.close();
    }
  } finally {
    rmSync(f.folder, { recursive: true });
  }
});
