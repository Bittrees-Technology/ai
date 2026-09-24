import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
const fixture = () => ({
  owner: "synthetic-boundary:" + randomUUID(),
  now: Date.now(),
  binding: {
    ownerId: randomUUID(),
    deviceId: randomUUID(),
    credentialEpoch: 1,
    expiresAt: Date.now() + 3600000,
  },
});
async function ready(page: Page) {
  await page.goto("/?browser-key-lifecycle");
  await page.waitForFunction(() => !!window.browserLifecycleTest);
}
async function fresh(page: Page) {
  const f = fixture();
  await ready(page);
  const saved = await page.evaluate(async (f) => {
    const api = window.browserLifecycleTest;
    await api.init(f.owner, f.binding, true, f.now);
    const code = api.code(),
      slot = await api.begin({ expectedRevision: 0, confirmed: true });
    const proof = await api.provision(
      {
        keyId: slot.keyId,
        expectedRevision: slot.revision,
        confirmed: true,
        recoverySaved: true,
      },
      code,
    );
    return { code, proof, kit: await api.recovery(slot.keyId) };
  }, f);
  return { f, ...saved };
}
test.beforeEach(async ({ context }) => {
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === "http://127.0.0.1:44137"
      ? route.continue()
      : route.abort(),
  );
});
for (const mode of ["active", "prepared", "empty"] as const) {
  test(`actual version11 ${mode} key upgrades without inventing prior generation coverage`, async ({
    page,
  }) => {
    const f = fixture();
    await ready(page);
    const before = await page.evaluate(
      async ({ f, mode }) => {
        const code = window.browserLifecycleTest.code();
        return {
          code,
          ...(await window.browserLifecycleTest.legacyBoundarySeed(
            f.owner,
            f.binding,
            f.now,
            code,
            mode,
          )),
        };
      },
      { f, mode },
    );
    expect(before.version).toBe(11);
    await page.evaluate(
      (f) => window.browserLifecycleTest.init(f.owner, f.binding, true, f.now),
      f,
    );
    expect(
      await page.evaluate(() => window.browserLifecycleTest.status()),
    ).toEqual(before.status);
    const proof = await page.evaluate(
      async ({ before, mode }) => {
        const api = window.browserLifecycleTest;
        if (mode === "active") return (await api.resolve()).proof;
        const command = {
          keyId: before.slot.keyId,
          expectedRevision: before.slot.revision,
          confirmed: true,
          recoverySaved: true,
        };
        return mode === "prepared"
          ? api.activatePrepared(command, before.code, before.kit)
          : api.provision(command, before.code);
      },
      { before, mode },
    );
    const snapshot = await page.evaluate(
      (p) => window.browserLifecycleTest.boundarySnapshot(p),
      proof,
    );
    expect(snapshot.version).toBe(15);
    expect(snapshot.covered).toBe(mode === "empty");
    expect(snapshot.markers).toEqual([
      mode === "empty" ? "from-generation-v1" : null,
    ]);
    expect(
      await page.evaluate(
        (p) => window.browserLifecycleTest.coverage(p),
        proof,
      ),
    ).toBe(mode === "empty");
    if (before.kit) {
      expect(
        await page.evaluate(
          (id) => window.browserLifecycleTest.recovery(id),
          proof.keyId,
        ),
      ).toEqual(before.kit);
      const opened = await page.evaluate(
        ({ kit, code }) => window.browserLifecycleTest.recover(kit, code),
        { kit: before.kit, code: before.code },
      );
      expect(opened.publicKey).toBe(proof.publicKey);
      expect(
        await page.evaluate(
          (p) => window.browserLifecycleTest.coverage(p),
          proof,
        ),
      ).toBe(false);
    }
    await expect(
      page.evaluate(() => window.browserLifecycleTest.legacyBoundaryOpen()),
    ).rejects.toThrow("STORAGE_UNAVAILABLE");
    const replacement = await page.evaluate(async (p) => {
      const api = window.browserLifecycleTest;
      const slot = await api.begin({
        expectedRevision: p.revision,
        confirmed: true,
      });
      return api.provision(
        {
          keyId: slot.keyId,
          expectedRevision: slot.revision,
          confirmed: true,
          recoverySaved: true,
        },
        api.code(),
      );
    }, proof);
    expect(replacement.publicKey).not.toBe(proof.publicKey);
    expect(replacement.keyEpoch).toBe(proof.keyEpoch + 1);
    expect(
      await page.evaluate(
        (p) => window.browserLifecycleTest.coverage(p),
        proof,
      ),
    ).toBe(false);
    expect(
      await page.evaluate(
        (p) => window.browserLifecycleTest.coverage(p),
        replacement,
      ),
    ).toBe(true);
    const after = await page.evaluate(
      (p) => window.browserLifecycleTest.boundarySnapshot(p),
      replacement,
    );
    expect(after.publicKeys).toContain(proof.publicKey);
    await page.evaluate(() => window.browserLifecycleTest.reopen());
    expect(
      await page.evaluate(
        (p) => window.browserLifecycleTest.coverage(p),
        replacement,
      ),
    ).toBe(true);
  });
}
test("current proof coverage rejects changed identity, logout, expiry and revocation", async ({
  page,
}) => {
  const { f, proof } = await fresh(page);
  for (const p of [
    { ...proof, revision: proof.revision + 1 },
    { ...proof, keyId: randomUUID() },
    { ...proof, keyEpoch: proof.keyEpoch + 1 },
    { ...proof, publicKey: "A".repeat(87) },
    { ...proof, binding: { ...proof.binding, ownerId: randomUUID() } },
  ])
    expect(
      await page.evaluate((p) => window.browserLifecycleTest.coverage(p), p),
    ).toBe(false);
  await page.evaluate(() => window.browserLifecycleTest.set(null));
  expect(
    await page.evaluate((p) => window.browserLifecycleTest.coverage(p), proof),
  ).toBe(false);
  await page.evaluate((b) => window.browserLifecycleTest.set(b), f.binding);
  expect(
    await page.evaluate((p) => window.browserLifecycleTest.coverage(p), proof),
  ).toBe(true);
  await page.evaluate(
    (t) => window.browserLifecycleTest.time(t),
    f.binding.expiresAt,
  );
  expect(
    await page.evaluate((p) => window.browserLifecycleTest.coverage(p), proof),
  ).toBe(false);
  await page.evaluate((t) => window.browserLifecycleTest.time(t), f.now);
  await page.evaluate(
    (p) =>
      window.browserLifecycleTest.revoke({
        keyId: p.keyId,
        expectedRevision: p.revision,
        confirmed: true,
      }),
    proof,
  );
  expect(
    await page.evaluate((p) => window.browserLifecycleTest.coverage(p), proof),
  ).toBe(false);
});
test("recovery and cleared storage cannot turn retained material into current authority", async ({
  page,
}) => {
  const { code, kit, proof } = await fresh(page);
  await page.evaluate(
    (p) =>
      window.browserLifecycleTest.clear({
        expectedRevision: p.revision,
        confirmed: true,
      }),
    proof,
  );
  await page.evaluate(() => window.browserLifecycleTest.reopen());
  const recovered = await page.evaluate(
    ({ kit, code }) => window.browserLifecycleTest.recover(kit, code),
    { kit, code },
  );
  expect(recovered.publicKey).toBe(proof.publicKey);
  expect(
    await page.evaluate((p) => window.browserLifecycleTest.coverage(p), proof),
  ).toBe(false);
  expect(
    await page.evaluate(() => window.browserLifecycleTest.status()),
  ).toMatchObject({ locked: true });
  await expect(
    page.evaluate(() => window.browserLifecycleTest.resolve()),
  ).rejects.toThrow("SETUP_REQUIRED");
});
test("missing provenance stays unknown and unsupported provenance fails closed", async ({
  page,
}) => {
  const { proof } = await fresh(page);
  await page.evaluate(
    (p) => window.browserLifecycleTest.boundarySnapshot(p, "missing"),
    proof,
  );
  await page.evaluate(() => window.browserLifecycleTest.reopen());
  expect(
    (await page.evaluate(() => window.browserLifecycleTest.resolve())).proof,
  ).toEqual(proof);
  expect(
    await page.evaluate((p) => window.browserLifecycleTest.coverage(p), proof),
  ).toBe(false);
  await page.evaluate(
    (p) => window.browserLifecycleTest.boundarySnapshot(p, "invalid"),
    proof,
  );
  expect(
    await page.evaluate((p) => window.browserLifecycleTest.coverage(p), proof),
  ).toBe(false);
  await expect(
    page.evaluate(() => window.browserLifecycleTest.resolve()),
  ).rejects.toThrow();
});
test("provenance changed during cryptographic resolution cannot return a covered key", async ({
  page,
}) => {
  const { proof } = await fresh(page);
  await page.evaluate(() => window.browserLifecycleTest.holdGenerate());
  const pending = page.evaluate(() =>
    window.browserLifecycleTest.resolve().then(
      () => "unexpected success",
      () => "denied",
    ),
  );
  await page.waitForFunction(() => window.browserLifecycleTest.held());
  await page.evaluate(
    (p) => window.browserLifecycleTest.boundarySnapshot(p, "missing"),
    proof,
  );
  await page.evaluate(() => window.browserLifecycleTest.release());
  expect(await pending).toBe("denied");
  expect(
    await page.evaluate((p) => window.browserLifecycleTest.coverage(p), proof),
  ).toBe(false);
});
