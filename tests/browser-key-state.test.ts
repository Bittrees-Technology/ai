import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  newBrowserRecoveryCode,
  browserRecoveryKey,
  createBrowserKeyMaterial,
  openBrowserKeyRecovery,
} from "../modules/remote/browser-key-recovery.js";
import { browserLifecycleSchema } from "../modules/remote/browser-key-state.js";
test("Recovery codes carry random 256-bit material, reopen exact kits and reject passwords or noncanonical input", async () => {
  const code = newBrowserRecoveryCode(),
    second = newBrowserRecoveryCode();
  assert.match(code, /^btre1_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(code, second);
  const id = {
      localOwner: "synthetic",
      keyId: randomUUID(),
      keyEpoch: 1,
      binding: {
        ownerId: randomUUID(),
        deviceId: randomUUID(),
        credentialEpoch: 1,
        expiresAt: Date.now() + 60000,
      },
    },
    key = await browserRecoveryKey(code);
  assert.equal(key.extractable, false);
  const made = await createBrowserKeyMaterial(id, key);
  assert.equal(
    (
      await openBrowserKeyRecovery(
        made.recovery,
        await browserRecoveryKey(code),
      )
    ).publicKey,
    made.publicKey,
  );
  await assert.rejects(
    openBrowserKeyRecovery(made.recovery, await browserRecoveryKey(second)),
    /BROWSER_KEY_RECOVERY_FAILED/,
  );
  for (const bad of [
    "password",
    code + "=",
    code + " ",
    code.replace("btre1_", "btr1_"),
    "btre1_" + "A".repeat(42),
    null,
    code.slice(0, -1) + "B",
  ])
    await assert.rejects(
      browserRecoveryKey(bad as string),
      /BROWSER_KEY_RECOVERY_FAILED/,
    );
});
test("Lifecycle records cannot contain duplicate slots, multiple selected keys or active locked/deleted material", () => {
  const binding = {
      ownerId: randomUUID(),
      deviceId: randomUUID(),
      credentialEpoch: 1,
      expiresAt: Date.now() + 60000,
    },
    slot = {
      id: randomUUID(),
      keyEpoch: 1,
      binding,
      createdAt: Date.now(),
      state: "active",
      publicKey: "A".repeat(87),
    },
    base = {
      scope: "a".repeat(64),
      revision: 1,
      ownerId: binding.ownerId,
      deviceId: binding.deviceId,
      locked: false,
      slots: [slot],
    };
  browserLifecycleSchema.parse(base);
  for (const bad of [
    { ...base, revision: 0 },
    { ...base, locked: true },
    { ...base, slots: [slot, slot] },
    { ...base, slots: [slot, { ...slot, id: randomUUID(), keyEpoch: 2 }] },
    { ...base, slots: [{ ...slot, state: "deleted" }] },
    { ...base, slots: [{ ...slot, publicKey: null }] },
    { ...base, ownerId: randomUUID() },
    { ...base, deviceId: randomUUID() },
    { ...base, grant: true },
  ])
    assert.equal(browserLifecycleSchema.safeParse(bad).success, false);
  // Retired legacy keys can have equal epochs on different devices; fresh selections use max + 1.
  browserLifecycleSchema.parse({
    ...base,
    slots: [
      { ...slot, state: "retired" },
      {
        ...slot,
        id: randomUUID(),
        binding: { ...binding, deviceId: randomUUID() },
        state: "retired",
      },
    ],
  });
});
