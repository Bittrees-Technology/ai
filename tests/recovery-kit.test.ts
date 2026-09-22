import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, webcrypto } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createRecoveryKit,
  recoverStorageKey,
  RecoveryKitError,
  recoveryKitBytes,
} from "../modules/storage/recovery-kit.js";
import {
  prepareUserRecoveryKit,
  recoverContentWithKit,
} from "../apps/companion/key-recovery.js";
import { createContentBackup } from "../modules/storage/content-backup.js";
import { Store } from "../modules/storage/store.js";
import { MemoryStore } from "../modules/memory/store.js";
import { Vault } from "../modules/storage/vault.js";
test("recovery kit is fixed-size, randomized, and decrypts only with its separate generated code", () => {
  const key = randomBytes(32),
    copy = Buffer.from(key),
    first = createRecoveryKit(key),
    second = createRecoveryKit(key);
  assert.equal(first.kit.length, recoveryKitBytes);
  assert.match(first.recoveryCode, /^btr1_[A-Za-z0-9_-]{43}$/);
  assert.equal(first.kitId.length, 32);
  assert.notEqual(first.recoveryCode, second.recoveryCode);
  assert.notDeepEqual(first.kit, second.kit);
  assert.equal(first.kit.includes(key), false);
  assert.equal(first.kit.includes(Buffer.from(first.recoveryCode)), false);
  const recovered = recoverStorageKey(first.kit, first.recoveryCode);
  assert.deepEqual(recovered, key);
  recovered.fill(0);
  assert.deepEqual(key, copy);
  assert.throws(
    () => recoverStorageKey(first.kit, second.recoveryCode),
    RecoveryKitError,
  );
  assert.throws(() => createRecoveryKit(Buffer.alloc(31)), RecoveryKitError);
});
test("every kit byte is authenticated; malformed codes and alternate encodings fail with fixed errors", () => {
  const { kit, recoveryCode } = createRecoveryKit(randomBytes(32));
  for (let offset = 0; offset < kit.length; offset++) {
    const changed = Buffer.from(kit);
    changed[offset] = changed[offset]! ^ 1;
    assert.throws(() => recoverStorageKey(changed, recoveryCode), {
      message: "INVALID_RECOVERY_KIT",
    });
  }
  for (const bad of [
    kit.subarray(1),
    Buffer.concat([kit, Buffer.alloc(1)]),
    Buffer.alloc(10000),
  ])
    assert.throws(() => recoverStorageKey(bad, recoveryCode), RecoveryKitError);
  for (const bad of [
    "",
    "password",
    recoveryCode + "=",
    " " + recoveryCode,
    recoveryCode.replace("btr1_", "btr2_"),
    "x".repeat(10000),
  ])
    assert.throws(() => recoverStorageKey(kit, bad), {
      message: "INVALID_RECOVERY_KIT",
    });
  // Base64url's unused bits must be canonical, not another spelling of one key.
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet.indexOf(recoveryCode.at(-1)!);
  assert.throws(
    () =>
      recoverStorageKey(kit, recoveryCode.slice(0, -1) + alphabet[last + 1]),
    RecoveryKitError,
  );
});
test("v1 layout interoperates with WebCrypto HKDF and AES-GCM in both directions", async () => {
  const info = Buffer.from("org.bittrees.ai/local-storage-recovery/v1");
  const derive = async (code: Buffer, salt: Buffer) => {
    const material = await webcrypto.subtle.importKey(
      "raw",
      new Uint8Array(code),
      "HKDF",
      false,
      ["deriveKey"],
    );
    return webcrypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(salt), info },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  };
  const storage = Buffer.alloc(32, 7),
    secret = Buffer.alloc(32, 1),
    salt = Buffer.alloc(32, 2),
    nonce = Buffer.alloc(12, 3);
  const header = Buffer.concat([
    Buffer.from("BTKEY01\n"),
    Buffer.alloc(16, 4),
    salt,
    nonce,
  ]);
  const encrypted = await webcrypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: Buffer.concat([info, header]),
      tagLength: 128,
    },
    await derive(secret, salt),
    storage,
  );
  assert.deepEqual(
    recoverStorageKey(
      Buffer.concat([header, Buffer.from(encrypted)]),
      "btr1_" + secret.toString("base64url"),
    ),
    storage,
  );
  const created = createRecoveryKit(storage),
    bytes = created.kit;
  const result = await webcrypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytes.subarray(56, 68),
      additionalData: Buffer.concat([info, bytes.subarray(0, 68)]),
      tagLength: 128,
    },
    await derive(
      Buffer.from(created.recoveryCode.slice(5), "base64url"),
      bytes.subarray(24, 56),
    ),
    bytes.subarray(68),
  );
  assert.deepEqual(Buffer.from(result), storage);
});
test("kit preparation requires an existing key and recovered backup copy needs no Keychain access", async () => {
  const base = await mkdtemp(join(tmpdir(), "kit-recovery-")),
    key = randomBytes(32),
    vault = new Vault(key);
  const owner = { userId: "a", tenantId: "personal" },
    stores: Store[] = [],
    memories: MemoryStore[] = [];
  let reads = 0;
  const entry = {
    getSecret: async () => {
      reads++;
      return key;
    },
    setSecret: async () => {
      assert.fail("no key writes");
    },
  };
  try {
    const tasks = new Store(join(base, "tasks.db"), vault);
    stores.push(tasks);
    const memory = new MemoryStore(
      join(base, "memory.db"),
      vault,
      async () => true,
    );
    memories.push(memory);
    const task = tasks.create(
      owner,
      {
        conversationId: "c",
        kind: "query",
        prompt: "synthetic recovery",
        modelProfileId: "p",
      },
      "seed",
    );
    const item = await memory.add(owner, {
      type: "preference",
      text: "synthetic kit memory",
      origin: "model",
      sources: [
        {
          app: "crm",
          tenantId: "personal",
          resourceId: "synthetic",
          revision: "1",
        },
      ],
    });
    const file = join(base, "content.aib");
    await createContentBackup(tasks, memory, vault, file);
    const prepared = await prepareUserRecoveryKit(entry);
    assert.equal(reads, 1);
    const result = await recoverContentWithKit(
      file,
      base,
      prepared.kit,
      prepared.recoveryCode,
      0,
    );
    assert.equal(result.activated, false);
    assert.equal(result.keyInstalled, false);
    const recovered = new Store(join(result.directory, "tasks.db"), vault);
    stores.push(recovered);
    const recoveredMemory = new MemoryStore(
      join(result.directory, "memory.db"),
      vault,
      async () => true,
    );
    memories.push(recoveredMemory);
    assert.equal(
      recovered.get(owner, task.id).input.prompt,
      "synthetic recovery",
    );
    assert.equal(
      (await recoveredMemory.get(owner, item.id)).text,
      "synthetic kit memory",
    );
    assert.equal(reads, 1);
    const before = await readdir(base);
    const unrelated = createRecoveryKit(randomBytes(32));
    await assert.rejects(
      recoverContentWithKit(
        file,
        base,
        prepared.kit,
        unrelated.recoveryCode,
        0,
      ),
      /RECOVERY_KIT_REJECTED/,
    );
    await assert.rejects(
      recoverContentWithKit(
        file,
        base,
        unrelated.kit,
        unrelated.recoveryCode,
        0,
      ),
      /BACKUP_RESTORE_FAILED/,
    );
    assert.deepEqual(await readdir(base), before);
    for (const getSecret of [
      async () => undefined,
      async () => Buffer.alloc(3),
      async () => {
        throw Error("private details");
      },
    ])
      await assert.rejects(
        prepareUserRecoveryKit({ ...entry, getSecret }),
        /ORIGINAL_KEY_UNAVAILABLE/,
      );
  } finally {
    for (const m of memories) m.close();
    for (const s of stores) s.close();
    await rm(base, { recursive: true, force: true });
  }
});
test("kit copy recovery obeys the same offline port exclusion", async () => {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(
      recoverContentWithKit(
        "missing",
        "missing",
        Buffer.alloc(0),
        "",
        (server.address() as AddressInfo).port,
      ),
      /COMPANION_RUNNING_OR_PORT_UNAVAILABLE/,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
