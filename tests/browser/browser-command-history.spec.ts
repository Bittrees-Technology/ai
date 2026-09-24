import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
const intent = () => ({
  id: randomUUID(),
  deviceId: randomUUID(),
  taskId: randomUUID(),
  command: "pause",
  expectedRevision: 2,
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 300000).toISOString(),
});
async function open(page: Page) {
  await page.goto("/?command-history");
  await page.waitForFunction(() => !!window.commandHistoryTest);
}
test("command journal retains the original uncertain intent across reload, isolates owners and exports only bounded metadata", async ({
  page,
}) => {
  await open(page);
  const owner = randomUUID(),
    other = randomUUID(),
    command = intent();
  const original = await page.evaluate(
    async ({ owner, command }) => {
      const h = window.commandHistoryTest;
      const saved = await h.reserve(owner, 0, command);
      return h.reserve(owner, saved.revision, command);
    },
    { owner, command },
  );
  expect(original.revision).toBe(1);
  expect(original.entries[0]!.observation).toBeNull();
  await page.reload();
  await page.waitForFunction(() => !!window.commandHistoryTest);
  expect(
    await page.evaluate((o) => window.commandHistoryTest.read(o), owner),
  ).toEqual(original);
  expect(
    (await page.evaluate((o) => window.commandHistoryTest.read(o), other))
      .entries,
  ).toEqual([]);
  await expect(
    page.evaluate(
      ({ owner, command }) =>
        window.commandHistoryTest.reserve(owner, 1, {
          ...command,
          command: "cancel",
        }),
      { owner, command },
    ),
  ).rejects.toThrow("CONFLICT");
  await expect(
    page.evaluate(
      ({ owner, command }) =>
        window.commandHistoryTest.reserve(owner, 1, {
          ...command,
          token: "SENSITIVE",
        }),
      { owner, command },
    ),
  ).rejects.toThrow();
  expect(JSON.stringify(original)).not.toMatch(
    /token|credential|prompt|content|privateKey|authority/,
  );
});

test("command observations bind exact targets, retain terminal outcomes and deletion fences stale writes across tabs", async ({
  page,
  context,
}) => {
  await open(page);
  const owner = randomUUID(),
    command = intent();
  await page.evaluate(
    ({ owner, command }) =>
      window.commandHistoryTest.reserve(owner, 0, command),
    { owner, command },
  );
  const pending = { command, state: "pending", receipt: null };
  const receipt = {
    id: command.id,
    deviceId: command.deviceId,
    outcome: "applied",
    completedAt: new Date().toISOString(),
  };
  await expect(
    page.evaluate(
      ({ owner, command, pending }) =>
        window.commandHistoryTest.observe(owner, 1, command.id, {
          ...pending,
          command: { ...command, taskId: crypto.randomUUID() },
        }),
      { owner, command, pending },
    ),
  ).rejects.toThrow("CONFLICT");
  await page.evaluate(
    ({ owner, command, pending }) =>
      window.commandHistoryTest.observe(owner, 1, command.id, pending),
    { owner, command, pending },
  );
  const acknowledged = await page.evaluate(
    ({ owner, command, receipt }) =>
      window.commandHistoryTest.observe(owner, 2, command.id, {
        command,
        state: "acknowledged",
        receipt,
      }),
    { owner, command, receipt },
  );
  expect(acknowledged.entries[0]!.observation!.value.receipt).toEqual(receipt);
  await expect(
    page.evaluate(
      ({ owner, command, pending }) =>
        window.commandHistoryTest.observe(owner, 3, command.id, pending),
      { owner, command, pending },
    ),
  ).rejects.toThrow("CONFLICT");
  const tab = await context.newPage();
  try {
    await open(tab);
    const stale = await tab.evaluate(
      (o) => window.commandHistoryTest.read(o),
      owner,
    );
    await page.evaluate((o) => window.commandHistoryTest.clear(o, 3), owner);
    await expect(
      tab.evaluate(
        ({ owner, command, pending, revision }) =>
          window.commandHistoryTest.observe(
            owner,
            revision,
            command.id,
            pending,
          ),
        { owner, command, pending, revision: stale.revision },
      ),
    ).rejects.toThrow("CONFLICT");
    expect(
      (await tab.evaluate((o) => window.commandHistoryTest.read(o), owner))
        .entries,
    ).toEqual([]);
  } finally {
    await tab.close();
  }
});

test("command journal serializes competing writers and denies invalidated scope before mutation", async ({
  page,
  context,
}) => {
  await open(page);
  const owner = randomUUID(),
    a = intent(),
    b = intent();
  const tab = await context.newPage();
  try {
    await open(tab);
    const outcomes = await Promise.allSettled([
      page.evaluate(
        ({ owner, a }) => window.commandHistoryTest.reserve(owner, 0, a),
        { owner, a },
      ),
      tab.evaluate(
        ({ owner, b }) => window.commandHistoryTest.reserve(owner, 0, b),
        { owner, b },
      ),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);
    await page.evaluate(() => window.commandHistoryTest.allow(true, 3));
    await expect(
      page.evaluate(
        ({ owner, b }) =>
          window.commandHistoryTest.reserve(owner, 1, {
            ...b,
            id: crypto.randomUUID(),
          }),
        { owner, b },
      ),
    ).rejects.toThrow("DENIED");
    await page.evaluate(() => window.commandHistoryTest.allow(true));
    expect(
      (await page.evaluate((o) => window.commandHistoryTest.read(o), owner))
        .entries,
    ).toHaveLength(1);
  } finally {
    await tab.close();
  }
});

test("command history enforces capacity without eviction and rejects a future database version", async ({
  page,
}) => {
  await open(page);
  const owner = randomUUID(),
    command = intent();
  const full = await page.evaluate(
    async ({ owner, command }) => {
      const h = window.commandHistoryTest;
      let saved = await h.read(owner);
      for (let i = 0; i < 100; i++)
        saved = await h.reserve(owner, saved.revision, {
          ...command,
          id: crypto.randomUUID(),
        });
      return saved;
    },
    { owner, command },
  );
  expect(full.entries).toHaveLength(100);
  await expect(
    page.evaluate(
      ({ owner, command }) =>
        window.commandHistoryTest.reserve(owner, 100, command),
      { owner, command },
    ),
  ).rejects.toThrow("CAPACITY");
  expect(
    await page.evaluate((o) => window.commandHistoryTest.read(o), owner),
  ).toEqual(full);
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const r = indexedDB.open(window.commandHistoryTest.databaseName, 2);
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          r.result.close();
          resolve();
        };
      }),
  );
  await expect(
    page.evaluate((o) => window.commandHistoryTest.read(o), owner),
  ).rejects.toThrow("STORAGE_UNAVAILABLE");
});
