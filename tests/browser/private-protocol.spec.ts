import { PrivateTaskResponses } from "../../modules/remote/private-task-responses.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../modules/storage/store.js";
import { Vault } from "../../modules/storage/vault.js";
import { PrivatePeerEnrollment } from "../../modules/remote/private-peers.js";
import { PrivateTaskReceiver } from "../../modules/remote/private-task-receiver.js";
import { inspectPrivateInvitation } from "../../modules/remote/private-peer-contracts.js";
import {
  sealPrivateEnvelope,
  privateEnvelopeSuite,
  type PrivateHeader,
} from "../../modules/remote/private-envelope.js";
import { LocalWorker } from "../../apps/companion/worker.js";
import type { PrivateTaskReceipt } from "../../modules/remote/private-task-contracts.js";
const pair = () =>
  crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
const owner = { userId: "browser-test", tenantId: "synthetic" };
const profile = {
  id: "local",
  runtime: "ollama",
  model: "synthetic",
  contextTokens: 4096,
  maxOutputTokens: 1024,
  temperature: 0.2,
} as const;
async function fixture(page: Page, reloadKeys = false) {
  const external: string[] = [];
  await page.context().route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== "http://127.0.0.1:44137") {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  await page.goto("/");
  await page.waitForFunction(() => !!window.privateProtocolTest);
  const testPair = reloadKeys
    ? await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
      )
    : null;
  const testKeys = testPair
    ? {
        privateKey: Buffer.from(
          await crypto.subtle.exportKey("pkcs8", testPair.privateKey),
        ).toString("base64"),
        publicKey: Buffer.from(
          await crypto.subtle.exportKey("raw", testPair.publicKey),
        ).toString("base64"),
      }
    : undefined;
  const browser = await page.evaluate(
    (value) => window.privateProtocolTest.init(value),
    testKeys,
  );
  expect(browser.secureContext).toBe(true);
  expect(browser.privateExtractable).toBe(false);
  expect(browser.privateExportDenied).toBe(true);
  const dir = mkdtempSync(join(tmpdir(), "browser-private-protocol-")),
    now = Date.now(),
    clock = () => now,
    vault = new Vault(randomBytes(32)),
    store = new Store(join(dir, "tasks.db"), vault, clock);
  store.addProfile(owner, profile);
  const binding = {
      ownerId: randomUUID(),
      deviceId: randomUUID(),
      credentialEpoch: 1,
      expiresAt: now + 3600000,
    },
    browserId = randomUUID(),
    key = await pair();
  const registry = new PrivatePeerEnrollment(
    store,
    vault,
    owner,
    () => binding,
    clock,
  );
  const invitation = {
    version: 1 as const,
    ownerId: binding.ownerId,
    recipientId: browserId,
    peerId: binding.deviceId,
    keyEpoch: 1,
    publicKey: Buffer.from(
      await crypto.subtle.exportKey("raw", key.publicKey),
    ).toString("base64url"),
    nonce: randomUUID(),
    issuedAt: now,
    expiresAt: now + 300000,
  };
  const nodeInspection = await inspectPrivateInvitation(invitation, now);
  const browserInspection = await page.evaluate(
    ({ invitation, now }) =>
      window.privateProtocolTest.inspect(invitation, now),
    { invitation, now },
  );
  expect(browserInspection.fingerprint).toBe(nodeInspection.fingerprint);
  expect(browserInspection.keyHash).toBe(nodeInspection.keyHash);
  const review = await registry.prepare({
    ...invitation,
    recipientId: binding.deviceId,
    peerId: browserId,
    publicKey: browser.publicKey,
    nonce: randomUUID(),
  });
  registry.approve({
    reviewId: review.reviewId,
    expectedRevision: review.expectedRevision,
    comparedFingerprint: review.fingerprint,
    confirmed: true,
  });
  const receiver = new PrivateTaskReceiver(
    store,
    vault,
    owner,
    () => binding,
    () => ({
      binding,
      peerId: browserId,
      recipientKeyEpoch: 1,
      permissionRevision: 1,
      modelProfileId: "local",
      tasksEnabled: true,
      recipientKey: key,
    }),
    clock,
  );
  const responses = new PrivateTaskResponses(
    store,
    vault,
    owner,
    () => binding,
    () => ({
      binding,
      peerId: browserId,
      senderKeyEpoch: 1,
      permissionRevision: 1,
      admissionRevision: 1,
      acceptanceEnabled: true,
      resultsEnabled: true,
      senderKey: key,
    }),
    clock,
  );
  const browserPublicKey = await crypto.subtle.importKey(
    "raw",
    Buffer.from(browser.publicKey, "base64url"),
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
  const header = (): PrivateHeader => ({
    version: 1,
    suite: privateEnvelopeSuite,
    ownerId: binding.ownerId,
    senderId: browserId,
    recipientId: binding.deviceId,
    senderKeyEpoch: 1,
    recipientKeyEpoch: 1,
    messageId: randomUUID(),
    operationId: randomUUID(),
    sequence: 1,
    issuedAt: now,
    expiresAt: now + 300000,
  });
  const seal = (h = header(), prompt = "Summarize this synthetic note.") =>
    page.evaluate(
      ({ h, prompt, now }) =>
        window.privateProtocolTest.seal(
          h,
          { version: 1, type: "task.submit", kind: "query", prompt },
          now,
        ),
      { h, prompt, now },
    );
  const response = (receipt: PrivateTaskReceipt, senderKey = key) => {
    const h = {
      ...receipt.header,
      senderId: binding.deviceId,
      recipientId: browserId,
      messageId: randomUUID(),
    };
    return sealPrivateEnvelope(
      h,
      new TextEncoder().encode(
        JSON.stringify({ version: 1, type: "task.accepted", receipt }),
      ),
      { senderKey, recipientPublicKey: browserPublicKey },
      clock,
    );
  };
  const sealResponse = (
    receipt: PrivateTaskReceipt,
    payload: unknown,
    patch: Partial<PrivateHeader> = {},
    senderKey = key,
  ) =>
    sealPrivateEnvelope(
      {
        ...receipt.header,
        senderId: binding.deviceId,
        recipientId: browserId,
        senderKeyEpoch: 1,
        recipientKeyEpoch: 1,
        messageId: randomUUID(),
        sequence: 2,
        issuedAt: now,
        expiresAt: now + 300000,
        ...patch,
      },
      new TextEncoder().encode(JSON.stringify(payload)),
      { senderKey, recipientPublicKey: browserPublicKey },
      clock,
    );
  const restoreKeys = async () => {
    if (!testKeys) throw Error("No synthetic key reload fixture");
    await page.evaluate(
      (value) => window.privateProtocolTest.init(value),
      testKeys,
    );
    await page.evaluate(
      ({ invitation, now }) =>
        window.privateProtocolTest.inspect(invitation, now),
      { invitation, now },
    );
  };
  return {
    sealResponse,
    restoreKeys,
    responses,
    store,
    registry,
    binding,
    browserId,
    receiver,
    header,
    seal,
    response,
    now,
    external,
    peerFingerprint: nodeInspection.fingerprint,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("Browser seals a private task that the real companion accepts and executes once", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const wire = await f.seal(),
      [first, retry] = await Promise.all([
        f.receiver.accept(wire),
        f.receiver.accept(structuredClone(wire)),
      ]);
    expect(retry).toEqual(first);
    expect(f.store.list(owner)).toHaveLength(1);
    let calls = 0;
    const worker = new LocalWorker(
      f.store,
      owner,
      {
        pin: async () => ({ profile, digest: "a".repeat(64) }),
        generate: async () => {
          calls++;
          return "synthetic browser result";
        },
      },
      (id) => f.store.profile(owner, id),
    );
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(false);
    expect(calls).toBe(1);
    expect(f.store.get(owner, first.taskId).status).toBe("completed");
    const response = await f.response(first),
      decoded = await page.evaluate(
        ({ response, now }) =>
          window.privateProtocolTest.open(response, response.header, now),
        { response, now: f.now },
      );
    expect(decoded.receipt).toEqual(first);
    expect(f.external).toEqual([]);
  } finally {
    f.close();
  }
});

test("Browser rejects altered, wrong-key, wrong-expectation, expired and plaintext receipt inputs", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const receipt = await f.receiver.accept(await f.seal()),
      response = await f.response(receipt),
      wrong = await f.response(receipt, await pair());
    const mutated = {
      ...response,
      ciphertext:
        (response.ciphertext[0] === "A" ? "B" : "A") +
        response.ciphertext.slice(1),
    };
    const cases = [
      { envelope: mutated, expected: response.header, now: f.now },
      { envelope: wrong, expected: wrong.header, now: f.now },
      {
        envelope: response,
        expected: { ...response.header, sequence: 2 },
        now: f.now,
      },
      {
        envelope: response,
        expected: response.header,
        now: response.header.expiresAt,
      },
      {
        envelope: { header: response.header, plaintext: { receipt } },
        expected: response.header,
        now: f.now,
      },
    ];
    for (const c of cases)
      expect(
        await page.evaluate(
          (c) =>
            window.privateProtocolTest.denied(c.envelope, c.expected, c.now),
          c,
        ),
      ).toBe(true);
    expect(f.external).toEqual([]);
  } finally {
    f.close();
  }
});

test("Browser-to-companion routing and peer revocation enforce current authority", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await expect(
      f.receiver.accept(await f.seal({ ...f.header(), ownerId: randomUUID() })),
    ).rejects.toThrow("DENIED");
    const pending = await f.seal();
    f.registry.revoke({
      peerId: f.browserId,
      expectedRevision: f.registry.list().revision,
      confirmed: true,
    });
    await expect(f.receiver.accept(pending)).rejects.toThrow("DENIED");
    expect(f.store.list(owner)).toHaveLength(0);
    expect(f.external).toEqual([]);
  } finally {
    f.close();
  }
});

test("Portable task contracts preserve Unicode and reject extra authority and oversized browser payloads", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const prompt = "Olá 🌳 — 東京\n".repeat(700),
      receipt = await f.receiver.accept(await f.seal(f.header(), prompt));
    expect(f.store.get(owner, receipt.taskId).input.prompt).toBe(prompt);
    const header = f.header();
    expect(
      await page.evaluate(
        async ({ header, now }) => {
          try {
            await window.privateProtocolTest.seal(
              header,
              {
                version: 1,
                type: "task.submit",
                kind: "query",
                prompt: "synthetic",
                sourceRefs: [],
              },
              now,
            );
            return false;
          } catch {
            return true;
          }
        },
        { header, now: f.now },
      ),
    ).toBe(true);
    await expect(f.seal(header, "\u0800".repeat(32000))).rejects.toThrow(
      "PRIVATE_ENVELOPE_INVALID",
    );
    expect(f.store.list(owner)).toHaveLength(1);
    expect(f.external).toEqual([]);
  } finally {
    f.close();
  }
});

async function storage(
  page: Page,
  f: Awaited<ReturnType<typeof fixture>>,
  fresh = true,
) {
  const binding = { ...f.binding, deviceId: f.browserId },
    context = {
      binding,
      senderKeyEpoch: 1,
      peerId: f.binding.deviceId,
      peerKeyEpoch: 1,
      peerRevision: 1,
      peerFingerprint: f.peerFingerprint,
      permissionRevision: 1,
      sendingEnabled: true as const,
    };
  await page.evaluate(
    ({ binding, context, now, fresh }) =>
      window.privateStorageTest.open(binding, context, now, fresh),
    { binding, context, now: f.now, fresh },
  );
  if (fresh) await page.evaluate(() => window.privateStorageTest.initialize());
  return { binding, context };
}

test("IndexedDB preserves original ciphertext through a full page reload and receiver retry", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await storage(page, f);
    const entry = await page.evaluate(
        (peerId) => window.privateStorageTest.reserve(peerId),
        f.binding.deviceId,
      ),
      wire = await f.seal(entry.header, "PRIVATE_STORAGE_PROMPT");
    await page.evaluate(
      ({ id, envelope }) =>
        window.privateStorageTest.commit({ id, expectedRevision: 1, envelope }),
      { id: entry.id, envelope: wire },
    );
    const first = await f.receiver.accept(
      await page.evaluate(
        (id) => window.privateStorageTest.delivery(id),
        entry.id,
      ),
    );
    await page.reload();
    await page.waitForFunction(() => !!window.privateStorageTest);
    await storage(page, f, false);
    const retry = await page.evaluate(
      (id) => window.privateStorageTest.delivery(id),
      entry.id,
    );
    expect(retry).toEqual(wire);
    expect(await f.receiver.accept(retry)).toEqual(first);
    expect(f.store.list(owner)).toHaveLength(1);
    const snapshot = await page.evaluate(() =>
      window.privateStorageTest.snapshot(),
    );
    expect(snapshot.entries[0]?.attempts).toBe(2);
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_STORAGE_PROMPT");
    expect(JSON.stringify(snapshot)).not.toContain("privateKey");
  } finally {
    f.close();
  }
});

test("Two tabs allocate unique sequences and only one competing ciphertext can be published", async ({
  page,
  context,
}) => {
  const f = await fixture(page),
    second = await context.newPage();
  try {
    await storage(page, f);
    await second.goto("/");
    await second.waitForFunction(() => !!window.privateStorageTest);
    await storage(second, f, false);
    const [a, b] = await Promise.all([
      page.evaluate(
        (peerId) => window.privateStorageTest.reserve(peerId),
        f.binding.deviceId,
      ),
      second.evaluate(
        (peerId) => window.privateStorageTest.reserve(peerId),
        f.binding.deviceId,
      ),
    ]);
    expect([a.header.sequence, b.header.sequence].sort()).toEqual([1, 2]);
    const wire1 = await f.seal(a.header, "one"),
      wire2 = await f.seal(a.header, "two");
    const outcomes = await Promise.allSettled([
      page.evaluate(
        ({ id, envelope }) =>
          window.privateStorageTest.commit({
            id,
            expectedRevision: 1,
            envelope,
          }),
        { id: a.id, envelope: wire1 },
      ),
      second.evaluate(
        ({ id, envelope }) =>
          window.privateStorageTest.commit({
            id,
            expectedRevision: 1,
            envelope,
          }),
        { id: a.id, envelope: wire2 },
      ),
    ]);
    expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(
      outcomes.filter(
        (x) => x.status === "rejected" && String(x.reason).includes("CONFLICT"),
      ),
    ).toHaveLength(1);
    const sent = await page.evaluate(
      (id) => window.privateStorageTest.delivery(id),
      a.id,
    );
    expect(
      await second.evaluate(
        (id) => window.privateStorageTest.delivery(id),
        a.id,
      ),
    ).toEqual(sent);
    const before = (
      await page.evaluate(() => window.privateStorageTest.snapshot())
    ).meta!.revision;
    await page.evaluate(
      ({ id, envelope }) =>
        window.privateStorageTest.commit({ id, expectedRevision: 1, envelope }),
      { id: a.id, envelope: sent },
    );
    expect(
      (await page.evaluate(() => window.privateStorageTest.snapshot())).meta!
        .revision,
    ).toBe(before);
  } finally {
    await second.close();
    f.close();
  }
});

test("Clearing browser history fences late tabs and requires a fresh device registration", async ({
  page,
  context,
}) => {
  const f = await fixture(page),
    second = await context.newPage();
  try {
    const state = await storage(page, f);
    await second.goto("/");
    await second.waitForFunction(() => !!window.privateStorageTest);
    await storage(second, f, false);
    const entry = await page.evaluate(
        (peerId) => window.privateStorageTest.reserve(peerId),
        f.binding.deviceId,
      ),
      wire = await f.seal(entry.header),
      before = await page.evaluate(() => window.privateStorageTest.snapshot());
    await expect(
      page.evaluate(() =>
        window.privateStorageTest.clear({
          expectedRevision: 1,
          confirmed: true,
        }),
      ),
    ).rejects.toThrow("CONFLICT");
    const cleared = await page.evaluate(
      (revision) =>
        window.privateStorageTest.clear({
          expectedRevision: revision,
          confirmed: true,
        }),
      before.meta!.revision,
    );
    await expect(
      second.evaluate(
        ({ id, envelope }) =>
          window.privateStorageTest.commit({
            id,
            expectedRevision: 1,
            envelope,
          }),
        { id: entry.id, envelope: wire },
      ),
    ).rejects.toThrow("SETUP_REQUIRED");
    await expect(
      page.evaluate(
        (revision) => window.privateStorageTest.initialize(revision),
        cleared.revision,
      ),
    ).rejects.toThrow("SETUP_REQUIRED");
    const empty = await page.evaluate(() =>
      window.privateStorageTest.snapshot(),
    );
    expect(empty.entries).toEqual([]);
    expect(JSON.stringify(empty)).not.toContain(f.browserId);
    expect(JSON.stringify(empty)).not.toContain(f.binding.ownerId);
    const binding = { ...state.binding, deviceId: randomUUID() },
      next = { ...state.context, binding, senderKeyEpoch: 2 };
    await page.evaluate(
      ({ binding, next, now }) =>
        window.privateStorageTest.open(binding, next, now, true),
      { binding, next, now: f.now },
    );
    await page.evaluate(
      (revision) => window.privateStorageTest.initialize(revision),
      cleared.revision,
    );
    const fresh = await page.evaluate(
      (peerId) => window.privateStorageTest.reserve(peerId),
      f.binding.deviceId,
    );
    expect(fresh.header.sequence).toBe(1);
    expect(fresh.header.senderId).toBe(binding.deviceId);
    await expect(
      second.evaluate(
        (peerId) => window.privateStorageTest.reserve(peerId),
        f.binding.deviceId,
      ),
    ).rejects.toThrow("SETUP_REQUIRED");
  } finally {
    await second.close();
    f.close();
  }
});

test("Current account and permission control handoff, while stop remains available after peer permission loss", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const state = await storage(page, f),
      entry = await page.evaluate(
        (peerId) => window.privateStorageTest.reserve(peerId),
        f.binding.deviceId,
      ),
      wire = await f.seal(entry.header);
    const published = await page.evaluate(
      ({ id, envelope }) =>
        window.privateStorageTest.commit({ id, expectedRevision: 1, envelope }),
      { id: entry.id, envelope: wire },
    );
    const binding = { ...state.binding, ownerId: randomUUID() },
      otherContext = { ...state.context, binding };
    await page.evaluate(
      ({ binding, otherContext, now }) =>
        window.privateStorageTest.open(binding, otherContext, now, true),
      { binding, otherContext, now: f.now },
    );
    await page.evaluate(() => window.privateStorageTest.initialize());
    expect(
      (await page.evaluate(() => window.privateStorageTest.snapshot())).entries,
    ).toEqual([]);
    await expect(
      page.evaluate((id) => window.privateStorageTest.delivery(id), entry.id),
    ).rejects.toThrow("DENIED");
    await storage(page, f, false);
    await page.evaluate(() => window.privateStorageTest.permission(null));
    await expect(
      page.evaluate((id) => window.privateStorageTest.delivery(id), entry.id),
    ).rejects.toThrow("DENIED");
    await expect(
      page.evaluate(
        (id) =>
          window.privateStorageTest.stop({
            id,
            expectedRevision: 2,
            confirmed: false,
          }),
        entry.id,
      ),
    ).rejects.toThrow("DENIED");
    await page.evaluate(
      ({ id, revision }) =>
        window.privateStorageTest.stop({
          id,
          expectedRevision: revision,
          confirmed: true,
        }),
      { id: entry.id, revision: published.revision },
    );
    await page.evaluate(
      (c) => window.privateStorageTest.permission(c),
      state.context,
    );
    await expect(
      page.evaluate((id) => window.privateStorageTest.delivery(id), entry.id),
    ).rejects.toThrow("DENIED");
  } finally {
    f.close();
  }
});

test("Quota failure and late permission loss abort IndexedDB writes without advancing sequences or publishing ciphertext", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const state = await storage(page, f);
    expect(
      await page.evaluate(async (peerId) => {
        const add = IDBObjectStore.prototype.add;
        IDBObjectStore.prototype.add = function (...args) {
          if (this.name === "entries")
            throw new DOMException(
              "Synthetic quota failure",
              "QuotaExceededError",
            );
          return add.apply(this, args);
        };
        try {
          await window.privateStorageTest.reserve(peerId);
          return "unexpected";
        } catch (e) {
          return (e as Error).message;
        } finally {
          IDBObjectStore.prototype.add = add;
        }
      }, f.binding.deviceId),
    ).toBe("CAPACITY");
    expect(
      (await page.evaluate(() => window.privateStorageTest.snapshot())).entries,
    ).toEqual([]);
    const entry = await page.evaluate(
      (peerId) => window.privateStorageTest.reserve(peerId),
      f.binding.deviceId,
    );
    expect(entry.header.sequence).toBe(1);
    const wire = await f.seal(entry.header);
    await page.evaluate(() => window.privateStorageTest.revokeDuringCommit());
    await expect(
      page.evaluate(
        ({ id, envelope }) =>
          window.privateStorageTest.commit({
            id,
            expectedRevision: 1,
            envelope,
          }),
        { id: entry.id, envelope: wire },
      ),
    ).rejects.toThrow("DENIED");
    const remaining = (
      await page.evaluate(() => window.privateStorageTest.snapshot())
    ).entries[0]!;
    expect(remaining.state).toBe("reserved");
    expect(remaining.envelope).toBeNull();
    // A new trusted provider state is used after review; no in-memory fallback was published.
    await storage(page, f, false);
    await page.evaluate(
      (c) => window.privateStorageTest.permission(c),
      state.context,
    );
    await page.evaluate(
      ({ id, envelope }) =>
        window.privateStorageTest.commit({ id, expectedRevision: 1, envelope }),
      { id: entry.id, envelope: wire },
    );
    const beforeClear = await page.evaluate(() =>
      window.privateStorageTest.snapshot(),
    );
    expect(
      await page.evaluate(async (revision) => {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
          if (this.name === "meta")
            throw new DOMException(
              "Synthetic quota failure",
              "QuotaExceededError",
            );
          return put.apply(this, args);
        };
        try {
          await window.privateStorageTest.clear({
            expectedRevision: revision,
            confirmed: true,
          });
          return "unexpected";
        } catch (e) {
          return (e as Error).message;
        } finally {
          IDBObjectStore.prototype.put = put;
        }
      }, beforeClear.meta!.revision),
    ).toBe("CAPACITY");
    expect(
      await page.evaluate(() => window.privateStorageTest.snapshot()),
    ).toEqual(beforeClear);
    expect(
      (
        await page.evaluate(
          (peerId) => window.privateStorageTest.reserve(peerId),
          f.binding.deviceId,
        )
      ).header.sequence,
    ).toBe(2);
  } finally {
    f.close();
  }
});

test("Browser expiry, connection closure and database version changes fail without automatic storage reset", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await storage(page, f);
    const entry = await page.evaluate(
        (peerId) => window.privateStorageTest.reserve(peerId),
        f.binding.deviceId,
      ),
      wire = await f.seal(entry.header);
    await page.evaluate(
      ({ id, envelope }) =>
        window.privateStorageTest.commit({ id, expectedRevision: 1, envelope }),
      { id: entry.id, envelope: wire },
    );
    await page.evaluate(() => window.privateStorageTest.advance(3600000));
    await expect(
      page.evaluate((id) => window.privateStorageTest.delivery(id), entry.id),
    ).rejects.toThrow("DENIED");
    await storage(page, f, false);
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const r = indexedDB.open("org.bittrees.ai.browser-endpoint-keys", 6);
          r.onerror = () => reject(r.error);
          r.onblocked = () => reject(Error("blocked"));
          r.onsuccess = () => {
            r.result.close();
            resolve();
          };
        }),
    );
    await expect(
      page.evaluate(() => window.privateStorageTest.snapshot()),
    ).rejects.toThrow("STORAGE_UNAVAILABLE");
    await expect(storage(page, f, false)).rejects.toThrow(
      "STORAGE_UNAVAILABLE",
    );
  } finally {
    f.close();
  }
});

test("Browser storage capacity retains existing history and missing storage does not auto-enroll", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await storage(page, f, false);
    await expect(
      page.evaluate(
        (peerId) => window.privateStorageTest.reserve(peerId),
        f.binding.deviceId,
      ),
    ).rejects.toThrow("SETUP_REQUIRED");
    await expect(
      page.evaluate(() => window.privateStorageTest.initialize()),
    ).rejects.toThrow("DENIED");
    await storage(page, f, true);
    await page.evaluate(async (peerId) => {
      for (let i = 0; i < 256; i++)
        await window.privateStorageTest.reserve(peerId);
    }, f.binding.deviceId);
    await expect(
      page.evaluate(
        (peerId) => window.privateStorageTest.reserve(peerId),
        f.binding.deviceId,
      ),
    ).rejects.toThrow("CAPACITY");
    const saved = await page.evaluate(() =>
      window.privateStorageTest.snapshot(),
    );
    expect(saved.entries).toHaveLength(256);
    expect(new Set(saved.entries.map((e) => e.header.sequence)).size).toBe(256);
    await page.evaluate(async () => {
      window.privateStorageTest.close();
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(
          "org.bittrees.ai.browser-endpoint-keys",
        );
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(Error("blocked"));
      });
    });
    await storage(page, f, false);
    await expect(
      page.evaluate(() => window.privateStorageTest.initialize()),
    ).rejects.toThrow("DENIED");
    await expect(
      page.evaluate(
        (peerId) => window.privateStorageTest.reserve(peerId),
        f.binding.deviceId,
      ),
    ).rejects.toThrow("SETUP_REQUIRED");
  } finally {
    f.close();
  }
});

async function submitted(page: Page, f: Awaited<ReturnType<typeof fixture>>) {
  const state = await storage(page, f),
    entry = await page.evaluate(
      (peerId) => window.privateStorageTest.reserve(peerId),
      f.binding.deviceId,
    ),
    wire = await f.seal(entry.header);
  await page.evaluate(
    ({ id, envelope }) =>
      window.privateStorageTest.commit({ id, expectedRevision: 1, envelope }),
    { id: entry.id, envelope: wire },
  );
  const receipt = await f.receiver.accept(wire);
  return { state, entry, receipt, response: await f.response(receipt) };
}

test("Authenticated browser acceptance survives reload without plaintext receipt storage and ends retries", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const { entry, receipt, response } = await submitted(page, f);
    const accepted = await page.evaluate(
      (wire) => window.privateStorageTest.acceptReceipt(wire),
      response,
    );
    expect(accepted.state).toBe("accepted");
    expect(accepted.receiptEnvelope).toEqual(response);
    const alternate = await f.response(receipt);
    expect(alternate).not.toEqual(response);
    expect(
      await page.evaluate(
        (wire) => window.privateStorageTest.acceptReceipt(wire),
        alternate,
      ),
    ).toEqual(accepted);
    await expect(
      page.evaluate((id) => window.privateStorageTest.delivery(id), entry.id),
    ).rejects.toThrow("DENIED");
    await expect(
      page.evaluate(
        ({ id, revision }) =>
          window.privateStorageTest.stop({
            id,
            expectedRevision: revision,
            confirmed: true,
          }),
        accepted,
      ),
    ).rejects.toThrow("CONFLICT");
    await page.reload();
    await page.waitForFunction(() => !!window.privateStorageTest);
    await storage(page, f, false);
    const saved = await page.evaluate(() =>
      window.privateStorageTest.snapshot(),
    );
    expect(saved.entries[0]).toEqual(accepted);
    expect(JSON.stringify(saved)).not.toContain(receipt.taskId);
    expect(JSON.stringify(saved)).not.toContain(receipt.id);
    // Reload has no endpoint private key; persisted status cannot authorize a new receipt.
    await expect(
      page.evaluate(
        (wire) => window.privateStorageTest.acceptReceipt(wire),
        response,
      ),
    ).rejects.toThrow("DENIED");
    await page.evaluate(
      (revision) =>
        window.privateStorageTest.clear({
          expectedRevision: revision,
          confirmed: true,
        }),
      saved.meta!.revision,
    );
    expect(
      (await page.evaluate(() => window.privateStorageTest.snapshot())).entries,
    ).toEqual([]);
  } finally {
    f.close();
  }
});

test("Browser receipt acceptance rejects forged, mismatched, impossible and conflicting destination evidence", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const { entry, receipt, response } = await submitted(page, f);
    const invalid = [
      receipt,
      await f.response(receipt, await pair()),
      await f.response({
        ...receipt,
        header: { ...receipt.header, messageId: randomUUID() },
      }),
      await f.response({ ...receipt, acceptedAt: receipt.header.expiresAt }),
      await f.response({
        ...receipt,
        acceptedAt: receipt.header.issuedAt - 30001,
      }),
      {
        ...response,
        ciphertext:
          (response.ciphertext[0] === "A" ? "B" : "A") +
          response.ciphertext.slice(1),
      },
    ];
    for (const wire of invalid)
      await expect(
        page.evaluate(
          (value) => window.privateStorageTest.acceptReceipt(value),
          wire,
        ),
      ).rejects.toThrow("DENIED");
    expect(
      (await page.evaluate(() => window.privateStorageTest.snapshot()))
        .entries[0]!.state,
    ).toBe("pending");
    await page.evaluate(
      (wire) => window.privateStorageTest.acceptReceipt(wire),
      response,
    );
    await expect(
      page.evaluate(
        (wire) => window.privateStorageTest.acceptReceipt(wire),
        await f.response({ ...receipt, taskId: randomUUID() }),
      ),
    ).rejects.toThrow("CONFLICT");
    expect(f.store.list(owner)).toHaveLength(1);
    expect(entry.id).toBe(receipt.header.operationId);
  } finally {
    f.close();
  }
});

test("A late authenticated receipt reconciles a stopped browser task while concurrent receipts deduplicate", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const { entry, response } = await submitted(page, f);
    await page.evaluate(
      (id) =>
        window.privateStorageTest.stop({
          id,
          expectedRevision: 2,
          confirmed: true,
        }),
      entry.id,
    );
    const values = await Promise.all([
      page.evaluate(
        (wire) => window.privateStorageTest.acceptReceipt(wire),
        response,
      ),
      page.evaluate(
        (wire) => window.privateStorageTest.acceptReceipt(wire),
        response,
      ),
    ]);
    expect(values[0]).toEqual(values[1]);
    expect(values[0].state).toBe("accepted");
    expect(values[0].revision).toBe(4);
    expect(
      (await page.evaluate(() => window.privateStorageTest.snapshot())).meta!
        .revision,
    ).toBe(5);
  } finally {
    f.close();
  }
});

test("Receipt commit rechecks permission and key identity and rolls back on storage failure", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const { response } = await submitted(page, f);
    const original = await page.evaluate(() =>
      window.privateStorageTest.snapshot(),
    );
    await page.evaluate(() => window.privateStorageTest.revokeDuringCommit());
    await expect(
      page.evaluate(
        (wire) => window.privateStorageTest.acceptReceipt(wire),
        response,
      ),
    ).rejects.toThrow("DENIED");
    expect(
      await page.evaluate(() => window.privateStorageTest.snapshot()),
    ).toEqual(original);
    await storage(page, f, false);
    await page.evaluate(() =>
      window.privateStorageTest.rotateKeyDuringReceipt(),
    );
    await expect(
      page.evaluate(
        (wire) => window.privateStorageTest.acceptReceipt(wire),
        response,
      ),
    ).rejects.toThrow("DENIED");
    expect(
      await page.evaluate(() => window.privateStorageTest.snapshot()),
    ).toEqual(original);
    await storage(page, f, false);
    expect(
      await page.evaluate(async (wire) => {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
          if (this.name === "meta")
            throw new DOMException("Synthetic quota", "QuotaExceededError");
          return put.apply(this, args);
        };
        try {
          await window.privateStorageTest.acceptReceipt(wire);
          return "unexpected";
        } catch (e) {
          return (e as Error).message;
        } finally {
          IDBObjectStore.prototype.put = put;
        }
      }, response),
    ).toBe("CAPACITY");
    expect(
      await page.evaluate(() => window.privateStorageTest.snapshot()),
    ).toEqual(original);
    expect(
      (
        await page.evaluate(
          (wire) => window.privateStorageTest.acceptReceipt(wire),
          response,
        )
      ).state,
    ).toBe("accepted");
  } finally {
    f.close();
  }
});

test("Earlier browser rows remain readable while expired, deleted and other-account receipts are denied", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const { state, entry, response } = await submitted(page, f);
    // Model a PR112 version1 row: new optional receipt fields are absent.
    await page.evaluate(async (id) => {
      window.privateStorageTest.close();
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(
          "org.bittrees.ai.browser-endpoint-keys",
          5,
        );
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("entries", "readwrite"),
            store = tx.objectStore("entries"),
            get = store.get(id);
          get.onsuccess = () => {
            const row = get.result;
            delete row.receiptEnvelope;
            delete row.receiptHash;
            delete row.resultEnvelope;
            delete row.resultHash;
            delete row.resultReceivedAt;
            store.put(row);
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      });
    }, entry.id);
    await storage(page, f, false);
    const before = await page.evaluate(() =>
      window.privateStorageTest.snapshot(),
    );
    expect(before.entries[0]!.receiptEnvelope).toBeNull();
    expect(before.entries[0]!.state).toBe("pending");
    const otherBinding = { ...state.binding, ownerId: randomUUID() },
      otherContext = { ...state.context, binding: otherBinding };
    await page.evaluate(
      ({ binding, context, now }) =>
        window.privateStorageTest.open(binding, context, now, true),
      { binding: otherBinding, context: otherContext, now: f.now },
    );
    await page.evaluate(() => window.privateStorageTest.initialize());
    await expect(
      page.evaluate(
        (wire) => window.privateStorageTest.acceptReceipt(wire),
        response,
      ),
    ).rejects.toThrow("DENIED");
    await storage(page, f, false);
    await page.evaluate(() => window.privateStorageTest.advance(3600000));
    await expect(
      page.evaluate(
        (wire) => window.privateStorageTest.acceptReceipt(wire),
        response,
      ),
    ).rejects.toThrow("DENIED");
    await storage(page, f, false);
    expect(
      await page.evaluate(() => window.privateStorageTest.snapshot()),
    ).toEqual(before);
    expect(
      (
        await page.evaluate(
          (wire) => window.privateStorageTest.acceptReceipt(wire),
          response,
        )
      ).state,
    ).toBe("accepted");
    const accepted = await page.evaluate(() =>
      window.privateStorageTest.snapshot(),
    );
    await page.evaluate(
      (revision) =>
        window.privateStorageTest.clear({
          expectedRevision: revision,
          confirmed: true,
        }),
      accepted.meta!.revision,
    );
    await expect(
      page.evaluate(
        (wire) => window.privateStorageTest.acceptReceipt(wire),
        response,
      ),
    ).rejects.toThrow("SETUP_REQUIRED");
  } finally {
    f.close();
  }
});

test("Real companion response outbox delivers encrypted acceptance and local-worker result to the browser", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const { receipt } = await submitted(page, f),
      input = {
        operationId: receipt.header.operationId,
        peerId: f.browserId,
        kind: "accepted",
        confirmed: true,
      };
    const accepted = await f.responses.prepare(input),
      wire = f.responses.delivery(accepted.id);
    expect(
      (
        await page.evaluate(
          (value) => window.privateStorageTest.acceptReceipt(value),
          wire,
        )
      ).state,
    ).toBe("accepted");
    const worker = new LocalWorker(
      f.store,
      owner,
      {
        pin: async () => ({ profile, digest: "a".repeat(64) }),
        generate: async () => "PRIVATE_COMPANION_RESULT",
      },
      (id) => f.store.profile(owner, id),
    );
    expect(await worker.runOnce()).toBe(true);
    const result = await f.responses.prepare({ ...input, kind: "result" }),
      resultWire = f.responses.delivery(result.id);
    const decoded = await page.evaluate(
      ({ wire, now }) =>
        window.privateProtocolTest.openResult(wire, wire.header, now),
      { wire: resultWire, now: f.now },
    );
    expect(decoded.receipt).toEqual(receipt);
    expect(decoded.task.output).toBe("PRIVATE_COMPANION_RESULT");
    expect(decoded.task.status).toBe("completed");
    expect(JSON.stringify(resultWire)).not.toContain(
      "PRIVATE_COMPANION_RESULT",
    );
    expect(f.responses.delivery(result.id)).toEqual(resultWire);
    // A result is not an acceptance receipt and cannot overwrite that browser state.
    await expect(
      page.evaluate(
        (value) => window.privateStorageTest.acceptReceipt(value),
        resultWire,
      ),
    ).rejects.toThrow("DENIED");
    expect(
      (await page.evaluate(() => window.privateStorageTest.snapshot()))
        .entries[0]!.receiptEnvelope,
    ).toEqual(wire);
    expect(f.external).toEqual([]);
  } finally {
    f.close();
  }
});

async function finished(
  page: Page,
  f: Awaited<ReturnType<typeof fixture>>,
  answer = "PRIVATE_DURABLE_RESULT",
) {
  const task = await submitted(page, f);
  const accepted = await f.responses.prepare({
    operationId: task.receipt.header.operationId,
    peerId: f.browserId,
    kind: "accepted",
    confirmed: true,
  });
  const response = f.responses.delivery(accepted.id);
  const worker = new LocalWorker(
    f.store,
    owner,
    {
      pin: async () => ({ profile, digest: "a".repeat(64) }),
      generate: async () => answer,
    },
    (id) => f.store.profile(owner, id),
  );
  expect(await worker.runOnce()).toBe(true);
  const result = await f.responses.prepare({
    operationId: task.receipt.header.operationId,
    peerId: f.browserId,
    kind: "result",
    confirmed: true,
  });
  return { ...task, response, result, wire: f.responses.delivery(result.id) };
}

test("Results arriving before receipts survive reload as ciphertext and open only after current keys are supplied", async ({
  page,
}) => {
  const f = await fixture(page, true);
  try {
    const { entry, receipt, response, wire } = await finished(page, f),
      saved = await page.evaluate(
        (wire) => window.privateStorageTest.acceptResult(wire),
        wire,
      );
    expect(saved.state).toBe("accepted");
    expect(saved.receiptEnvelope).toBeNull();
    expect(saved.resultEnvelope).toEqual(wire);
    const decoded = await page.evaluate(
      ({ id, revision }) =>
        window.privateStorageTest.readResult({
          id,
          expectedRevision: revision,
          confirmed: true,
        }),
      saved,
    );
    expect(decoded.task.output).toBe("PRIVATE_DURABLE_RESULT");
    expect(decoded.receipt).toEqual(receipt);
    const withReceipt = await page.evaluate(
      (wire) => window.privateStorageTest.acceptReceipt(wire),
      response,
    );
    expect(withReceipt.resultEnvelope).toEqual(wire);
    expect(withReceipt.receiptEnvelope).toEqual(response);
    const serialized = JSON.stringify(
      await page.evaluate(() => window.privateStorageTest.snapshot()),
    );
    for (const secret of ["PRIVATE_DURABLE_RESULT", receipt.taskId, receipt.id])
      expect(serialized).not.toContain(secret);
    await page.reload();
    await page.waitForFunction(() => !!window.privateStorageTest);
    await storage(page, f, false);
    expect(
      (await page.evaluate(() => window.privateStorageTest.snapshot()))
        .entries[0],
    ).toEqual(withReceipt);
    await expect(
      page.evaluate(
        ({ id, revision }) =>
          window.privateStorageTest.readResult({
            id,
            expectedRevision: revision,
            confirmed: true,
          }),
        withReceipt,
      ),
    ).rejects.toThrow("DENIED");
    await f.restoreKeys();
    expect(
      (
        await page.evaluate(
          ({ id, revision }) =>
            window.privateStorageTest.readResult({
              id,
              expectedRevision: revision,
              confirmed: true,
            }),
          withReceipt,
        )
      ).task.output,
    ).toBe("PRIVATE_DURABLE_RESULT");
    await expect(
      page.evaluate((id) => window.privateStorageTest.delivery(id), entry.id),
    ).rejects.toThrow("DENIED");
  } finally {
    f.close();
  }
});

test("Receipt-first and concurrent or resealed result delivery deduplicate while conflicting terminal evidence cannot replace history", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const { receipt, response, wire, result } = await finished(page, f);
    await page.evaluate(
      (wire) => window.privateStorageTest.acceptReceipt(wire),
      response,
    );
    const values = await Promise.all([
      page.evaluate(
        (wire) => window.privateStorageTest.acceptResult(wire),
        wire,
      ),
      page.evaluate(
        (wire) => window.privateStorageTest.acceptResult(wire),
        wire,
      ),
    ]);
    expect(values[0]).toEqual(values[1]);
    const resealed = await f.sealResponse(receipt, result.value.content);
    expect(
      await page.evaluate(
        (wire) => window.privateStorageTest.acceptResult(wire),
        resealed,
      ),
    ).toEqual(values[0]);
    const content = result.value.content;
    if (content.type !== "task.result") throw Error("Expected result");
    for (const payload of [
      { ...content, task: { ...content.task, output: "CONFLICTING_RESULT" } },
      {
        ...content,
        task: { ...content.task, revision: content.task.revision + 1 },
      },
      { ...content, receipt: { ...receipt, id: randomUUID() } },
    ]) {
      await expect(
        page.evaluate(
          (wire) => window.privateStorageTest.acceptResult(wire),
          await f.sealResponse(receipt, payload),
        ),
      ).rejects.toThrow("CONFLICT");
    }
    expect(
      (await page.evaluate(() => window.privateStorageTest.snapshot()))
        .entries[0],
    ).toEqual(values[0]);
  } finally {
    f.close();
  }
});

test("Result viewing requires separate permission, current keys, confirmation and reviewed revision", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const { wire, response } = await finished(page, f);
    await page.evaluate(() =>
      window.privateStorageTest.resultPermission(false),
    );
    await expect(
      page.evaluate(
        (wire) => window.privateStorageTest.acceptResult(wire),
        wire,
      ),
    ).rejects.toThrow("DENIED");
    await page.evaluate(
      (wire) => window.privateStorageTest.acceptReceipt(wire),
      response,
    );
    await page.evaluate(() => window.privateStorageTest.resultPermission(true));
    const saved = await page.evaluate(
      (wire) => window.privateStorageTest.acceptResult(wire),
      wire,
    );
    for (const input of [
      { id: saved.id, expectedRevision: saved.revision, confirmed: false },
      { id: saved.id, expectedRevision: saved.revision - 1, confirmed: true },
    ])
      await expect(
        page.evaluate(
          (value) => window.privateStorageTest.readResult(value),
          input,
        ),
      ).rejects.toThrow(/DENIED|CONFLICT/);
    await page.evaluate(() =>
      window.privateStorageTest.resultPermission(false),
    );
    await expect(
      page.evaluate(
        ({ id, revision }) =>
          window.privateStorageTest.readResult({
            id,
            expectedRevision: revision,
            confirmed: true,
          }),
        saved,
      ),
    ).rejects.toThrow("DENIED");
    await page.evaluate(() => window.privateStorageTest.resultPermission(true));
    await page.evaluate(() =>
      window.privateStorageTest.rotateKeyDuringReceipt(),
    );
    await expect(
      page.evaluate(
        ({ id, revision }) =>
          window.privateStorageTest.readResult({
            id,
            expectedRevision: revision,
            confirmed: true,
          }),
        saved,
      ),
    ).rejects.toThrow("DENIED");
    await storage(page, f, false);
    await page.evaluate(() => window.privateStorageTest.revokeDuringCommit());
    await expect(
      page.evaluate(
        ({ id, revision }) =>
          window.privateStorageTest.readResult({
            id,
            expectedRevision: revision,
            confirmed: true,
          }),
        saved,
      ),
    ).rejects.toThrow("DENIED");
    expect(
      (await page.evaluate(() => window.privateStorageTest.snapshot()))
        .entries[0],
    ).toEqual(saved);
  } finally {
    f.close();
  }
});

test("Accepted result history can be read after delivery expiry but expired arrivals and deletion during decryption are denied", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const { receipt, result } = await finished(page, f),
      short = await f.sealResponse(receipt, result.value.content, {
        expiresAt: f.now + 1000,
      });
    const saved = await page.evaluate(
      (wire) => window.privateStorageTest.acceptResult(wire),
      short,
    );
    await page.evaluate(() => window.privateStorageTest.advance(2000));
    expect(
      (
        await page.evaluate(
          ({ id, revision }) =>
            window.privateStorageTest.readResult({
              id,
              expectedRevision: revision,
              confirmed: true,
            }),
          saved,
        )
      ).task.output,
    ).toBe("PRIVATE_DURABLE_RESULT");
    await expect(
      page.evaluate(
        (wire) => window.privateStorageTest.acceptResult(wire),
        short,
      ),
    ).rejects.toThrow("DENIED");
    const meta = (
      await page.evaluate(() => window.privateStorageTest.snapshot())
    ).meta!;
    const failure = await page.evaluate(
      async ({ id, revision, metaRevision }) => {
        const derive = crypto.subtle.deriveBits;
        let cleared = false;
        crypto.subtle.deriveBits = async function (...args) {
          if (!cleared) {
            cleared = true;
            await window.privateStorageTest.clear({
              expectedRevision: metaRevision,
              confirmed: true,
            });
          }
          return derive.apply(this, args);
        };
        try {
          await window.privateStorageTest.readResult({
            id,
            expectedRevision: revision,
            confirmed: true,
          });
          return "unexpected";
        } catch (e) {
          return (e as Error).message;
        } finally {
          crypto.subtle.deriveBits = derive;
        }
      },
      { id: saved.id, revision: saved.revision, metaRevision: meta.revision },
    );
    expect(failure).toBe("SETUP_REQUIRED");
    expect(
      (await page.evaluate(() => window.privateStorageTest.snapshot())).entries,
    ).toEqual([]);
  } finally {
    f.close();
  }
});

test("Result storage failure and late revocation do not publish partial acceptance or plaintext", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const { wire } = await finished(page, f),
      before = await page.evaluate(() => window.privateStorageTest.snapshot());
    const failure = await page.evaluate(async (wire) => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === "meta")
          throw new DOMException("Synthetic quota", "QuotaExceededError");
        return put.apply(this, args);
      };
      try {
        await window.privateStorageTest.acceptResult(wire);
        return "unexpected";
      } catch (e) {
        return (e as Error).message;
      } finally {
        IDBObjectStore.prototype.put = put;
      }
    }, wire);
    expect(failure).toBe("CAPACITY");
    expect(
      await page.evaluate(() => window.privateStorageTest.snapshot()),
    ).toEqual(before);
    await page.evaluate(() => window.privateStorageTest.revokeDuringCommit());
    await expect(
      page.evaluate(
        (wire) => window.privateStorageTest.acceptResult(wire),
        wire,
      ),
    ).rejects.toThrow("DENIED");
    expect(
      await page.evaluate(() => window.privateStorageTest.snapshot()),
    ).toEqual(before);
    await storage(page, f, false);
    expect(
      (
        await page.evaluate(
          (wire) => window.privateStorageTest.acceptResult(wire),
          wire,
        )
      ).resultEnvelope,
    ).toEqual(wire);
  } finally {
    f.close();
  }
});

test("Authenticated malformed, wrong-task, wrong-key and impossible-time results cannot enter browser history", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const { wire, receipt, result } = await finished(page, f),
      content = result.value.content;
    if (content.type !== "task.result") throw Error("Expected result");
    const invalid = [
      receipt,
      wire.header,
      {
        ...wire,
        ciphertext:
          (wire.ciphertext[0] === "A" ? "B" : "A") + wire.ciphertext.slice(1),
      },
      await f.sealResponse(receipt, content, {}, await pair()),
    ];
    for (const payload of [
      { ...content, task: { ...content.task, id: randomUUID() } },
      { ...content, task: { ...content.task, status: "failed" } },
      {
        ...content,
        task: { ...content.task, updatedAt: receipt.acceptedAt - 1 },
      },
      { ...content, task: { ...content.task, updatedAt: f.now + 30001 } },
      { ...content, task: { ...content.task, model: "injected" } },
      {
        ...content,
        receipt: {
          ...receipt,
          header: { ...receipt.header, messageId: randomUUID() },
        },
      },
    ])
      invalid.push(await f.sealResponse(receipt, payload));
    for (const value of invalid)
      await expect(
        page.evaluate(
          (wire) => window.privateStorageTest.acceptResult(wire),
          value,
        ),
      ).rejects.toThrow("DENIED");
    const before = await page.evaluate(() =>
      window.privateStorageTest.snapshot(),
    );
    expect(before.entries[0]!.resultEnvelope).toBeNull();
    expect(before.entries[0]!.state).toBe("pending");
    const saved = await page.evaluate(
      (wire) => window.privateStorageTest.acceptResult(wire),
      wire,
    );
    const changed = {
      ...saved.resultEnvelope!,
      ciphertext:
        (wire.ciphertext[0] === "A" ? "B" : "A") + wire.ciphertext.slice(1),
    };
    await page.evaluate(
      async ({ id, envelope }) => {
        const r = indexedDB.open("org.bittrees.ai.browser-endpoint-keys", 6);
        await new Promise<void>((resolve, reject) => {
          r.onerror = () => reject(r.error);
          r.onsuccess = () => {
            const db = r.result,
              tx = db.transaction("entries", "readwrite"),
              s = tx.objectStore("entries"),
              g = s.get(id);
            g.onsuccess = () =>
              s.put({ ...g.result, resultEnvelope: envelope });
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onabort = () => {
              db.close();
              reject(tx.error);
            };
          };
        });
      },
      { id: saved.id, envelope: changed },
    );
    await expect(
      page.evaluate(
        ({ id, revision }) =>
          window.privateStorageTest.readResult({
            id,
            expectedRevision: revision,
            confirmed: true,
          }),
        saved,
      ),
    ).rejects.toThrow("DENIED");
  } finally {
    f.close();
  }
});

async function reviewedUI(
  page: Page,
  f: Awaited<ReturnType<typeof fixture>>,
  answer?: string,
) {
  const value = await finished(page, f, answer);
  await page.evaluate(
    (wire) => window.privateStorageTest.acceptResult(wire),
    value.wire,
  );
  await page.bringToFront();
  await page.evaluate(() => window.privateResultsUI.mount());
  await page
    .getByRole("button", { name: "Refresh history", exact: true })
    .click();
  await expect(
    page.getByText("Response available", { exact: true }),
  ).toBeVisible();
  return value;
}

test("Private result review renders untrusted output as text and hides it on Escape and focus loss", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const malicious =
      '<img src="https://invalid.example/private" onerror="window.injected=true">\n<script>window.injected=true</script>';
    await reviewedUI(page, f, malicious);
    const preview = page.locator(".private-results-output");
    await page
      .getByRole("button", { name: "Review response", exact: true })
      .click();
    await expect(preview).toHaveText(malicious);
    expect(await preview.locator("img,script,a").count()).toBe(0);
    expect(await page.evaluate(() => "injected" in window)).toBe(false);
    expect(f.external).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(preview).toHaveText("");
    await expect(preview).toBeHidden();
    await page
      .getByRole("button", { name: "Review response", exact: true })
      .click();
    await expect(preview).toHaveText(malicious);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(preview).toHaveText("");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(preview).toHaveText("");
  } finally {
    await page.evaluate(() => window.privateResultsUI.destroy());
    f.close();
  }
});

test("Hidden, invalidated or revoked previews reject late decrypted responses and periodic access loss", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await reviewedUI(page, f);
    const preview = page.locator(".private-results-output");
    await page.evaluate(() => window.privateResultsUI.hold());
    await page
      .getByRole("button", { name: "Review response", exact: true })
      .click();
    await page.waitForFunction(() => window.privateResultsUI.held());
    await page.evaluate(() => {
      window.dispatchEvent(new Event("blur"));
      window.privateResultsUI.release();
    });
    await expect(preview).toHaveText("");
    await expect(preview).toBeHidden();
    await page
      .getByRole("button", { name: "Review response", exact: true })
      .click();
    await expect(preview).toHaveText("PRIVATE_DURABLE_RESULT");
    await page.evaluate(() => window.privateResultsUI.silentRevoke());
    await expect(preview).toHaveText("", { timeout: 5000 });
    await expect(page.getByRole("status")).toContainText("Access changed");
    await page.evaluate(() => window.privateStorageTest.resultPermission(true));
    await page
      .getByRole("button", { name: "Refresh history", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Review response", exact: true })
      .click();
    await expect(preview).toHaveText("PRIVATE_DURABLE_RESULT");
    await page.evaluate(() => window.privateResultsUI.invalidate());
    await expect(preview).toHaveText("");
    await expect(
      page.getByRole("button", { name: "Review response", exact: true }),
    ).toHaveCount(0);
  } finally {
    await page.evaluate(() => window.privateResultsUI.destroy());
    f.close();
  }
});

test("History deletion requires a fresh confirmed review and never leaves a decrypted preview", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await reviewedUI(page, f);
    await page
      .getByRole("button", { name: "Review response", exact: true })
      .click();
    await expect(page.locator(".private-results-output")).toHaveText(
      "PRIVATE_DURABLE_RESULT",
    );
    await page
      .getByRole("button", { name: "Review deletion", exact: true })
      .click();
    await expect(page.locator(".private-results-output")).toHaveText("");
    const remove = page.getByRole("button", {
      name: "Delete browser history",
      exact: true,
    });
    await expect(remove).toBeDisabled();
    await page.getByLabel("I understand what will be deleted.").check();
    // A second operation makes this reviewed deletion stale.
    await page.evaluate(
      (peerId) => window.privateStorageTest.reserve(peerId),
      f.binding.deviceId,
    );
    await remove.click();
    await expect(page.getByRole("alert")).toContainText("History changed");
    expect(
      (await page.evaluate(() => window.privateStorageTest.snapshot())).entries,
    ).toHaveLength(2);
    await page
      .getByRole("button", { name: "Refresh history", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Review deletion", exact: true })
      .click();
    await page.getByLabel("I understand what will be deleted.").check();
    await remove.click();
    await expect(page.getByRole("status")).toContainText(
      "Browser history deleted",
    );
    expect(
      (await page.evaluate(() => window.privateStorageTest.snapshot())).entries,
    ).toEqual([]);
    expect(f.store.list(owner)).toHaveLength(1);
    await expect(page.locator(".private-results-output")).toHaveText("");
  } finally {
    await page.evaluate(() => window.privateResultsUI.destroy());
    f.close();
  }
});

test("Encrypted history downloads omit plaintext and local retry stop makes no cancellation claim", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await reviewedUI(page, f);
    const downloadPromise = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download encrypted history", exact: true })
      .click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(
      "bittrees-encrypted-history.json",
    );
    const stream = await download.createReadStream();
    if (!stream) throw Error("Missing download");
    let text = "";
    for await (const chunk of stream) text += chunk.toString();
    expect(text).not.toContain("PRIVATE_DURABLE_RESULT");
    expect(JSON.parse(text).entries[0].resultEnvelope).toBeTruthy();
    const queued = await page.evaluate(
      (peerId) => window.privateStorageTest.reserve(peerId),
      f.binding.deviceId,
    );
    await page
      .getByRole("button", { name: "Refresh history", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Stop retries", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("may still run");
    expect(
      (
        await page.evaluate(() => window.privateStorageTest.snapshot())
      ).entries.find((x) => x.id === queued.id)!.state,
    ).toBe("stopped");
  } finally {
    await page.evaluate(() => window.privateResultsUI.destroy());
    f.close();
  }
});

test("Private result review remains readable and keyboard accessible at desktop and narrow widths", async ({
  page,
}, testInfo) => {
  const f = await fixture(page);
  try {
    await reviewedUI(
      page,
      f,
      "Project handoff\n\nThe Mac companion handles local drafting.\nThe Acer server continues the news briefing.\n\nNext: review this draft, then choose where to use it.",
    );
    await page.setViewportSize({ width: 1280, height: 950 });
    const open = page.getByRole("button", {
      name: "Review response",
      exact: true,
    });
    await open.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Draft result", exact: true }),
    ).toBeFocused();
    await expect(page.locator(".private-results-output")).toContainText(
      "Project handoff",
    );
    mkdirSync("test-results", { recursive: true });
    await page.screenshot({
      path: `test-results/private-results-desktop-${testInfo.project.name}.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(
      page.getByRole("button", { name: "Hide response", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `test-results/private-results-mobile-${testInfo.project.name}.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Hide response", exact: true })
      .click();
    await expect(page.locator(".private-results-output")).toHaveText("");
  } finally {
    await page.evaluate(() => window.privateResultsUI.destroy());
    f.close();
  }
});
