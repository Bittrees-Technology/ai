import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { retainedMac } from "./support/retained-mac.js";
import {
  privateEnvelopeSuite,
  openPrivateEnvelope,
  sealPrivateEnvelope,
  type PrivateHeader,
} from "../../modules/remote/private-envelope.js";
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
async function open(page: Page) {
  await page.goto("/?browser-peers");
  await page.waitForFunction(() => !!window.browserPeersTest);
}
async function init(page: Page, f = make(), activate = true) {
  await open(page);
  await page.evaluate(
    (f) => window.browserPeersTest.init(f.owner, f.binding, f.now),
    f,
  );
  if (activate) await page.evaluate(() => window.browserPeersTest.activate());
  return f;
}
async function prepare(page: Page, invitation: unknown) {
  return page.evaluate((i) => window.browserPeersTest.prepare(i), invitation);
}
async function approve(
  page: Page,
  r: { reviewId: string; expectedRevision: number; fingerprint: string },
) {
  return page.evaluate(
    (r) =>
      window.browserPeersTest.approve({
        reviewId: r.reviewId,
        expectedRevision: r.expectedRevision,
        comparedFingerprint: r.fingerprint,
        confirmed: true,
      }),
    r,
  );
}
async function pinned(page: Page) {
  const f = await init(page),
    mac = await retainedMac(f.binding, f.now);
  const invitation = await mac.invitation();
  const review = await prepare(page, invitation.invitation);
  expect(review.fingerprint).toBe(invitation.fingerprint);
  const saved = await approve(page, {
    ...review,
    fingerprint: invitation.fingerprint,
  });
  return { f, mac, invitation, saved };
}
test.beforeEach(async ({ context }) => {
  await context.route("**/*", (r) =>
    new URL(r.request().url()).origin === "http://127.0.0.1:44137"
      ? r.continue()
      : r.abort(),
  );
});

test("Retained browser and Mac keys exchange reviewed invitations and authenticated ciphertext across browser reload", async ({
  page,
}) => {
  const { f, mac, saved } = await pinned(page);
  try {
    const invitation = await page.evaluate(
      (id) =>
        window.browserPeersTest.invitation({
          recipientId: id,
          confirmed: true,
        }),
      mac.binding.deviceId,
    );
    const review = await mac.peers.prepare(invitation.invitation);
    expect(review.fingerprint).toBe(invitation.fingerprint);
    const local = (await mac.keys.resolve()).proof;
    mac.peers.approve({
      reviewId: review.reviewId,
      expectedRevision: review.expectedRevision,
      comparedFingerprint: invitation.fingerprint,
      confirmed: true,
    });
    const peer = await mac.peers.resolve(
        f.binding.deviceId,
        invitation.invitation.keyEpoch,
      ),
      mk = await mac.keys.resolve();
    expect(mk.pair.privateKey.extractable).toBe(false);
    const browser = await page.evaluate(() => window.browserPeersTest.key());
    expect(browser.privateExtractable).toBe(false);
    const header: PrivateHeader = {
      version: 1,
      suite: privateEnvelopeSuite,
      ownerId: f.binding.ownerId,
      senderId: f.binding.deviceId,
      recipientId: mac.binding.deviceId,
      senderKeyEpoch: browser.proof.keyEpoch,
      recipientKeyEpoch: local.keyEpoch,
      messageId: randomUUID(),
      operationId: randomUUID(),
      sequence: 1,
      issuedAt: f.now,
      expiresAt: f.now + 60000,
    };
    const envelope = await page.evaluate(
      ({ id, epoch, header }) =>
        window.browserPeersTest.seal(
          id,
          epoch,
          header,
          "synthetic retained-key proof",
        ),
      { id: saved.peerId, epoch: saved.keyEpoch, header },
    );
    const opened = await openPrivateEnvelope(
      envelope,
      header,
      { recipientKey: mk.pair, senderPublicKey: peer.publicKey },
      () => f.now,
    );
    expect(new TextDecoder().decode(opened.plaintext)).toBe(
      "synthetic retained-key proof",
    );
    opened.plaintext.fill(0);
    const proof = await page.evaluate(
      (s) => window.browserPeersTest.resolve(s.peerId, s.keyEpoch),
      saved,
    );
    await init(page, f, false);
    expect(
      await page.evaluate((p) => window.browserPeersTest.validate(p), proof),
    ).toBe(true);
    const reverse = {
      ...header,
      senderId: mac.binding.deviceId,
      recipientId: f.binding.deviceId,
      senderKeyEpoch: local.keyEpoch,
      recipientKeyEpoch: browser.proof.keyEpoch,
      messageId: randomUUID(),
      operationId: randomUUID(),
    };
    const reply = await sealPrivateEnvelope(
      reverse,
      new TextEncoder().encode("synthetic return proof"),
      { senderKey: mk.pair, recipientPublicKey: peer.publicKey },
      () => f.now,
    );
    expect(
      await page.evaluate(
        ({ saved, reply, reverse }) =>
          window.browserPeersTest.open(
            saved.peerId,
            saved.keyEpoch,
            reply,
            reverse,
          ),
        { saved, reply, reverse },
      ),
    ).toBe("synthetic return proof");
    expect(
      await page.evaluate(() => window.browserPeersTest.status()),
    ).not.toHaveProperty("taskPermission");
  } finally {
    mac.close();
  }
});
test("Independent full fingerprints, exact recipient and one-use review are mandatory", async ({
  page,
}) => {
  const f = await init(page),
    mac = await retainedMac(f.binding, f.now);
  try {
    const i = (await mac.invitation()).invitation;
    for (const raw of [
      { ...i, ownerId: randomUUID() },
      { ...i, recipientId: randomUUID() },
      { ...i, peerId: i.recipientId },
      { ...i, extra: true },
      { ...i, expiresAt: f.now },
      { ...i, publicKey: "A".repeat(87) },
    ])
      await expect(prepare(page, raw)).rejects.toThrow();
    const r = await prepare(page, i);
    await expect(
      page.evaluate(
        (r) =>
          window.browserPeersTest.approve({
            reviewId: r.reviewId,
            expectedRevision: r.expectedRevision,
            comparedFingerprint: "0".repeat(64),
            confirmed: true,
          }),
        r,
      ),
    ).rejects.toThrow("DENIED");
    await expect(approve(page, r)).rejects.toThrow("DENIED");
    const next = await prepare(page, i);
    await approve(page, next);
    await expect(approve(page, next)).rejects.toThrow("DENIED");
    await expect(prepare(page, i)).rejects.toThrow("DENIED");
  } finally {
    mac.close();
  }
});
test("Concurrent tabs cannot publish two reviews based on one peer revision", async ({
  page,
  context,
}) => {
  const f = await init(page),
    other = await context.newPage();
  await init(other, f, false);
  const a = await retainedMac(f.binding, f.now),
    b = await retainedMac(f.binding, f.now);
  try {
    const [ra, rb] = await Promise.all([
      prepare(page, (await a.invitation()).invitation),
      prepare(other, (await b.invitation()).invitation),
    ]);
    const outcomes = await Promise.allSettled([
      approve(page, ra),
      approve(other, rb),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (await page.evaluate(() => window.browserPeersTest.status())).state!
        .peers,
    ).toHaveLength(1);
  } finally {
    a.close();
    b.close();
  }
});
test("Offline revocation persists and denies earlier proofs after reload", async ({
  page,
}) => {
  const { f, mac, saved } = await pinned(page);
  try {
    const proof = await page.evaluate(
      (s) => window.browserPeersTest.resolve(s.peerId, s.keyEpoch),
      saved,
    );
    await page.evaluate(() => window.browserPeersTest.set(null));
    const result = await page.evaluate(
      (s) =>
        window.browserPeersTest.revoke({
          peerId: s.peerId,
          expectedRevision: s.revision,
          confirmed: true,
        }),
      saved,
    );
    expect(result).toMatchObject({
      revokedLocally: true,
      remoteRevocationConfirmed: false,
    });
    await init(page, f, false);
    expect(
      await page.evaluate((p) => window.browserPeersTest.validate(p), proof),
    ).toBe(false);
    await expect(
      page.evaluate(
        (s) => window.browserPeersTest.resolve(s.peerId, s.keyEpoch),
        saved,
      ),
    ).rejects.toThrow("DENIED");
  } finally {
    mac.close();
  }
});
test("Revocation in another tab during approval crypto prevents pin publication under the shared transaction", async ({
  page,
  context,
}) => {
  const f = await init(page),
    other = await context.newPage();
  await init(other, f, false);
  const mac = await retainedMac(f.binding, f.now);
  try {
    const r = await prepare(page, (await mac.invitation()).invitation);
    await page.evaluate(() => window.browserPeersTest.holdDigest());
    const pending = approve(page, r).catch((e) => String(e));
    await expect
      .poll(() => page.evaluate(() => window.browserPeersTest.held()))
      .toBe(true);
    const key = await other.evaluate(() => window.browserPeersTest.key());
    await other.evaluate(
      (p) =>
        window.browserPeersTest.keyRevoke({
          keyId: p.keyId,
          expectedRevision: p.revision,
          confirmed: true,
        }),
      key.proof,
    );
    await page.evaluate(() => window.browserPeersTest.release());
    expect(await pending).toMatch(/DENIED|CONFLICT/);
    expect(
      (await page.evaluate(() => window.browserPeersTest.status())).revision,
    ).toBe(0);
  } finally {
    mac.close();
  }
});
test("Scope invalidation during approval leaves no saved peer", async ({
  page,
}) => {
  const f = await init(page),
    mac = await retainedMac(f.binding, f.now);
  try {
    const r = await prepare(page, (await mac.invitation()).invitation);
    await page.evaluate(() => window.browserPeersTest.holdDigest());
    const pending = approve(page, r).catch((e) => String(e));
    await expect
      .poll(() => page.evaluate(() => window.browserPeersTest.held()))
      .toBe(true);
    await page.evaluate(() => {
      window.browserPeersTest.invalidate();
      window.browserPeersTest.release();
    });
    expect(await pending).toContain("CONFLICT");
    expect(
      (await page.evaluate(() => window.browserPeersTest.status())).revision,
    ).toBe(0);
  } finally {
    mac.close();
  }
});
test("Wall rollback, elapsed monotonic expiry and expired invitations deny approval", async ({
  page,
}) => {
  const f = await init(page),
    mac = await retainedMac(f.binding, f.now);
  try {
    for (const [wall, mono] of [
      [f.now - 1, 1],
      [f.now + 1, 300001],
      [f.now + 300001, 300001],
    ]) {
      await page.evaluate((f) => window.browserPeersTest.time(f.now, 0), f);
      const r = await prepare(page, (await mac.invitation()).invitation);
      await page.evaluate(
        ({ wall, mono }) => window.browserPeersTest.time(wall, mono),
        { wall: wall!, mono: mono! },
      );
      await expect(approve(page, r)).rejects.toThrow("DENIED");
    }
    expect(
      (await page.evaluate(() => window.browserPeersTest.status())).revision,
    ).toBe(0);
  } finally {
    mac.close();
  }
});
test("Replacement advances peer epochs and permanently retires prior public keys", async ({
  page,
}) => {
  const { mac, invitation, saved } = await pinned(page);
  try {
    await mac.activate();
    const next = await mac.invitation();
    const r = await prepare(page, next.invitation);
    expect(r.replaces?.keyEpoch).toBe(saved.keyEpoch);
    await approve(page, r);
    await expect(
      prepare(page, {
        ...invitation.invitation,
        keyEpoch: next.invitation.keyEpoch + 1,
        nonce: randomUUID(),
      }),
    ).rejects.toThrow("DENIED");
    expect(
      (await page.evaluate(() => window.browserPeersTest.status())).state!
        .retired,
    ).toHaveLength(1);
  } finally {
    mac.close();
  }
});
test("Local key replacement requires an explicit reset that retires previous peers", async ({
  page,
}) => {
  const { mac, invitation, saved } = await pinned(page);
  try {
    await page.evaluate(() => window.browserPeersTest.activate());
    await expect(
      prepare(page, (await mac.invitation()).invitation),
    ).rejects.toThrow("CONFLICT");
    await page.evaluate(
      (s) =>
        window.browserPeersTest.reset({
          expectedRevision: s.revision,
          confirmed: true,
        }),
      saved,
    );
    await expect(prepare(page, invitation.invitation)).rejects.toThrow(
      "DENIED",
    );
    const status = await page.evaluate(() => window.browserPeersTest.status());
    expect(status.state!.peers).toHaveLength(0);
    expect(status.state!.retired).toHaveLength(1);
  } finally {
    mac.close();
  }
});
test("Confirmed deletion leaves a fence until a different registered browser identity has active keys", async ({
  page,
}) => {
  const { f, mac, saved } = await pinned(page);
  try {
    const removed = await page.evaluate(
      (s) =>
        window.browserPeersTest.clear({
          expectedRevision: s.revision,
          confirmed: true,
        }),
      saved,
    );
    expect(
      (await page.evaluate(() => window.browserPeersTest.status())).state,
    ).toBeNull();
    await expect(
      page.evaluate(
        (r) =>
          window.browserPeersTest.reset({
            expectedRevision: r.revision,
            confirmed: true,
          }),
        removed,
      ),
    ).rejects.toThrow("REPAIR_REQUIRED");
    const b = { ...f.binding, deviceId: randomUUID(), credentialEpoch: 2 };
    await page.evaluate((b) => window.browserPeersTest.set(b), b);
    const ks = await page.evaluate(() => window.browserPeersTest.keyStatus());
    await page.evaluate(
      (s) =>
        window.browserPeersTest.keyReset({
          expectedRevision: s.revision,
          confirmed: true,
        }),
      ks,
    );
    await page.evaluate(() => window.browserPeersTest.activate());
    await page.evaluate(
      (r) =>
        window.browserPeersTest.reset({
          expectedRevision: r.revision,
          confirmed: true,
        }),
      removed,
    );
    expect(
      (await page.evaluate(() => window.browserPeersTest.status()))
        .needsFreshDevice,
    ).toBe(false);
  } finally {
    mac.close();
  }
});
test("Quota failure rolls publication back and consumes the original review", async ({
  page,
}) => {
  const f = await init(page),
    mac = await retainedMac(f.binding, f.now);
  try {
    const i = (await mac.invitation()).invitation,
      r = await prepare(page, i);
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        ...args: Parameters<IDBObjectStore["put"]>
      ) {
        if (this.name === "peers") {
          IDBObjectStore.prototype.put = put;
          throw new DOMException("synthetic quota", "QuotaExceededError");
        }
        return put.apply(this, args);
      };
    });
    await expect(approve(page, r)).rejects.toThrow("CAPACITY");
    expect(
      (await page.evaluate(() => window.browserPeersTest.status())).revision,
    ).toBe(0);
    await expect(approve(page, r)).rejects.toThrow("DENIED");
    await approve(page, await prepare(page, i));
  } finally {
    mac.close();
  }
});
test("Reviews are bounded and malformed peer storage fails closed", async ({
  page,
}) => {
  const f = await init(page),
    mac = await retainedMac(f.binding, f.now);
  try {
    const i = (await mac.invitation()).invitation;
    for (let n = 0; n < 4; n++) await prepare(page, i);
    await expect(prepare(page, i)).rejects.toThrow("CAPACITY");
    await page.evaluate(() => window.browserPeersTest.invalidate());
    await approve(page, await prepare(page, i));
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const r = indexedDB.open("org.bittrees.ai.browser-endpoint-keys", 7);
          r.onsuccess = () => {
            const db = r.result,
              tx = db.transaction("peers", "readwrite"),
              store = tx.objectStore("peers"),
              q = store.getAll();
            q.onsuccess = () => {
              const row = q.result[0];
              row.state.peers[0].keyEpoch = -1;
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
          r.onerror = () => reject(r.error);
        }),
    );
    await expect(
      page.evaluate(() => window.browserPeersTest.status()),
    ).rejects.toThrow("STORAGE_UNAVAILABLE");
  } finally {
    mac.close();
  }
});
test("Actual version-two keys and recovery kits survive upgrade and the older provider refuses the newer database", async ({
  page,
}) => {
  const f = make();
  await open(page);
  const old = await page.evaluate(
    (f) => window.browserPeersTest.legacySeed(f.owner, f.binding, f.now),
    f,
  );
  await init(page, f, false);
  expect(
    (await page.evaluate(() => window.browserPeersTest.key())).proof,
  ).toEqual(old.proof);
  const kit = await page.evaluate(
    (id) => window.browserPeersTest.recovery(id),
    old.proof.keyId,
  );
  expect(kit).toEqual(old.kit);
  const recovered = await page.evaluate(
    ({ kit, code }) => window.browserPeersTest.checkRecovery(kit, code),
    { kit, code: old.code },
  );
  expect(recovered.publicKey).toBe(old.proof.publicKey);
  expect(recovered.privateExtractable).toBe(false);
  expect(
    (await page.evaluate(() => window.browserPeersTest.status())).revision,
  ).toBe(0);
  await expect(
    page.evaluate(
      (f) => window.browserPeersTest.legacyOpen(f.owner, f.binding, f.now),
      f,
    ),
  ).rejects.toThrow("STORAGE_UNAVAILABLE");
});
test("Aborted version-four migration leaves the original version-two key usable", async ({
  page,
}) => {
  const f = make();
  await open(page);
  const old = await page.evaluate(
    (f) => window.browserPeersTest.legacySeed(f.owner, f.binding, f.now),
    f,
  );
  await page.evaluate(() => {
    const create = IDBDatabase.prototype.createObjectStore;
    IDBDatabase.prototype.createObjectStore = function (
      ...args: Parameters<IDBDatabase["createObjectStore"]>
    ) {
      if (args[0] === "peers") {
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
      f,
    ),
  ).rejects.toThrow("STORAGE_UNAVAILABLE");
  expect(
    await page.evaluate(
      (f) => window.browserPeersTest.legacyOpen(f.owner, f.binding, f.now),
      f,
    ),
  ).toEqual(old.proof);
  await init(page, f, false);
  expect(
    (await page.evaluate(() => window.browserPeersTest.key())).proof,
  ).toEqual(old.proof);
});
test("Future database version change closes peer handles and refuses old clients", async ({
  page,
}) => {
  await init(page);
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const r = indexedDB.open("org.bittrees.ai.browser-endpoint-keys", 8);
        r.onsuccess = () => {
          r.result.close();
          resolve();
        };
        r.onerror = () => reject(r.error);
      }),
  );
  await expect(
    page.evaluate(() => window.browserPeersTest.status()),
  ).rejects.toThrow("STORAGE_UNAVAILABLE");
});

test("Owner partitions do not expose or adopt another account's peer history", async ({
  page,
}) => {
  const { f, mac, invitation, saved } = await pinned(page);
  try {
    await init(page, make());
    expect(
      (await page.evaluate(() => window.browserPeersTest.status())).revision,
    ).toBe(0);
    await expect(prepare(page, invitation.invitation)).rejects.toThrow(
      "DENIED",
    );
    await init(page, f, false);
    expect(
      (await page.evaluate(() => window.browserPeersTest.status())).revision,
    ).toBe(saved.revision);
  } finally {
    mac.close();
  }
});

test("Peer and retired-key storage bounds refuse further enrollment without dropping history", async ({
  page,
}) => {
  const { f, mac, saved } = await pinned(page),
    another = await retainedMac(f.binding, f.now);
  try {
    // Seed validated public metadata at the exact capacity boundaries; keep the
    // original real retained-key pin intact for replacement and reset checks.
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const r = indexedDB.open("org.bittrees.ai.browser-endpoint-keys", 7);
          r.onsuccess = () => {
            const db = r.result,
              tx = db.transaction("peers", "readwrite"),
              s = tx.objectStore("peers"),
              q = s.getAll();
            q.onsuccess = () => {
              const row = q.result[0],
                pin = row.state.peers[0];
              for (let n = 1; n < 20; n++)
                row.state.peers.push({
                  ...pin,
                  peerId: crypto.randomUUID(),
                  keyHash: n.toString(16).padStart(64, "0"),
                });
              s.put(row);
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
          r.onerror = () => reject(r.error);
        }),
    );
    await expect(
      prepare(page, (await another.invitation()).invitation),
    ).rejects.toThrow("CAPACITY");
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const r = indexedDB.open("org.bittrees.ai.browser-endpoint-keys", 7);
          r.onsuccess = () => {
            const db = r.result,
              tx = db.transaction("peers", "readwrite"),
              s = tx.objectStore("peers"),
              q = s.getAll();
            q.onsuccess = () => {
              const row = q.result[0];
              row.state.peers = row.state.peers.slice(0, 1);
              row.state.retired = Array.from({ length: 512 }, (_, n) => ({
                peerId: crypto.randomUUID(),
                keyEpoch: 1,
                keyHash: n.toString(16).padStart(64, "0"),
              }));
              s.put(row);
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
          r.onerror = () => reject(r.error);
        }),
    );
    await mac.activate();
    await expect(
      prepare(page, (await mac.invitation()).invitation),
    ).rejects.toThrow("CAPACITY");
    await expect(
      page.evaluate(
        (s) =>
          window.browserPeersTest.reset({
            expectedRevision: s.revision,
            confirmed: true,
          }),
        saved,
      ),
    ).rejects.toThrow("CAPACITY");
    const status = await page.evaluate(() => window.browserPeersTest.status());
    expect(status.revision).toBe(saved.revision);
    expect(status.state!.retired).toHaveLength(512);
  } finally {
    mac.close();
    another.close();
  }
});

test("Revocation during public-key import denies the delayed resolved peer", async ({
  page,
  context,
}) => {
  const { f, mac, saved } = await pinned(page);
  try {
    const other = await context.newPage();
    await init(other, f, false);
    await page.evaluate(() => window.browserPeersTest.holdImport());
    const pending = page
      .evaluate(
        (s) => window.browserPeersTest.resolve(s.peerId, s.keyEpoch),
        saved,
      )
      .catch((e) => String(e));
    await expect
      .poll(() => page.evaluate(() => window.browserPeersTest.held()))
      .toBe(true);
    await other.evaluate(
      (s) =>
        window.browserPeersTest.revoke({
          peerId: s.peerId,
          expectedRevision: s.revision,
          confirmed: true,
        }),
      saved,
    );
    await page.evaluate(() => window.browserPeersTest.release());
    expect(await pending).toContain("CONFLICT");
  } finally {
    mac.close();
  }
});
