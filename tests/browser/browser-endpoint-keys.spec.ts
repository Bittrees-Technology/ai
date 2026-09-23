import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { inspectPrivateInvitation } from "../../modules/remote/private-peer-contracts.js";
import {
  openPrivateEnvelope,
  sealPrivateEnvelope,
  privateEnvelopeSuite,
} from "../../modules/remote/private-envelope.js";
import type { BrowserKeyAuthority } from "../../modules/remote/browser-endpoint-keys.js";
const value = (): BrowserKeyAuthority => ({
  localOwner: "synthetic:" + randomUUID(),
  binding: {
    ownerId: randomUUID(),
    deviceId: randomUUID(),
    credentialEpoch: 1,
    expiresAt: Date.now() + 3600000,
  },
  keyId: randomUUID(),
  keyEpoch: 1,
  creationAllowed: true,
});
async function init(page: Page, a = value(), now = Date.now()) {
  await page.goto("/?browser-endpoint-keys");
  await page.waitForFunction(() => !!window.browserEndpointTest);
  await page.evaluate(({ a, now }) => window.browserEndpointTest.init(a, now), {
    a,
    now,
  });
  return { a, now };
}
test.beforeEach(async ({ context }) => {
  await context.route("**/*", (r) =>
    new URL(r.request().url()).origin === "http://127.0.0.1:44137"
      ? r.continue()
      : r.abort(),
  );
});
test("Retained browser keys survive actual reload and authenticate both HPKE directions", async ({
  page,
}) => {
  const { a, now } = await init(page);
  const created = await page.evaluate(() =>
    window.browserEndpointTest.create(),
  );
  const first = await page.evaluate(() => window.browserEndpointTest.resolve());
  expect(first.privateExportDenied).toBe(true);
  expect(first.privateExtractable).toBe(false);
  const recovered = await page.evaluate(() =>
    window.browserEndpointTest.recovery(),
  );
  expect(recovered.identity).toEqual({
    localOwner: a.localOwner,
    binding: a.binding,
    keyId: a.keyId,
    keyEpoch: a.keyEpoch,
  });
  expect(recovered.publicKey).toBe(first.publicKey);
  expect(recovered.privateExtractable).toBe(false);
  expect(Object.keys(recovered.kit).sort()).toEqual([
    "ciphertext",
    "format",
    "iv",
  ]);

  expect(await page.evaluate(() => window.browserEndpointTest.stable())).toBe(
    true,
  );
  const peerId = randomUUID(),
    invitation = await page.evaluate(
      (id) => window.browserEndpointTest.invitation(id),
      peerId,
    ),
    inspected = await inspectPrivateInvitation(invitation.invitation, now);
  expect(inspected.fingerprint).toBe(invitation.fingerprint);
  const nodeKeys = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    ),
    nodePublic = Buffer.from(
      await crypto.subtle.exportKey("raw", nodeKeys.publicKey),
    ).toString("base64");
  const header = {
    version: 1 as const,
    suite: privateEnvelopeSuite,
    ownerId: a.binding.ownerId,
    senderId: peerId,
    recipientId: a.binding.deviceId,
    senderKeyEpoch: 1,
    recipientKeyEpoch: 1,
    messageId: randomUUID(),
    operationId: randomUUID(),
    sequence: 1,
    issuedAt: now,
    expiresAt: now + 60000,
  };
  const wire = await sealPrivateEnvelope(
    header,
    new TextEncoder().encode("retained private result 🐦"),
    { senderKey: nodeKeys, recipientPublicKey: inspected.publicKey },
    () => now,
  );
  await init(page, a, now);
  expect(
    await page.evaluate(() => window.browserEndpointTest.resolve()),
  ).toEqual(first);
  expect(
    await page.evaluate(
      ({ wire, nodePublic }) =>
        window.browserEndpointTest.open(wire, nodePublic),
      { wire, nodePublic },
    ),
  ).toBe("retained private result 🐦");
  const replyHeader = {
      ...header,
      senderId: header.recipientId,
      recipientId: header.senderId,
      messageId: randomUUID(),
    },
    reply = await page.evaluate(
      ({ replyHeader, nodePublic }) =>
        window.browserEndpointTest.seal(
          replyHeader,
          nodePublic,
          "retained private request",
        ),
      { replyHeader, nodePublic },
    );
  expect(
    new TextDecoder().decode(
      (
        await openPrivateEnvelope(
          reply,
          replyHeader,
          { recipientKey: nodeKeys, senderPublicKey: inspected.publicKey },
          () => now,
        )
      ).plaintext,
    ),
  ).toBe("retained private request");
  expect(
    await page.evaluate(() => window.browserEndpointTest.create()),
  ).toEqual(created);
});
test("Exact creation confirmation and current owner, binding, epoch and lease are required", async ({
  page,
}) => {
  const { a, now } = await init(page);
  for (const raw of [
    { keyId: a.keyId, keyEpoch: 1, confirmed: false },
    { keyId: randomUUID(), keyEpoch: 1, confirmed: true },
    { keyId: a.keyId, keyEpoch: 2, confirmed: true },
    { keyId: a.keyId, keyEpoch: 1, confirmed: true, extra: true },
  ])
    await expect(
      page.evaluate((raw) => window.browserEndpointTest.create(raw), raw),
    ).rejects.toThrow("DENIED");
  await page.evaluate(() => window.browserEndpointTest.create());
  for (const changed of [
    null,
    { ...a, localOwner: "other" },
    { ...a, keyEpoch: 2 },
    { ...a, binding: { ...a.binding, ownerId: randomUUID() } },
    { ...a, binding: { ...a.binding, deviceId: randomUUID() } },
    { ...a, binding: { ...a.binding, credentialEpoch: 2 } },
    { ...a, binding: { ...a.binding, expiresAt: now - 1 } },
  ]) {
    await page.evaluate((v) => window.browserEndpointTest.set(v), changed);
    await expect(
      page.evaluate(() => window.browserEndpointTest.resolve()),
    ).rejects.toThrow();
  }
  await page.evaluate((v) => window.browserEndpointTest.set(v), {
    ...a,
    creationAllowed: false,
  });
  expect(
    (await page.evaluate(() => window.browserEndpointTest.resolve())).keyId,
  ).toBe(a.keyId);
  await page.evaluate((v) => window.browserEndpointTest.set(v), {
    ...a,
    keyId: randomUUID(),
    keyEpoch: 2,
    creationAllowed: false,
  });
  await expect(
    page.evaluate(() => window.browserEndpointTest.create()),
  ).rejects.toThrow("DENIED");
  expect(
    await page.evaluate(() => window.browserEndpointTest.records()),
  ).toHaveLength(1);
});
test("Concurrent tabs cannot generate two keys for one reserved slot", async ({
  page,
  context,
}) => {
  const { a, now } = await init(page),
    other = await context.newPage();
  await init(other, a, now);
  await page.evaluate(() => window.browserEndpointTest.holdGenerate());
  const pending = page.evaluate(() => window.browserEndpointTest.create());
  await page.waitForFunction(() => window.browserEndpointTest.held());
  await expect(
    other.evaluate(() => window.browserEndpointTest.create()),
  ).rejects.toThrow("CREATION_INCOMPLETE");
  await page.evaluate(() => window.browserEndpointTest.release());
  const first = await pending;
  expect(
    await other.evaluate(() => window.browserEndpointTest.create()),
  ).toEqual(first);
  expect(
    await other.evaluate(() => window.browserEndpointTest.records()),
  ).toHaveLength(1);
});
test("Interrupted generation never regenerates an attempted slot after reload", async ({
  page,
}) => {
  const { a, now } = await init(page);
  await page.evaluate(() => window.browserEndpointTest.holdGenerate());
  const pending = page
    .evaluate(() => window.browserEndpointTest.create())
    .catch((e) => String(e));
  await page.waitForFunction(() => window.browserEndpointTest.held());
  await init(page, a, now);
  await pending;
  await expect(
    page.evaluate(() => window.browserEndpointTest.create()),
  ).rejects.toThrow("CREATION_INCOMPLETE");
  const fresh = { ...a, keyId: randomUUID(), keyEpoch: 2 };
  await page.evaluate((v) => window.browserEndpointTest.set(v), fresh);
  expect(
    (await page.evaluate(() => window.browserEndpointTest.create())).keyId,
  ).toBe(fresh.keyId);
});
test("Deletion during generation in another tab leaves a permanent keyless tombstone", async ({
  page,
  context,
}) => {
  const { a, now } = await init(page),
    other = await context.newPage();
  await init(other, a, now);
  await page.evaluate(() => window.browserEndpointTest.holdGenerate());
  const pending = page
    .evaluate(() => window.browserEndpointTest.create())
    .catch((e) => String(e));
  await page.waitForFunction(() => window.browserEndpointTest.held());
  await other.evaluate((id) => window.browserEndpointTest.remove(id), a.keyId);
  await page.evaluate(() => window.browserEndpointTest.release());
  expect(await pending).toContain("CONFLICT");
  await expect(
    page.evaluate(() => window.browserEndpointTest.resolve()),
  ).rejects.toThrow("DELETED");
  await init(page, a, now);
  await expect(
    page.evaluate(() => window.browserEndpointTest.create()),
  ).rejects.toThrow("DELETED");
  expect(
    await page.evaluate(() => window.browserEndpointTest.records()),
  ).toEqual([
    {
      keyId: a.keyId,
      state: "deleted",
      publicKey: null,
      hasPrivate: false,
      hasPublic: false,
    },
  ]);
});
test("Offline deletion denies stale tabs and never deletes another owner slot", async ({
  page,
  context,
}) => {
  const { a, now } = await init(page),
    other = await context.newPage();
  await page.evaluate(() => window.browserEndpointTest.create());
  await init(other, { ...a, localOwner: "other-owner" }, now);
  await expect(
    other.evaluate(() => window.browserEndpointTest.resolve()),
  ).rejects.toThrow("MISSING");
  await expect(
    other.evaluate((id) => window.browserEndpointTest.remove(id), a.keyId),
  ).rejects.toThrow("MISSING");
  await init(other, a, now);
  await other.evaluate(() => window.browserEndpointTest.resolve());
  await page.evaluate(() => window.browserEndpointTest.set(null));
  expect(
    (
      await page.evaluate(
        (id) => window.browserEndpointTest.recovery(id),
        a.keyId,
      )
    ).publicKey,
  ).toBe(
    (await other.evaluate(() => window.browserEndpointTest.resolve()))
      .publicKey,
  );
  await expect(
    page.evaluate(
      (id) => window.browserEndpointTest.remove(id, false),
      a.keyId,
    ),
  ).rejects.toThrow("DENIED");
  await page.evaluate((id) => window.browserEndpointTest.remove(id), a.keyId);
  await expect(
    other.evaluate(() => window.browserEndpointTest.resolve()),
  ).rejects.toThrow("DELETED");
  await expect(
    other.evaluate(() => window.browserEndpointTest.create()),
  ).rejects.toThrow("DELETED");
  await page.evaluate((id) => window.browserEndpointTest.remove(id), a.keyId);
});
test("Lost storage acknowledgement reopens the original key and quota failures preserve attempts", async ({
  page,
}) => {
  const { a } = await init(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      if (this.name === "slots" && (args[0] as any).state === "ready") {
        IDBObjectStore.prototype.put = put;
        throw new DOMException("synthetic quota", "QuotaExceededError");
      }
      return put.apply(this, args);
    };
  });
  await expect(
    page.evaluate(() => window.browserEndpointTest.create()),
  ).rejects.toThrow("CAPACITY");
  await page.evaluate(() => window.browserEndpointTest.reopen());
  await expect(
    page.evaluate(() => window.browserEndpointTest.create()),
  ).rejects.toThrow("CREATION_INCOMPLETE");
  const fresh = { ...a, keyId: randomUUID(), keyEpoch: 2 };
  await page.evaluate((v) => window.browserEndpointTest.set(v), fresh);
  // Invalidate after durable ready write; caller gets no successful output but bytes remain.
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      const r = put.apply(this, args);
      if (this.name === "slots" && (args[0] as any).state === "ready") {
        IDBObjectStore.prototype.put = put;
        this.transaction.addEventListener("complete", () =>
          window.browserEndpointTest.set(null),
        );
      }
      return r;
    };
  });
  await expect(
    page.evaluate(() => window.browserEndpointTest.create()),
  ).rejects.toThrow();
  await page.evaluate((v) => window.browserEndpointTest.set(v), fresh);
  await page.evaluate(() => window.browserEndpointTest.reopen());
  const saved = await page.evaluate(() => window.browserEndpointTest.resolve());
  expect(
    (await page.evaluate(() => window.browserEndpointTest.create())).publicKey,
  ).toBe(saved.publicKey);
});
test("Host invalidation and expired lease reject late key output even if authority returns", async ({
  page,
}) => {
  const { a, now } = await init(page);
  await page.evaluate(() => window.browserEndpointTest.holdGenerate());
  const pending = page
    .evaluate(() => window.browserEndpointTest.create())
    .catch((e) => String(e));
  await page.waitForFunction(() => window.browserEndpointTest.held());
  await page.evaluate((v) => {
    window.browserEndpointTest.set(null);
    window.browserEndpointTest.set(v);
    window.browserEndpointTest.release();
  }, a);
  expect(await pending).toContain("CONFLICT");
  await expect(
    page.evaluate(() => window.browserEndpointTest.resolve()),
  ).rejects.toThrow("CREATION_INCOMPLETE");
  const fresh = {
    ...a,
    keyId: randomUUID(),
    keyEpoch: 2,
    binding: { ...a.binding, expiresAt: now + 1000 },
  };
  await page.evaluate((v) => window.browserEndpointTest.set(v), fresh);
  await page.evaluate(() => window.browserEndpointTest.holdGenerate());
  const late = page
    .evaluate(() => window.browserEndpointTest.create())
    .catch((e) => String(e));
  await page.waitForFunction(() => window.browserEndpointTest.held());
  await page.evaluate((now) => {
    window.browserEndpointTest.time(now + 1001);
    window.browserEndpointTest.release();
  }, now);
  expect(await late).toContain("DENIED");
});
test("Tampered stored handles, public bytes and record identity fail closed", async ({
  page,
}) => {
  const { a } = await init(page);
  await page.evaluate(() => window.browserEndpointTest.create());
  for (const kind of ["private", "public", "identity", "extractable"]) {
    await page.evaluate(async (kind) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open("org.bittrees.ai.browser-endpoint-keys", 2);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const pair = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        kind === "extractable",
        ["deriveBits"],
      );
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("slots", "readwrite"),
          s = tx.objectStore("slots"),
          r = s.getAll();
        r.onsuccess = () => {
          const row = r.result.find((x) => x.state === "ready");
          if (kind === "private" || kind === "extractable")
            row.privateHandle = pair.privateKey;
          if (kind === "public") row.publicKey = "A".repeat(87);
          if (kind === "identity") row.identity.keyEpoch++;
          s.put(row);
        };
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    }, kind);
    await expect(
      page.evaluate(() => window.browserEndpointTest.resolve()),
    ).rejects.toThrow("CONFLICT");
    await page.evaluate((id) => window.browserEndpointTest.remove(id), a.keyId);
    // A fresh owner isolates each corruption case; no mutation repairs a failed slot.
    const fresh = { ...a, localOwner: "case-" + kind, keyId: a.keyId };
    await page.evaluate(
      ({ fresh, now }) => window.browserEndpointTest.init(fresh, now),
      { fresh, now: Date.now() },
    );
    await page.evaluate(() => window.browserEndpointTest.create());
  }
});
test("Slot capacity includes deleted attempts and database version change closes providers", async ({
  page,
}) => {
  const { a } = await init(page);
  for (let n = 0; n < 20; n++) {
    const v = { ...a, keyId: randomUUID(), keyEpoch: n + 1 };
    await page.evaluate((v) => window.browserEndpointTest.set(v), v);
    await page.evaluate(() => window.browserEndpointTest.create());
    await page.evaluate((id) => window.browserEndpointTest.remove(id), v.keyId);
  }
  await page.evaluate((v) => window.browserEndpointTest.set(v), {
    ...a,
    keyId: randomUUID(),
    keyEpoch: 21,
  });
  await expect(
    page.evaluate(() => window.browserEndpointTest.create()),
  ).rejects.toThrow("CAPACITY");
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const r = indexedDB.open("org.bittrees.ai.browser-endpoint-keys", 3);
        r.onsuccess = () => {
          r.result.close();
          resolve();
        };
        r.onerror = () => reject(r.error);
      }),
  );
  await expect(
    page.evaluate(() => window.browserEndpointTest.resolve()),
  ).rejects.toThrow("STORAGE_UNAVAILABLE");
  await expect(
    page.evaluate(() => window.browserEndpointTest.reopen()),
  ).rejects.toThrow("STORAGE_UNAVAILABLE");
});
