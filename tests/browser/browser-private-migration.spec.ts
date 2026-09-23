import { test, expect, type Page } from "@playwright/test";
const open = async (page: Page) => {
  await page.goto("/?private-migration");
  await page.waitForFunction(() => !!window.privateMigrationTest);
};
test.beforeEach(async ({ context, page }) => {
  await context.route("**/*", (r) =>
    new URL(r.request().url()).origin === "http://127.0.0.1:44137"
      ? r.continue()
      : r.abort(),
  );
  await open(page);
});
const seed = (page: Page, retained = false, locked = false) =>
  page.evaluate(
    ({ retained, locked }) =>
      window.privateMigrationTest.seed(retained, locked),
    { retained, locked },
  );
const complete = { id: "legacy-outbox-v1", version: 1, complete: true };

test("Actual PR151 keys, peer pin, recovery kit and all ciphertext states survive the shared-store migration and reload", async ({
  page,
}) => {
  const old = await seed(page, true);
  const migrated = await page.evaluate(
    (c) => window.privateMigrationTest.open(c),
    old.config,
  );
  expect(migrated).toEqual(old.history);
  await expect(
    page.evaluate(() => window.privateMigrationTest.oldHistory()),
  ).rejects.toThrow("STORAGE_UNAVAILABLE");
  for (const key of [false, true])
    await expect(
      page.evaluate(
        ({ c, key }) => window.privateMigrationTest.oldOpen(c, key),
        { c: old.config, key },
      ),
    ).rejects.toThrow("STORAGE_UNAVAILABLE");
  const common = await page.evaluate(() =>
    window.privateMigrationTest.inspectCommon(),
  );
  expect(common.private_migrations).toContainEqual(complete);
  expect(
    await page.evaluate(() => window.privateMigrationTest.inspectLegacy()),
  ).toEqual({ meta: [], entries: [], channels: [] });
  await page.reload();
  await page.waitForFunction(() => !!window.privateMigrationTest);
  expect(
    await page.evaluate((c) => window.privateMigrationTest.open(c), old.config),
  ).toEqual(old.history);
  const retained = await page.evaluate(
    ({ c, kit, code }) => window.privateMigrationTest.retained(c, kit, code),
    { c: old.config, kit: old.kit, code: old.code! },
  );
  expect(retained.proof).toEqual(old.proof);
  expect(retained.kit).toEqual(old.kit);
  expect(retained.pin.peerId).toBe(old.config.context.peerId);
  expect(retained.text).toBe("recovery correspondence");
  expect(retained.extractable).toBe(false);
  const accepted = old.history.entries.find((e) => e.id === old.ids.accepted)!;
  expect(
    await page.evaluate(
      (e) => window.privateMigrationTest.result(e.id, e.revision),
      accepted,
    ),
  ).toEqual(old.result);
  expect(
    (
      await page.evaluate(
        (id) => window.privateMigrationTest.reserve(id),
        old.config.context.peerId,
      )
    ).header.sequence,
  ).toBe(5);
});

test("Concurrent migration preserves separate owners and a prior deletion lock", async ({
  page,
}) => {
  const first = await seed(page),
    second = await seed(page),
    deleted = await seed(page, false, true);
  expect(
    await page.evaluate(() => window.privateMigrationTest.concurrentOpen()),
  ).toBe(true);
  for (const old of [first, second, deleted])
    expect(
      await page.evaluate(
        (c) => window.privateMigrationTest.open(c),
        old.config,
      ),
    ).toEqual(old.history);
  await expect(
    page.evaluate(
      (id) => window.privateMigrationTest.reserve(id),
      deleted.config.context.peerId,
    ),
  ).rejects.toThrow("SETUP_REQUIRED");
  const common = await page.evaluate(() =>
    window.privateMigrationTest.inspectCommon(),
  );
  expect(common.meta).toHaveLength(3);
  expect(common.entries).toHaveLength(8);
  expect(common.private_migrations).toHaveLength(4);
  expect(
    await page.evaluate(() => window.privateMigrationTest.inspectLegacy()),
  ).toEqual({ meta: [], entries: [], channels: [] });
});

for (const phase of ["copy", "cleanup", "owner-marker", "final"] as const)
  test(`Interrupted ${phase} resumes from committed records without losing history or counters`, async ({
    page,
  }) => {
    const old = await seed(page);
    await page.evaluate((p) => window.privateMigrationTest.fault(p), phase);
    await expect(
      page.evaluate((c) => window.privateMigrationTest.open(c), old.config),
    ).rejects.toThrow("CAPACITY");
    const legacy = await page.evaluate(() =>
      window.privateMigrationTest.inspectLegacy(),
    );
    expect(legacy.entries).toHaveLength(
      phase === "copy" || phase === "cleanup" ? 4 : 0,
    );
    const partial = await page.evaluate(() =>
      window.privateMigrationTest.inspectCommon(),
    );
    expect(partial.entries).toHaveLength(phase === "copy" ? 0 : 4);
    expect(partial.private_migrations).not.toContainEqual(complete);
    // A full page reload discards closures and connections before retrying.
    await page.reload();
    await page.waitForFunction(() => !!window.privateMigrationTest);
    expect(
      await page.evaluate(
        (c) => window.privateMigrationTest.open(c),
        old.config,
      ),
    ).toEqual(old.history);
    expect(
      (
        await page.evaluate(
          (id) => window.privateMigrationTest.reserve(id),
          old.config.context.peerId,
        )
      ).header.sequence,
    ).toBe(5);
    expect(
      await page.evaluate(() => window.privateMigrationTest.inspectLegacy()),
    ).toEqual({ meta: [], entries: [], channels: [] });
  });

test("Aborted common-store upgrade leaves actual previous keys and outbox usable", async ({
  page,
}) => {
  const old = await seed(page, true);
  await page.evaluate(() => window.privateMigrationTest.fault("upgrade"));
  await expect(
    page.evaluate((c) => window.privateMigrationTest.open(c), old.config),
  ).rejects.toThrow("STORAGE_UNAVAILABLE");
  expect(
    await page.evaluate(
      (c) => window.privateMigrationTest.oldOpen(c, true),
      old.config,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => window.privateMigrationTest.oldHistory()),
  ).toEqual(old.history);
  expect(
    await page.evaluate((c) => window.privateMigrationTest.open(c), old.config),
  ).toEqual(old.history);
});

for (const which of ["counter", "orphan"] as const)
  test(`Legacy ${which} corruption fails closed while key recovery remains usable`, async ({
    page,
  }) => {
    const old = await seed(page, true);
    await page.evaluate(
      ({ which, c }) => window.privateMigrationTest.tamper(which, c),
      { which, c: old.config },
    );
    await expect(
      page.evaluate((c) => window.privateMigrationTest.open(c), old.config),
    ).rejects.toThrow("STORAGE_UNAVAILABLE");
    const legacy = await page.evaluate(() =>
      window.privateMigrationTest.inspectLegacy(),
    );
    expect(legacy.entries).toHaveLength(4);
    expect(legacy.channels).toHaveLength(1);
    const common = await page.evaluate(() =>
      window.privateMigrationTest.inspectCommon(),
    );
    expect(common.entries).toHaveLength(0);
    expect(common.private_migrations).not.toContainEqual(complete);
    const retained = await page.evaluate(
      ({ c, kit, code }) => window.privateMigrationTest.retained(c, kit, code),
      { c: old.config, kit: old.kit, code: old.code! },
    );
    expect(retained.proof).toEqual(old.proof);
    expect(retained.kit).toEqual(old.kit);
    expect(retained.text).toBe("recovery correspondence");
  });

test("Restart rejects a changed destination copy after source cleanup instead of trusting counts", async ({
  page,
}) => {
  const old = await seed(page, true);
  await page.evaluate(() => window.privateMigrationTest.fault("owner-marker"));
  await expect(
    page.evaluate((c) => window.privateMigrationTest.open(c), old.config),
  ).rejects.toThrow("CAPACITY");
  await page.evaluate(
    (c) => window.privateMigrationTest.tamper("copied", c),
    old.config,
  );
  await page.reload();
  await page.waitForFunction(() => !!window.privateMigrationTest);
  await expect(
    page.evaluate((c) => window.privateMigrationTest.open(c), old.config),
  ).rejects.toThrow("CONFLICT");
  const common = await page.evaluate(() =>
    window.privateMigrationTest.inspectCommon(),
  );
  expect(common.entries).toHaveLength(4);
  expect(common.private_migrations).not.toContainEqual(complete);
  const retained = await page.evaluate(
    ({ c, kit, code }) => window.privateMigrationTest.retained(c, kit, code),
    { c: old.config, kit: old.kit, code: old.code! },
  );
  expect(retained.proof).toEqual(old.proof);
  expect(retained.kit).toEqual(old.kit);
});

test("Task writes and shared reservations serialize, roll back failed publication, and retain the counter after deletion", async ({
  page,
}) => {
  const old = await seed(page);
  await page.evaluate((c) => window.privateMigrationTest.open(c), old.config);
  const numbers = await page.evaluate(
    async (c) =>
      Promise.all([
        ...Array.from(
          { length: 4 },
          async () =>
            (await window.privateMigrationTest.reserve(c.context.peerId)).header
              .sequence,
        ),
        ...Array.from({ length: 4 }, () =>
          window.privateMigrationTest.sharedReserve(c),
        ),
      ]),
    old.config,
  );
  expect(numbers.sort((a, b) => a - b)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
  await expect(
    page.evaluate(
      (c) => window.privateMigrationTest.sharedReserve(c, true),
      old.config,
    ),
  ).rejects.toThrow("STORAGE_UNAVAILABLE");
  expect(
    await page.evaluate(
      (c) => window.privateMigrationTest.sharedReserve(c),
      old.config,
    ),
  ).toBe(13);
  const deleted = await page.evaluate(() =>
    window.privateMigrationTest.clear(),
  );
  expect(deleted.locked).toBe(true);
  const common = await page.evaluate(() =>
    window.privateMigrationTest.inspectCommon(),
  );
  expect(common.entries).toHaveLength(0);
  expect(common.channels).toHaveLength(1);
  await expect(
    page.evaluate(
      (id) => window.privateMigrationTest.reserve(id),
      old.config.context.peerId,
    ),
  ).rejects.toThrow("SETUP_REQUIRED");
  await expect(
    page.evaluate(
      (r) => window.privateMigrationTest.initialize(r),
      deleted.revision,
    ),
  ).rejects.toThrow("SETUP_REQUIRED");
  expect(
    await page.evaluate(
      (c) => window.privateMigrationTest.sharedReserve(c),
      old.config,
    ),
  ).toBe(14);
});

for (const which of ["exhausted", "capacity"] as const)
  test(`Shared counter ${which} refuses new reservations without removing history`, async ({
    page,
  }) => {
    const old = await seed(page);
    await page.evaluate((c) => window.privateMigrationTest.open(c), old.config);
    await page.evaluate(
      ({ which, c }) => window.privateMigrationTest.tamper(which, c),
      { which, c: old.config },
    );
    const c = structuredClone(old.config);
    if (which === "capacity")
      c.context.peerId = "130e1154-9932-4c11-9b25-48e1c6c3ddc6";
    await expect(
      page.evaluate((c) => window.privateMigrationTest.sharedReserve(c), c),
    ).rejects.toThrow("CAPACITY");
    const common = await page.evaluate(() =>
      window.privateMigrationTest.inspectCommon(),
    );
    expect(common.entries).toHaveLength(4);
  });
