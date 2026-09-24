import { test, expect, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  ready,
  paired,
  reopen,
  payload,
} from "./support/retained-browser-task.js";
import {
  sealPrivateEnvelope,
  privateEnvelopeSuite,
  type PrivateEnvelope,
} from "../../modules/remote/private-envelope.js";
import { privateReplayIdentity } from "../../modules/remote/private-replay.js";

type Fixture = Awaited<ReturnType<typeof paired>>;
const receipt = (page: Page, wire: unknown) =>
  page.evaluate((w) => window.browserPeersTest.taskReceipt(w), wire);
const respond = (page: Page, wire: unknown) =>
  page.evaluate(
    (envelope) =>
      window.browserPeersTest.checkRespond({ envelope, confirmed: true }),
    wire,
  );
async function task(page: Page, f: Fixture) {
  const entry = await page.evaluate(
    (p) => window.browserPeersTest.taskCreate(p),
    payload,
  );
  return { entry, ...(await f.mac.executeTask(entry.envelope)) };
}
async function incoming(
  f: Fixture,
  content: unknown,
  patch: Record<string, unknown> = {},
) {
  const k = await f.mac.keys.resolve(),
    p = await f.mac.peers.resolve(f.f.binding.deviceId, f.local.keyEpoch);
  return sealPrivateEnvelope(
    {
      version: 1,
      suite: privateEnvelopeSuite,
      ownerId: f.f.binding.ownerId,
      senderId: f.mac.binding.deviceId,
      recipientId: f.f.binding.deviceId,
      senderKeyEpoch: k.proof.keyEpoch,
      recipientKeyEpoch: f.local.keyEpoch,
      operationId: randomUUID(),
      messageId: randomUUID(),
      sequence: 1000,
      issuedAt: f.f.now,
      expiresAt: f.f.now + 120000,
      ...patch,
    },
    new TextEncoder().encode(JSON.stringify(content)),
    { senderKey: k.pair, recipientPublicKey: p.publicKey },
    () => f.f.now,
  );
}
const challenge = () => ({
  version: 1,
  type: "peer.key.challenge",
  challenge: randomBytes(32).toString("base64url"),
});
async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("org.bittrees.ai.browser-endpoint-keys");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      const names = [
        "entries",
        "peer_checks",
        "channels",
        "meta",
        ...(db.objectStoreNames.contains("incoming_replay")
          ? ["incoming_replay"]
          : []),
      ];
      return await new Promise<{
        version: number;
        rows: Record<string, any[]>;
      }>((resolve, reject) => {
        const tx = db.transaction(names),
          rows: Record<string, any[]> = {};
        for (const name of names) {
          const r = tx.objectStore(name).getAll();
          r.onsuccess = () => {
            rows[name] = r.result.map((row) => {
              const { preparationKey, ...value } = row;
              return {
                ...value,
                ...(preparationKey
                  ? { keyExtractable: preparationKey.extractable }
                  : {}),
              };
            });
          };
        }
        tx.oncomplete = () => resolve({ version: db.version, rows });
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  });
}
async function editReplay(
  page: Page,
  action: "corrupt" | "capacity",
  operation: string,
) {
  return page.evaluate(
    async ({ action, operation }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open("org.bittrees.ai.browser-endpoint-keys");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("incoming_replay", "readwrite"),
            store = tx.objectStore("incoming_replay"),
            r = store.getAll();
          r.onsuccess = () => {
            const row = r.result.find((v) => v.operation === operation);
            if (!row) {
              tx.abort();
              return;
            }
            if (action === "corrupt")
              store.put({ ...row, envelope: "damaged" });
            else
              for (let i = r.result.length; i < 4096; i++) {
                const hash = i.toString(16).padStart(64, "0");
                store.add({
                  ...row,
                  operation: hash,
                  message: hash,
                  sequence: hash,
                });
              }
          };
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    },
    { action, operation },
  );
}
async function fault(
  page: Page,
  store: string,
  method: "add" | "put",
  expiresAt?: number,
) {
  await page.evaluate(
    ({ store, method, expiresAt }) => {
      const original = IDBObjectStore.prototype[method];
      IDBObjectStore.prototype[method] = function (
        ...args: Parameters<typeof original>
      ) {
        if (this.name === store) {
          IDBObjectStore.prototype[method] = original;
          if (expiresAt) window.browserPeersTest.time(expiresAt, 0);
          else
            throw new DOMException(
              "synthetic write failure",
              "QuotaExceededError",
            );
        }
        return original.apply(this, args);
      };
    },
    { store, method, expiresAt },
  );
}
test.beforeEach(async ({ context }) => {
  await context.route("**/*", (r) =>
    new URL(r.request().url()).origin === "http://127.0.0.1:44137"
      ? r.continue()
      : r.abort(),
  );
});

test("browser receipts and results share an operation but retain distinct replay outcomes across tabs and reload", async ({
  page,
  context,
}) => {
  const f = await ready(page),
    other = await context.newPage();
  try {
    const t = await task(page, f),
      before = await snapshot(page);
    await reopen(other, f.f);
    await other.evaluate(
      (p) => window.browserPeersTest.authorize(p.peerId, p.keyEpoch),
      f.pin,
    );
    const replies = await Promise.all([
      receipt(page, t.acceptance),
      receipt(other, t.acceptance),
    ]);
    expect(replies[0]).toEqual(replies[1]);
    await page.evaluate((w) => window.browserPeersTest.taskResult(w), t.result);
    const after = await snapshot(page);
    expect(after.rows.incoming_replay!.length).toBe(
      before.rows.incoming_replay!.length + 2,
    );
    expect(after.rows.incoming_replay!.map((r) => r.type)).toEqual(
      expect.arrayContaining(["task.accepted", "task.result"]),
    );
    expect(JSON.stringify(after.rows.incoming_replay)).not.toContain(
      payload.prompt,
    );
    const substitute = await incoming(
      f,
      { version: 1, type: "task.accepted", receipt: t.receipt },
      t.acceptance.header,
    );
    await expect(receipt(page, substitute)).rejects.toThrow("CONFLICT");
    await reopen(page, f.f);
    await f.authorize();
    await receipt(page, t.acceptance);
    await page.evaluate((w) => window.browserPeersTest.taskResult(w), t.result);
    expect(await snapshot(page)).toEqual(after);
  } finally {
    await other.close();
    f.mac.close();
  }
});

for (const field of ["messageId", "sequence"] as const) {
  test(`task and device-check ${field} reuse conflicts across families and rolls back outcomes and counters`, async ({
    page,
  }) => {
    const f = await ready(page);
    try {
      const t = await task(page, f);
      await receipt(page, t.acceptance);
      const before = await snapshot(page);
      const bad = await incoming(f, challenge(), {
        [field]: t.acceptance.header[field],
      });
      await expect(respond(page, bad)).rejects.toThrow("CONFLICT");
      expect(await snapshot(page)).toEqual(before);
      const good = await incoming(f, challenge(), { sequence: 2000 });
      const saved = await respond(page, good);
      const wire = await page.evaluate(
        (id) => window.browserPeersTest.checkEnvelope({ id, confirmed: true }),
        saved.id,
      );
      await reopen(page, f.f);
      await f.authorize();
      expect((await respond(page, good)).id).toBe(saved.id);
      expect(
        await page.evaluate(
          (id) =>
            window.browserPeersTest.checkEnvelope({ id, confirmed: true }),
          saved.id,
        ),
      ).toEqual(wire);
      const next = await task(page, f),
        snapshotBefore = await snapshot(page);
      const collision = await incoming(
        f,
        { version: 1, type: "task.accepted", receipt: next.receipt },
        { ...next.acceptance.header, [field]: good.header[field] },
      );
      await expect(receipt(page, collision)).rejects.toThrow("CONFLICT");
      expect(await snapshot(page)).toEqual(snapshotBefore);
      await receipt(page, next.acceptance);
    } finally {
      f.mac.close();
    }
  });
}

test("shared replay insertion and linked outcome writes fail atomically in both directions", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const t = await task(page, f),
      before = await snapshot(page);
    await fault(page, "entries", "put");
    await expect(receipt(page, t.acceptance)).rejects.toThrow("CAPACITY");
    expect(await snapshot(page)).toEqual(before);
    const c = await incoming(f, challenge());
    await fault(page, "incoming_replay", "add");
    await expect(respond(page, c)).rejects.toThrow("CAPACITY");
    expect(await snapshot(page)).toEqual(before);
    await respond(page, c);
    await receipt(page, t.acceptance);
  } finally {
    f.mac.close();
  }
});

test("expiry during the last replay write rolls back receipt and check effects", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const t = await task(page, f),
      before = await snapshot(page);
    await fault(page, "incoming_replay", "add", t.acceptance.header.expiresAt);
    await expect(receipt(page, t.acceptance)).rejects.toThrow("DENIED");
    expect(await snapshot(page)).toEqual(before);
    await reopen(page, f.f);
    await f.authorize();
    const c = await incoming(f, challenge());
    await fault(page, "incoming_replay", "add", c.header.expiresAt);
    await expect(respond(page, c)).rejects.toThrow("DENIED");
    expect(await snapshot(page)).toEqual(before);
  } finally {
    f.mac.close();
  }
});

for (const damage of ["corrupt", "capacity"] as const) {
  test(`browser replay ${damage} never evicts or accepts an unrecorded outcome`, async ({
    page,
  }) => {
    const f = await ready(page);
    try {
      const t = await task(page, f);
      await receipt(page, t.acceptance);
      const id = await privateReplayIdentity(t.acceptance, "task.accepted");
      await editReplay(page, damage, id.operation);
      const before = await snapshot(page);
      if (damage === "corrupt")
        await expect(receipt(page, t.acceptance)).rejects.toThrow(
          "STORAGE_UNAVAILABLE",
        );
      else {
        await receipt(page, t.acceptance);
        await expect(
          page.evaluate((w) => window.browserPeersTest.taskResult(w), t.result),
        ).rejects.toThrow("CAPACITY");
      }
      expect(await snapshot(page)).toEqual(before);
    } finally {
      f.mac.close();
    }
  });
}

test("actual version8 provider upgrade preserves tasks and keys and only reconciles authenticated original retries", async ({
  page,
}) => {
  const f = await ready(page, "replay");
  try {
    const t = await task(page, f);
    await receipt(page, t.acceptance);
    const before = await snapshot(page),
      key = await page.evaluate(() => window.browserPeersTest.key());
    expect(before.version).toBe(8);
    expect(before.rows.incoming_replay).toBeUndefined();
    await reopen(page, f.f);
    await f.authorize();
    const migrated = await snapshot(page);
    expect(migrated.version).toBe(9);
    expect(migrated.rows.incoming_replay).toEqual([]);
    for (const name of Object.keys(before.rows))
      expect(migrated.rows[name]).toEqual(before.rows[name]);
    expect(await page.evaluate(() => window.browserPeersTest.key())).toEqual(
      key,
    );
    const substitute = await incoming(
      f,
      { version: 1, type: "task.accepted", receipt: t.receipt },
      t.acceptance.header,
    );
    await expect(receipt(page, substitute)).rejects.toThrow("CONFLICT");
    expect(await snapshot(page)).toEqual(migrated);
    await receipt(page, t.acceptance);
    const reconciled = await snapshot(page);
    expect(reconciled.rows.incoming_replay).toHaveLength(1);
    expect(reconciled.rows.entries).toEqual(before.rows.entries);
    await expect(reopen(page, f.f, "replay")).rejects.toThrow(
      "STORAGE_UNAVAILABLE",
    );
  } finally {
    f.mac.close();
  }
});

test("device verification responses share replay protection and retain only the original completion", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const t = await task(page, f);
    await receipt(page, t.acceptance);
    const c = await page.evaluate(
      (p) => window.browserPeersTest.checkBegin(p),
      {
        peerId: f.pin.peerId,
        expectedKeyRevision: f.local.revision,
        expectedPeerRevision: f.pin.revision,
        confirmed: true,
      },
    );
    const request = await page.evaluate(
      (id) => window.browserPeersTest.checkEnvelope({ id, confirmed: true }),
      c.id,
    );
    const response = await f.mac.checks.respond({
      envelope: request,
      confirmed: true,
    });
    const wire = await f.mac.checks.delivery({
      id: response.id,
      confirmed: true,
    });
    const content = JSON.parse(
      await page.evaluate(
        ({ p, wire }) =>
          window.browserPeersTest.open(p.peerId, p.keyEpoch, wire, wire.header),
        { p: f.pin, wire },
      ),
    );
    const complete = (envelope: unknown) =>
      page.evaluate(
        (envelope) =>
          window.browserPeersTest.checkComplete({ envelope, confirmed: true }),
        envelope,
      );
    const before = await snapshot(page);
    for (const field of ["messageId", "sequence"] as const) {
      const substitute = await incoming(f, content, {
        ...wire.header,
        [field]: t.acceptance.header[field],
      });
      await expect(complete(substitute)).rejects.toThrow("CONFLICT");
      expect(await snapshot(page)).toEqual(before);
    }
    await fault(page, "peer_checks", "put");
    await expect(complete(wire)).rejects.toThrow("CAPACITY");
    expect(await snapshot(page)).toEqual(before);
    const verified = await complete(wire),
      after = await snapshot(page);
    expect(after.rows.incoming_replay!.length).toBe(
      before.rows.incoming_replay!.length + 1,
    );
    await reopen(page, f.f);
    expect(await complete(wire)).toEqual(verified);
    expect(await snapshot(page)).toEqual(after);
    await expect(
      complete(await incoming(f, content, wire.header)),
    ).rejects.toThrow("CONFLICT");
  } finally {
    f.mac.close();
  }
});

test("deleting task ciphertext preserves the shared replay fence without granting missing outcomes", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const t = await task(page, f);
    await receipt(page, t.acceptance);
    const before = await snapshot(page);
    const state = await page.evaluate(() =>
      window.browserPeersTest.historyStatus(),
    );
    await page.evaluate(
      (expectedRevision) =>
        window.browserPeersTest.historyClear({
          expectedRevision,
          confirmed: true,
        }),
      state.meta!.revision,
    );
    const after = await snapshot(page);
    expect(after.rows.entries).toEqual([]);
    expect(after.rows.incoming_replay).toEqual(before.rows.incoming_replay);
    expect(after.rows.channels).toEqual(before.rows.channels);
    await expect(receipt(page, t.acceptance)).rejects.toThrow();
    const reused = await incoming(f, challenge(), {
      messageId: t.acceptance.header.messageId,
    });
    await expect(respond(page, reused)).rejects.toThrow("CONFLICT");
    expect(await snapshot(page)).toEqual(after);
  } finally {
    f.mac.close();
  }
});
