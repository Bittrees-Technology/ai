import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  ready,
  paired,
  reopen,
  payload,
} from "./support/retained-browser-task.js";
const route = (f: Awaited<ReturnType<typeof ready>>) => ({
  peerId: f.pin.peerId,
  peerKeyEpoch: f.pin.keyEpoch,
});
const approve = (page: Page, reviewId: string) =>
  page.evaluate(
    (reviewId) =>
      window.browserPeersTest.composeConfirm({
        reviewId,
        confirmed: true,
        acknowledged: true,
      }),
    reviewId,
  );
const prepare = (
  page: Page,
  f: Awaited<ReturnType<typeof ready>>,
  input = payload,
) =>
  page.evaluate((p) => window.browserPeersTest.composePrepare(p), {
    ...route(f),
    payload: input,
  });
async function inspect(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("org.bittrees.ai.browser-endpoint-keys", 6);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      return await new Promise<{
        entries: any[];
        preparations: any[];
        channels: any[];
      }>((resolve, reject) => {
        const tx = db.transaction(["entries", "task_preparations", "channels"]),
          data = {
            entries: [] as any[],
            preparations: [] as any[],
            channels: [] as any[],
          };
        for (const name of [
          "entries",
          "task_preparations",
          "channels",
        ] as const) {
          const r = tx.objectStore(name).getAll();
          r.onsuccess = () => {
            if (name === "task_preparations")
              data.preparations = r.result.map(({ key, ...rest }) => ({
                ...rest,
                extractable: key.extractable,
              }));
            else data[name] = r.result;
          };
        }
        tx.oncomplete = () => resolve(data);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  });
}
async function reserve(
  page: Page,
  f: Awaited<ReturnType<typeof ready>>,
  prompt = payload.prompt,
) {
  return page.evaluate((input) => window.browserPeersTest.taskReserve(input), {
    id: randomUUID(),
    expiresAt: f.f.now + 180000,
    payload: { ...payload, prompt },
  });
}
const resume = (
  page: Page,
  f: Awaited<ReturnType<typeof ready>>,
  entry: { id: string; revision: number },
) =>
  page.evaluate((p) => window.browserPeersTest.composeResume(p), {
    ...route(f),
    id: entry.id,
    expectedRevision: entry.revision,
    confirmed: true,
  });
test.beforeEach(async ({ context }) => {
  await context.route("**/*", (r) =>
    new URL(r.request().url()).origin === "http://127.0.0.1:44137"
      ? r.continue()
      : r.abort(),
  );
});

test("exact task review is one use and altered returned data cannot replace the original input", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const r = await prepare(page, f),
      id = r.operationId;
    r.payload.prompt = "UNREVIEWED_REPLACEMENT";
    r.context.peerId = randomUUID();
    const entry = await approve(page, r.reviewId);
    expect(entry.id).toBe(id);
    expect(entry.state).toBe("pending");
    expect(entry.header.expiresAt).toBe(r.deliveryExpiresAt);
    await expect(approve(page, r.reviewId)).rejects.toThrow("CONFLICT");
    const stored = await inspect(page);
    expect(stored.entries).toHaveLength(1);
    expect(stored.preparations).toHaveLength(1);
    expect(stored.preparations[0].extractable).toBe(false);
    expect(JSON.stringify(stored)).not.toContain(payload.prompt);
    const history = await page.evaluate(() =>
      window.browserPeersTest.historyStatus(),
    );
    const exported = await page.evaluate(
      (r) =>
        window.browserPeersTest.historyExport({
          expectedRevision: r,
          confirmed: true,
        }),
      history.meta!.revision,
    );
    expect(exported.entries[0]!.input).toEqual(payload);
    expect(JSON.stringify(exported)).not.toMatch(
      /preparationKey|privateKey|"key":/,
    );
    const executed = await f.mac.executeTask(entry.envelope);
    expect(executed.task!.input.prompt).toBe(payload.prompt);
  } finally {
    f.mac.close();
  }
});

test("a restart after reservation resumes the same operation, sequence, deadline and original task", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const reserved = await reserve(page, f),
      before = await inspect(page);
    expect(reserved.state).toBe("reserved");
    expect(reserved.envelope).toBeNull();
    await reopen(page, f.f);
    const committed = await resume(page, f, reserved);
    expect(committed.header).toEqual(reserved.header);
    expect(committed.id).toBe(reserved.id);
    await reopen(page, f.f);
    const again = await resume(page, f, reserved);
    expect(again).toEqual(committed);
    expect((await inspect(page)).channels).toEqual(before.channels);
    expect((await inspect(page)).entries).toHaveLength(1);
    expect(
      (await f.mac.executeTask(committed.envelope)).task!.input.prompt,
    ).toBe(payload.prompt);
  } finally {
    f.mac.close();
  }
});

test("two tabs recovering one reservation reconcile to one original ciphertext", async ({
  page,
  context,
}) => {
  const f = await ready(page),
    other = await context.newPage();
  try {
    const reserved = await reserve(page, f),
      before = await inspect(page);
    await reopen(other, f.f);
    const values = await Promise.allSettled([
      resume(page, f, reserved),
      resume(other, f, reserved),
    ]);
    expect(values.some((v) => v.status === "fulfilled")).toBe(true);
    for (const v of values)
      if (v.status === "rejected") expect(String(v.reason)).toMatch(/CONFLICT/);
    const canonical = await resume(page, f, reserved);
    for (const v of values)
      if (v.status === "fulfilled")
        expect(v.value.envelope).toEqual(canonical.envelope);
    expect((await inspect(page)).channels).toEqual(before.channels);
    expect((await inspect(page)).entries).toHaveLength(1);
  } finally {
    await other.close();
    f.mac.close();
  }
});

for (const kind of ["multibyte", "escaped"] as const)
  test(`oversized ${kind} task input consumes no entry, preparation or sequence`, async ({
    page,
  }) => {
    const f = await ready(page);
    try {
      const before = await inspect(page),
        prompt = kind === "multibyte" ? "界".repeat(32000) : "\0".repeat(12000);
      await expect(prepare(page, f, { ...payload, prompt })).rejects.toThrow(
        "CAPACITY",
      );
      await expect(reserve(page, f, prompt)).rejects.toThrow("CAPACITY");
      expect(await inspect(page)).toEqual(before);
    } finally {
      f.mac.close();
    }
  });

test("preparation quota failure aborts the reservation and shared counter together", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const r = await prepare(page, f),
      before = await inspect(page);
    await page.evaluate(() => {
      const add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (
        ...args: Parameters<IDBObjectStore["add"]>
      ) {
        if (this.name === "task_preparations") {
          IDBObjectStore.prototype.add = add;
          throw new DOMException("synthetic quota", "QuotaExceededError");
        }
        return add.apply(this, args);
      };
    });
    await expect(approve(page, r.reviewId)).rejects.toThrow(/CAPACITY/);
    expect(await inspect(page)).toEqual(before);
    await expect(approve(page, r.reviewId)).rejects.toThrow("CONFLICT");
  } finally {
    f.mac.close();
  }
});

for (const stage of ["preparation", "publication"] as const)
  test(`revocation during ${stage} cryptography cannot publish or replace a task`, async ({
    page,
    context,
  }) => {
    const f = await ready(page),
      other = await context.newPage();
    try {
      const r = await prepare(page, f);
      await reopen(other, f.f);
      await page.evaluate(
        (skip) => window.browserPeersTest.holdEncryption(skip),
        stage === "preparation" ? 0 : 1,
      );
      const pending = approve(page, r.reviewId).then(
        (value) => ({ value }),
        (e) => ({ error: String(e) }),
      );
      await expect
        .poll(() => page.evaluate(() => window.browserPeersTest.held()))
        .toBe(true);
      const consent = await other.evaluate(() =>
        window.browserPeersTest.consentStatus(),
      );
      await other.evaluate(
        (raw) => window.browserPeersTest.consentRevoke(raw),
        {
          peerId: f.pin.peerId,
          expectedRevision: consent.revision,
          confirmed: true,
        },
      );
      await page.evaluate(() => window.browserPeersTest.release());
      expect(await pending).toMatchObject({
        error: expect.stringMatching(/DENIED|CONFLICT/),
      });
      const stored = await inspect(page);
      expect(stored.entries).toHaveLength(stage === "preparation" ? 0 : 1);
      expect(stored.entries.every((e) => e.envelope === null)).toBe(true);
      if (stored.entries.length)
        await expect(resume(page, f, stored.entries[0])).rejects.toThrow(
          /DENIED|CONFLICT/,
        );
    } finally {
      await other.close();
      f.mac.close();
    }
  });

for (const action of ["cancel", "deadline", "rollback", "monotonic"] as const)
  test(`task review ${action} rejects the original confirmation without reserving`, async ({
    page,
  }) => {
    const f = await ready(page);
    try {
      const r = await prepare(page, f),
        before = await inspect(page);
      if (action === "cancel")
        await page.evaluate(() => window.browserPeersTest.composeInvalidate());
      else
        await page.evaluate(
          ({ wall, mono }) => window.browserPeersTest.time(wall, mono),
          {
            wall:
              action === "deadline"
                ? f.f.now + 120001
                : action === "rollback"
                  ? f.f.now - 1
                  : f.f.now,
            mono: action === "monotonic" ? 120001 : 0,
          },
        );
      await expect(approve(page, r.reviewId)).rejects.toThrow(
        /DENIED|CONFLICT/,
      );
      expect(await inspect(page)).toEqual(before);
    } finally {
      f.mac.close();
    }
  });

test("offline owner maintenance retains reviewed input until explicit export and deletion, preserving counters", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const entry = await reserve(page, f),
      before = await inspect(page);
    await page.evaluate(() => window.browserPeersTest.set(null));
    const history = await page.evaluate(() =>
      window.browserPeersTest.historyStatus(),
    );
    const exported = await page.evaluate(
      (r) =>
        window.browserPeersTest.historyExport({
          expectedRevision: r,
          confirmed: true,
        }),
      history.meta!.revision,
    );
    expect(exported.entries[0]!.input).toEqual(payload);
    expect(exported.restoreAuthority).toBe(false);
    const stopped = await page.evaluate(
      (e) =>
        window.browserPeersTest.historyStop({
          id: e.id,
          expectedRevision: e.revision,
          confirmed: true,
        }),
      entry,
    );
    expect(stopped.state).toBe("stopped");
    expect((await inspect(page)).preparations).toHaveLength(1);
    const afterStop = await page.evaluate(() =>
      window.browserPeersTest.historyStatus(),
    );
    const deleted = await page.evaluate(
      (r) =>
        window.browserPeersTest.historyClear({
          expectedRevision: r,
          confirmed: true,
        }),
      afterStop.meta!.revision,
    );
    const cleared = await inspect(page);
    expect(cleared.entries).toEqual([]);
    expect(cleared.preparations).toEqual([]);
    expect(cleared.channels).toEqual(before.channels);
    await reopen(page, f.f);
    await f.authorize();
    await expect(
      page.evaluate(
        (revision) =>
          window.browserPeersTest.taskInitialize({
            expectedRevision: revision,
            confirmed: true,
          }),
        deleted.revision,
      ),
    ).rejects.toThrow("SETUP_REQUIRED");
  } finally {
    f.mac.close();
  }
});

test("a changed local owner cannot inspect, export, stop or delete another owner's task history", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const entry = await reserve(page, f),
      history = await page.evaluate(() =>
        window.browserPeersTest.historyStatus(),
      ),
      before = await inspect(page);
    await page.evaluate(
      (id) => window.browserPeersTest.historyOwnerChange(id),
      randomUUID(),
    );
    await expect(
      page.evaluate(() => window.browserPeersTest.historyStatus()),
    ).rejects.toThrow("DENIED");
    await expect(
      page.evaluate(
        (r) =>
          window.browserPeersTest.historyExport({
            expectedRevision: r,
            confirmed: true,
          }),
        history.meta!.revision,
      ),
    ).rejects.toThrow("DENIED");
    await expect(
      page.evaluate(
        (e) =>
          window.browserPeersTest.historyStop({
            id: e.id,
            expectedRevision: e.revision,
            confirmed: true,
          }),
        entry,
      ),
    ).rejects.toThrow("DENIED");
    await expect(
      page.evaluate(
        (r) =>
          window.browserPeersTest.historyClear({
            expectedRevision: r,
            confirmed: true,
          }),
        history.meta!.revision,
      ),
    ).rejects.toThrow("DENIED");
    expect(await inspect(page)).toEqual(before);
  } finally {
    f.mac.close();
  }
});

test("actual PR156 database5 upgrades without changing grants or wire history and refuses its old writer", async ({
  page,
}) => {
  const f = await ready(page, "task");
  try {
    const old = await page.evaluate(
        (p) => window.browserPeersTest.taskCreate(p),
        payload,
      ),
      grant = await page.evaluate(() =>
        window.browserPeersTest.consentStatus(),
      );
    await reopen(page, f.f);
    expect(
      await page.evaluate(() => window.browserPeersTest.consentStatus()),
    ).toEqual(grant);
    await f.authorize();
    expect(
      (await page.evaluate(() => window.browserPeersTest.taskExport())).entries,
    ).toEqual([old]);
    const newer = await approve(page, (await prepare(page, f)).reviewId);
    expect(newer.header.sequence).toBeGreaterThan(old.header.sequence);
    expect((await inspect(page)).preparations).toHaveLength(1);
    await expect(reopen(page, f.f, "task")).rejects.toThrow(
      "STORAGE_UNAVAILABLE",
    );
  } finally {
    f.mac.close();
  }
});

test("a failed database6 upgrade leaves actual PR156 tasks and permissions usable", async ({
  page,
}) => {
  const f = await ready(page, "task");
  try {
    const old = await page.evaluate(
      (p) => window.browserPeersTest.taskCreate(p),
      payload,
    );
    await page.evaluate(() => {
      const create = IDBDatabase.prototype.createObjectStore;
      IDBDatabase.prototype.createObjectStore = function (
        ...args: Parameters<IDBDatabase["createObjectStore"]>
      ) {
        if (args[0] === "task_preparations") {
          IDBDatabase.prototype.createObjectStore = create;
          throw new DOMException(
            "synthetic upgrade failure",
            "QuotaExceededError",
          );
        }
        return create.apply(this, args);
      };
    });
    await expect(
      page.evaluate(
        (f) => window.browserPeersTest.init(f.owner, f.binding, f.now),
        f.f,
      ),
    ).rejects.toThrow("STORAGE_UNAVAILABLE");
    await reopen(page, f.f, "task");
    await f.authorize();
    expect(
      (await page.evaluate(() => window.browserPeersTest.taskExport())).entries,
    ).toEqual([old]);
    expect(
      await page.evaluate(
        (id) => window.browserPeersTest.taskDelivery(id),
        old.id,
      ),
    ).toEqual(old.envelope);
  } finally {
    f.mac.close();
  }
});

for (const flag of ["confirmed", "acknowledged"] as const)
  test(`a false ${flag} consumes content review without allocating a task`, async ({
    page,
  }) => {
    const f = await ready(page);
    try {
      const r = await prepare(page, f),
        before = await inspect(page);
      await expect(
        page.evaluate((raw) => window.browserPeersTest.composeConfirm(raw), {
          reviewId: r.reviewId,
          confirmed: true,
          acknowledged: true,
          [flag]: false,
        }),
      ).rejects.toThrow();
      await expect(approve(page, r.reviewId)).rejects.toThrow("CONFLICT");
      expect(await inspect(page)).toEqual(before);
    } finally {
      f.mac.close();
    }
  });

test("publication quota failure preserves a recoverable reservation and never allocates a second sequence", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const r = await prepare(page, f);
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        ...args: Parameters<IDBObjectStore["put"]>
      ) {
        if (this.name === "entries" && args[0]?.state === "pending") {
          IDBObjectStore.prototype.put = put;
          throw new DOMException(
            "synthetic publication quota",
            "QuotaExceededError",
          );
        }
        return put.apply(this, args);
      };
    });
    await expect(approve(page, r.reviewId)).rejects.toThrow("CAPACITY");
    const before = await inspect(page);
    expect(before.entries).toHaveLength(1);
    expect(before.preparations).toHaveLength(1);
    expect(before.entries[0]).toMatchObject({
      id: r.operationId,
      revision: 1,
      state: "reserved",
      envelope: null,
    });
    await expect(approve(page, r.reviewId)).rejects.toThrow("CONFLICT");
    await reopen(page, f.f);
    const saved = await resume(page, f, before.entries[0]);
    expect(saved.header).toEqual(before.entries[0].header);
    expect((await inspect(page)).channels).toEqual(before.channels);
    expect((await f.mac.executeTask(saved.envelope)).task!.input.prompt).toBe(
      payload.prompt,
    );
  } finally {
    f.mac.close();
  }
});

for (const fault of ["missing", "ciphertext", "deadline"] as const)
  test(`a ${fault} preparation cannot be resumed and can still be deleted by its owner`, async ({
    page,
  }) => {
    const f = await ready(page);
    try {
      const entry = await reserve(page, f),
        status = await page.evaluate(() =>
          window.browserPeersTest.historyStatus(),
        );
      await page.evaluate(
        async ({ id, fault }) => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const r = indexedDB.open(
              "org.bittrees.ai.browser-endpoint-keys",
              6,
            );
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
          });
          try {
            await new Promise<void>((resolve, reject) => {
              const tx = db.transaction("task_preparations", "readwrite"),
                store = tx.objectStore("task_preparations"),
                r = store.get(id);
              r.onsuccess = () => {
                if (fault === "missing") store.delete(id);
                else {
                  const p = r.result;
                  if (fault === "deadline") p.expiresAt--;
                  else
                    p.ciphertext =
                      (p.ciphertext[0] === "A" ? "B" : "A") +
                      p.ciphertext.slice(1);
                  store.put(p);
                }
              };
              tx.oncomplete = () => resolve();
              tx.onabort = () => reject(tx.error);
            });
          } finally {
            db.close();
          }
        },
        { id: entry.id, fault },
      );
      const before = await inspect(page);
      await expect(resume(page, f, entry)).rejects.toThrow();
      expect(await inspect(page)).toEqual(before);
      await page.evaluate(
        (r) =>
          window.browserPeersTest.historyClear({
            expectedRevision: r,
            confirmed: true,
          }),
        status.meta!.revision,
      );
      const after = await inspect(page);
      expect(after.entries).toEqual([]);
      expect(after.preparations).toEqual([]);
      expect(after.channels).toEqual(before.channels);
    } finally {
      f.mac.close();
    }
  });

for (const change of ["grant", "stopped", "expired"] as const)
  test(`a ${change} original task cannot gain a new deadline or sending authority during recovery`, async ({
    page,
  }) => {
    const f = await ready(page);
    try {
      const entry = await reserve(page, f);
      if (change === "grant") await f.approve(await f.prepare());
      if (change === "stopped")
        await page.evaluate(
          (e) =>
            window.browserPeersTest.historyStop({
              id: e.id,
              expectedRevision: e.revision,
              confirmed: true,
            }),
          entry,
        );
      if (change === "expired")
        await page.evaluate(
          (wall) => window.browserPeersTest.time(wall, 0),
          entry.header.expiresAt + 1,
        );
      const before = await inspect(page);
      await expect(resume(page, f, entry)).rejects.toThrow(/DENIED|CONFLICT/);
      expect(await inspect(page)).toEqual(before);
    } finally {
      f.mac.close();
    }
  });

test("delivery checks the reviewed revision in the publication transaction", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const entry = await approve(page, (await prepare(page, f)).reviewId),
      before = await inspect(page);
    await expect(
      page.evaluate((raw) => window.browserPeersTest.composeEnvelope(raw), {
        ...route(f),
        id: entry.id,
        expectedRevision: entry.revision - 1,
        confirmed: true,
      }),
    ).rejects.toThrow("CONFLICT");
    expect(await inspect(page)).toEqual(before);
    const wire = await page.evaluate(
      (raw) => window.browserPeersTest.composeEnvelope(raw),
      {
        ...route(f),
        id: entry.id,
        expectedRevision: entry.revision,
        confirmed: true,
      },
    );
    expect(wire).toEqual(entry.envelope);
    const after = await inspect(page);
    expect(after.entries[0].attempts).toBe(1);
    expect(after.channels).toEqual(before.channels);
  } finally {
    f.mac.close();
  }
});
