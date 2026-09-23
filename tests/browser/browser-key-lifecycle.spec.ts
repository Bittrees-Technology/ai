import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { PrivateBinding } from "../../modules/remote/private-peer-contracts.js";
const make = () => ({
  owner: "synthetic:" + randomUUID(),
  binding: {
    ownerId: randomUUID(),
    deviceId: randomUUID(),
    credentialEpoch: 1,
    expiresAt: Date.now() + 3600000,
  },
  now: Date.now(),
});
async function pageReady(page: Page) {
  await page.goto("/?browser-key-lifecycle");
  await page.waitForFunction(() => !!window.browserLifecycleTest);
}
async function init(page: Page, f = make(), fresh = true) {
  await pageReady(page);
  await page.evaluate(
    ({ f, fresh }) =>
      window.browserLifecycleTest.init(f.owner, f.binding, fresh, f.now),
    { f, fresh },
  );
  return f;
}
async function begin(page: Page, revision = 0) {
  return page.evaluate(
    (expectedRevision) =>
      window.browserLifecycleTest.begin({ expectedRevision, confirmed: true }),
    revision,
  );
}
async function provision(
  page: Page,
  slot: { revision: number; keyId: string },
  code: string,
) {
  return page.evaluate(
    ({ slot, code }) =>
      window.browserLifecycleTest.provision(
        {
          keyId: slot.keyId,
          expectedRevision: slot.revision,
          confirmed: true,
          recoverySaved: true,
        },
        code,
      ),
    { slot, code },
  );
}
async function active(page: Page) {
  const f = await init(page),
    code = await page.evaluate(() => window.browserLifecycleTest.code()),
    slot = await begin(page),
    proof = await provision(page, slot, code);
  return { f, code, slot, proof };
}
test.beforeEach(async ({ context }) => {
  await context.route("**/*", (r) =>
    new URL(r.request().url()).origin === "http://127.0.0.1:44137"
      ? r.continue()
      : r.abort(),
  );
});
test("Fresh registration, revision-bound setup and recovery possession precede a durable active key", async ({
  page,
}) => {
  const f = await init(page, make(), false);
  await expect(begin(page)).rejects.toThrow("SETUP_REQUIRED");
  await page.evaluate(
    (b) => window.browserLifecycleTest.set(b, true),
    f.binding,
  );
  for (const raw of [
    { expectedRevision: 0, confirmed: false },
    { expectedRevision: 0, confirmed: true, keyId: randomUUID() },
    { expectedRevision: 1, confirmed: true },
  ])
    await expect(
      page.evaluate((raw) => window.browserLifecycleTest.begin(raw), raw),
    ).rejects.toThrow();
  const code = await page.evaluate(() => window.browserLifecycleTest.code()),
    slot = await begin(page);
  expect(slot.keyEpoch).toBe(1);
  await expect(
    page.evaluate(() => window.browserLifecycleTest.resolve()),
  ).rejects.toThrow("DENIED");
  await expect(
    page.evaluate(
      ({ slot, code }) =>
        window.browserLifecycleTest.provision(
          {
            keyId: slot.keyId,
            expectedRevision: slot.revision,
            confirmed: true,
            recoverySaved: false,
          },
          code,
        ),
      { slot, code },
    ),
  ).rejects.toThrow("DENIED");
  const proof = await provision(page, slot, code);
  expect(proof.revision).toBe(2);
  expect(
    await page.evaluate((p) => window.browserLifecycleTest.validate(p), proof),
  ).toBe(true);
  expect(await page.evaluate(() => window.browserLifecycleTest.stable())).toBe(
    true,
  );
  const first = await page.evaluate(() =>
    window.browserLifecycleTest.resolve(),
  );
  expect(first.privateExtractable).toBe(false);
  await init(page, f, false);
  expect(
    await page.evaluate(() => window.browserLifecycleTest.resolve()),
  ).toEqual(first);
});
test("Concurrent setup reviews select exactly one key and replacement denies old proofs and primitive bypass", async ({
  page,
  context,
}) => {
  const { f, code, proof } = await active(page),
    other = await context.newPage();
  await init(other, f, false);
  const attempts = await Promise.allSettled([
    begin(page, proof.revision),
    begin(other, proof.revision),
  ]);
  expect(attempts.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  const slot = (
    attempts.find((x) => x.status === "fulfilled") as PromiseFulfilledResult<{
      keyId: string;
      keyEpoch: number;
      revision: number;
    }>
  ).value;
  expect(slot.keyEpoch).toBe(2);
  expect(
    await other.evaluate((p) => window.browserLifecycleTest.validate(p), proof),
  ).toBe(false);
  await expect(
    other.evaluate((a) => window.browserLifecycleTest.unmanaged(a), {
      localOwner: f.owner,
      binding: f.binding,
      keyId: proof.keyId,
      keyEpoch: 1,
      creationAllowed: false,
    }),
  ).rejects.toThrow("DENIED");
  await expect(
    page.evaluate(() => window.browserLifecycleTest.resolve()),
  ).rejects.toThrow("DENIED");
  const second = await provision(other, slot, code);
  expect(second.publicKey).not.toBe(proof.publicKey);
  expect(
    (await page.evaluate(() => window.browserLifecycleTest.resolve())).proof,
  ).toEqual(second);
});
test("Failed activation reopens one durable key and a wrong recovery code cannot activate it", async ({
  page,
}) => {
  await init(page);
  const code = await page.evaluate(() => window.browserLifecycleTest.code()),
    slot = await begin(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      if (
        this.name === "lifecycle" &&
        (args[0] as any).slots.some((x: any) => x.state === "active")
      ) {
        IDBObjectStore.prototype.put = put;
        throw new DOMException("synthetic quota", "QuotaExceededError");
      }
      return put.apply(this, args);
    };
  });
  await expect(provision(page, slot, code)).rejects.toThrow("CAPACITY");
  const kit = await page.evaluate(
      (id) => window.browserLifecycleTest.recovery(id),
      slot.keyId,
    ),
    recovered = await page.evaluate(
      ({ kit, code }) => window.browserLifecycleTest.recover(kit, code),
      { kit, code },
    );
  await page.evaluate(() => window.browserLifecycleTest.reopen());
  const wrong = await page.evaluate(() => window.browserLifecycleTest.code());
  await expect(provision(page, slot, wrong)).rejects.toThrow("DENIED");
  expect(
    (await page.evaluate(() => window.browserLifecycleTest.status())).slots[0]!
      .state,
  ).toBe("preparing");
  const proof = await provision(page, slot, code);
  expect(proof.publicKey).toBe(recovered.publicKey);
  expect(
    await page.evaluate(
      (id) => window.browserLifecycleTest.recovery(id),
      slot.keyId,
    ),
  ).toEqual(kit);
});
test("Interrupted generation stays incomplete; explicit replacement advances the epoch", async ({
  page,
}) => {
  const f = await init(page),
    code = await page.evaluate(() => window.browserLifecycleTest.code()),
    slot = await begin(page);
  await page.evaluate(() => window.browserLifecycleTest.holdGenerate());
  const pending = provision(page, slot, code).catch((e) => String(e));
  await page.waitForFunction(() => window.browserLifecycleTest.held());
  await init(page, f, false);
  await pending;
  await expect(provision(page, slot, code)).rejects.toThrow(
    "CREATION_INCOMPLETE",
  );
  const next = await begin(page, slot.revision);
  expect(next.keyEpoch).toBe(2);
  expect((await provision(page, next, code)).keyId).toBe(next.keyId);
  expect(
    (await page.evaluate(() => window.browserLifecycleTest.status())).slots[0]!
      .state,
  ).toBe("retired");
});
test("Offline removal during another tab generation cannot publish or recover the deleted key", async ({
  page,
  context,
}) => {
  const f = await init(page),
    other = await context.newPage();
  await init(other, f, false);
  const code = await page.evaluate(() => window.browserLifecycleTest.code()),
    slot = await begin(page);
  await page.evaluate(() => window.browserLifecycleTest.holdGenerate());
  const pending = provision(page, slot, code).catch((e) => String(e));
  await page.waitForFunction(() => window.browserLifecycleTest.held());
  await other.evaluate(() => window.browserLifecycleTest.set(null));
  const removed = await other.evaluate(
    (s) =>
      window.browserLifecycleTest.remove({
        keyId: s.keyId,
        expectedRevision: s.revision,
        confirmed: true,
      }),
    slot,
  );
  await page.evaluate(() => window.browserLifecycleTest.release());
  expect(await pending).toMatch(/DENIED|CONFLICT/);
  await expect(
    page.evaluate(() => window.browserLifecycleTest.resolve()),
  ).rejects.toThrow("DENIED");
  await expect(
    other.evaluate(
      (id) => window.browserLifecycleTest.recovery(id),
      slot.keyId,
    ),
  ).rejects.toThrow("DELETED");
  expect(
    (await page.evaluate(() => window.browserLifecycleTest.status())).slots[0]!
      .state,
  ).toBe("deleted");
  expect(
    await other.evaluate(
      ({ slot, removed }) =>
        window.browserLifecycleTest.remove({
          keyId: slot.keyId,
          expectedRevision: removed.revision,
          confirmed: true,
        }),
      { slot, removed },
    ),
  ).toEqual(removed);
});
test("Revocation retains encrypted recovery but clearing locks setup until a different fresh device", async ({
  page,
  context,
}) => {
  const { f, code, proof } = await active(page),
    other = await context.newPage();
  await init(other, f, false);
  const kit = await page.evaluate(
    (id) => window.browserLifecycleTest.recovery(id),
    proof.keyId,
  );
  await page.evaluate(() => window.browserLifecycleTest.set(null));
  const revoked = await page.evaluate(
    (p) =>
      window.browserLifecycleTest.revoke({
        keyId: p.keyId,
        expectedRevision: p.revision,
        confirmed: true,
      }),
    proof,
  );
  expect(
    await other.evaluate((p) => window.browserLifecycleTest.validate(p), proof),
  ).toBe(false);
  expect(
    await page.evaluate(
      (id) => window.browserLifecycleTest.recovery(id),
      proof.keyId,
    ),
  ).toEqual(kit);
  const cleared = await page.evaluate(
    (r) =>
      window.browserLifecycleTest.clear({
        expectedRevision: r.revision,
        confirmed: true,
      }),
    revoked,
  );
  await expect(
    page.evaluate(
      (id) => window.browserLifecycleTest.recovery(id),
      proof.keyId,
    ),
  ).rejects.toThrow("DELETED");
  await page.evaluate(
    (b) => window.browserLifecycleTest.set(b, true),
    f.binding,
  );
  await expect(begin(page, cleared.revision)).rejects.toThrow("SETUP_REQUIRED");
  await expect(
    page.evaluate(
      (r) =>
        window.browserLifecycleTest.reset({
          expectedRevision: r.revision,
          confirmed: true,
        }),
      cleared,
    ),
  ).rejects.toThrow("SETUP_REQUIRED");
  const fresh = { ...f.binding, deviceId: randomUUID(), credentialEpoch: 2 };
  await page.evaluate((b) => window.browserLifecycleTest.set(b, false), fresh);
  await expect(
    page.evaluate(
      (r) =>
        window.browserLifecycleTest.reset({
          expectedRevision: r.revision,
          confirmed: true,
        }),
      cleared,
    ),
  ).rejects.toThrow("SETUP_REQUIRED");
  await page.evaluate((b) => window.browserLifecycleTest.set(b, true), fresh);
  const reset = await page.evaluate(
    (r) =>
      window.browserLifecycleTest.reset({
        expectedRevision: r.revision,
        confirmed: true,
      }),
    cleared,
  );
  const slot = await begin(page, reset.revision);
  expect(slot.keyEpoch).toBe(2);
  const next = await provision(page, slot, code);
  expect(next.binding.deviceId).toBe(fresh.deviceId);
  expect(next.publicKey).not.toBe(proof.publicKey);
  expect(
    (
      await page.evaluate(
        ({ kit, code }) => window.browserLifecycleTest.recover(kit, code),
        { kit, code },
      )
    ).publicKey,
  ).toBe(proof.publicKey);
  expect(
    await page.evaluate((p) => window.browserLifecycleTest.validate(p), proof),
  ).toBe(false);
});
test("Current identity, lease and host invalidation fence key use and late setup publication", async ({
  page,
}) => {
  const { f, proof } = await active(page);
  for (const changed of [
    null,
    { ...f.binding, ownerId: randomUUID() },
    { ...f.binding, deviceId: randomUUID() },
    { ...f.binding, credentialEpoch: 2 },
    { ...f.binding, expiresAt: f.now - 1 },
  ]) {
    await page.evaluate((b) => window.browserLifecycleTest.set(b), changed);
    await expect(
      page.evaluate(() => window.browserLifecycleTest.resolve()),
    ).rejects.toThrow();
    expect(
      await page.evaluate(
        (p) => window.browserLifecycleTest.validate(p),
        proof,
      ),
    ).toBe(false);
  }
  await page.evaluate((b) => window.browserLifecycleTest.set(b), f.binding);
  const code = await page.evaluate(() => window.browserLifecycleTest.code()),
    slot = await begin(page, proof.revision);
  await page.evaluate(() => window.browserLifecycleTest.holdGenerate());
  const pending = provision(page, slot, code).catch((e) => String(e));
  await page.waitForFunction(() => window.browserLifecycleTest.held());
  await page.evaluate((b) => {
    window.browserLifecycleTest.set(null);
    window.browserLifecycleTest.set(b);
    window.browserLifecycleTest.release();
  }, f.binding);
  expect(await pending).toMatch(/DENIED|CONFLICT/);
  expect(
    (await page.evaluate(() => window.browserLifecycleTest.status())).slots.at(
      -1,
    )!.state,
  ).toBe("preparing");
});
test("Another local owner cannot inspect, delete or export a managed key", async ({
  page,
  context,
}) => {
  const { f, proof } = await active(page),
    other = await context.newPage();
  await init(other, { ...f, owner: "other-local-owner" }, false);
  expect(
    (await other.evaluate(() => window.browserLifecycleTest.status())).slots,
  ).toEqual([]);
  await expect(
    other.evaluate(
      (p) =>
        window.browserLifecycleTest.remove({
          keyId: p.keyId,
          expectedRevision: 0,
          confirmed: true,
        }),
      proof,
    ),
  ).rejects.toThrow("MISSING");
  await expect(
    other.evaluate(
      (id) => window.browserLifecycleTest.recovery(id),
      proof.keyId,
    ),
  ).rejects.toThrow("MISSING");
  await expect(begin(other)).rejects.toThrow("SETUP_REQUIRED");
  expect(
    await page.evaluate((p) => window.browserLifecycleTest.validate(p), proof),
  ).toBe(true);
});
test("Lifetime capacity preserves retained slots and stale revisions cannot delete a key", async ({
  page,
}) => {
  const { proof } = await active(page);
  await expect(
    page.evaluate(
      (p) =>
        window.browserLifecycleTest.remove({
          keyId: p.keyId,
          expectedRevision: p.revision - 1,
          confirmed: true,
        }),
      proof,
    ),
  ).rejects.toThrow("CONFLICT");
  expect(
    await page.evaluate((p) => window.browserLifecycleTest.validate(p), proof),
  ).toBe(true);
  let rev = proof.revision;
  for (let n = 1; n < 20; n++) {
    const slot = await begin(page, rev);
    rev = slot.revision;
    expect(slot.keyEpoch).toBe(n + 1);
  }
  await expect(begin(page, rev)).rejects.toThrow("CAPACITY");
  expect(
    (await page.evaluate(() => window.browserLifecycleTest.status())).slots,
  ).toHaveLength(20);
});
test("Actual PR143 schema1 keys and recovery kits survive upgrade without silently granting managed authority", async ({
  page,
}) => {
  const f = make();
  await pageReady(page);
  const code = await page.evaluate(() => window.browserLifecycleTest.code()),
    legacy = {
      localOwner: f.owner,
      binding: f.binding,
      keyId: randomUUID(),
      keyEpoch: 7,
      creationAllowed: true,
    },
    saved = await page.evaluate(
      ({ legacy, code }) =>
        window.browserLifecycleTest.legacySeed(legacy, code),
      { legacy, code },
    );
  await page.evaluate(
    (f) => window.browserLifecycleTest.init(f.owner, f.binding, true, f.now),
    f,
  );
  const status = await page.evaluate(() =>
    window.browserLifecycleTest.status(),
  );
  expect(status.legacySlots).toBe(1);
  expect(status.requiresFreshRegistration).toBe(true);
  await expect(begin(page)).rejects.toThrow("SETUP_REQUIRED");
  await expect(
    page.evaluate((a) => window.browserLifecycleTest.legacyOpen(a), legacy),
  ).rejects.toThrow("STORAGE_UNAVAILABLE");
  expect(
    await page.evaluate(
      (id) => window.browserLifecycleTest.recovery(id),
      legacy.keyId,
    ),
  ).toEqual(saved.kit);
  const before = await page.evaluate(
    ({ kit, code }) => window.browserLifecycleTest.legacyRecover(kit, code),
    { kit: saved.kit, code },
  );
  expect(before.publicKey).toBe(saved.made.publicKey);
  await expect(
    page.evaluate(() =>
      window.browserLifecycleTest.reset({
        expectedRevision: 0,
        confirmed: true,
      }),
    ),
  ).rejects.toThrow("SETUP_REQUIRED");
  const fresh = { ...f.binding, deviceId: randomUUID() };
  await page.evaluate((b) => window.browserLifecycleTest.set(b, true), fresh);
  const reset = await page.evaluate(() =>
    window.browserLifecycleTest.reset({ expectedRevision: 0, confirmed: true }),
  );
  expect(
    (await page.evaluate(() => window.browserLifecycleTest.status())).slots[0]!
      .state,
  ).toBe("retired");
  await expect(
    page.evaluate(() => window.browserLifecycleTest.resolve()),
  ).rejects.toThrow("DENIED");
  const slot = await begin(page, reset.revision);
  expect(slot.keyEpoch).toBe(8);
  expect((await provision(page, slot, code)).publicKey).not.toBe(
    saved.made.publicKey,
  );
  expect(
    await page.evaluate(
      (id) => window.browserLifecycleTest.recovery(id),
      legacy.keyId,
    ),
  ).toEqual(saved.kit);
});

test("An activation acknowledgement lost after commit is reconciled on reload without generating another key", async ({
  page,
}) => {
  const f = await init(page),
    code = await page.evaluate(() => window.browserLifecycleTest.code()),
    slot = await begin(page);
  await expect(
    page.evaluate(
      async ({ slot, code }) => {
        await window.browserLifecycleTest.provision(
          {
            keyId: slot.keyId,
            expectedRevision: slot.revision,
            confirmed: true,
            recoverySaved: true,
          },
          code,
        );
        window.browserLifecycleTest.set(null);
        throw Error("SIMULATED_LOST_ACKNOWLEDGEMENT");
      },
      { slot, code },
    ),
  ).rejects.toThrow("SIMULATED_LOST_ACKNOWLEDGEMENT");
  await init(page, f, false);
  const status = await page.evaluate(() =>
    window.browserLifecycleTest.status(),
  );
  expect(status.revision).toBe(slot.revision + 1);
  expect(status.slots).toHaveLength(1);
  expect(status.slots[0]!.state).toBe("active");
  const resolved = await page.evaluate(() =>
      window.browserLifecycleTest.resolve(),
    ),
    kit = await page.evaluate(
      (id) => window.browserLifecycleTest.recovery(id),
      slot.keyId,
    );
  expect(
    (
      await page.evaluate(
        ({ kit, code }) => window.browserLifecycleTest.recover(kit, code),
        { kit, code },
      )
    ).publicKey,
  ).toBe(resolved.publicKey);
  await expect(provision(page, slot, code)).rejects.toThrow("CONFLICT");
  expect(
    (await page.evaluate(() => window.browserLifecycleTest.resolve())).proof,
  ).toEqual(resolved.proof);
});
