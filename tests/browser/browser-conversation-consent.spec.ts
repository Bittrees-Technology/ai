import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  paired,
  ready,
  reopen,
  payload,
} from "./support/retained-browser-task.js";
import {
  sealPrivateEnvelope,
  privateEnvelopeSuite,
} from "../../modules/remote/private-envelope.js";
const permissions = {
  messagesToMac: true,
  messagesToBrowser: true,
  questionsToBrowser: true,
  answersToMac: true,
};
type Fixture = Awaited<ReturnType<typeof paired>>;
const offerSequences = new WeakMap<Fixture, number>();
async function offer(f: Fixture, patch: any = {}, headerPatch: any = {}) {
  const sequence = (offerSequences.get(f) ?? 100) + 1;
  offerSequences.set(f, sequence);
  const data = {
    version: 1,
    type: "conversation.offer",
    scope: { conversationRef: randomUUID(), permissionId: randomUUID() },
    permissions,
    issuedAt: f.f.now,
    expiresAt: f.f.now + 300000,
    ...patch,
  };
  const k = await f.mac.keys.resolve(),
    p = await f.mac.peers.resolve(f.f.binding.deviceId, f.local.keyEpoch);
  const envelope = await sealPrivateEnvelope(
    {
      version: 1,
      suite: privateEnvelopeSuite,
      ownerId: f.f.binding.ownerId,
      senderId: f.mac.binding.deviceId,
      recipientId: f.f.binding.deviceId,
      senderKeyEpoch: k.proof.keyEpoch,
      recipientKeyEpoch: f.local.keyEpoch,
      messageId: randomUUID(),
      operationId: randomUUID(),
      sequence,
      issuedAt: f.f.now,
      expiresAt: f.f.now + 300000,
      ...headerPatch,
    },
    new TextEncoder().encode(JSON.stringify(data)),
    { senderKey: k.pair, recipientPublicKey: p.publicKey },
    () => f.f.now,
  );
  return { data, envelope };
}
async function prepare(
  page: Page,
  f: Fixture,
  o: Awaited<ReturnType<typeof offer>>,
  patch: any = {},
) {
  const s = await page.evaluate(() =>
    window.browserPeersTest.conversationStatus(),
  );
  return page.evaluate(
    (raw) => window.browserPeersTest.conversationPrepare(raw),
    {
      expectedRevision: s.revision,
      peerId: f.pin.peerId,
      peerKeyEpoch: f.pin.keyEpoch,
      envelope: o.envelope,
      permissions,
      expiresAt: f.f.now + 240000,
      ...patch,
    },
  );
}
const approve = (page: Page, r: any) =>
  page.evaluate(
    (r) =>
      window.browserPeersTest.conversationApprove({
        reviewId: r.reviewId,
        expectedRevision: r.expectedRevision,
        confirmed: true,
        acknowledged: true,
      }),
    r,
  );
const authorize = (
  page: Page,
  g: any,
  direction: keyof typeof permissions = "messagesToMac",
) =>
  page.evaluate(
    ({ g, direction }) =>
      window.browserPeersTest.conversationAuthorize(
        g.id,
        g.choices.scope,
        direction,
      ),
    { g, direction },
  );
test.beforeEach(async ({ context }) => {
  await context.route("**/*", (r) =>
    new URL(r.request().url()).origin === "http://127.0.0.1:44137"
      ? r.continue()
      : r.abort(),
  );
});
test("conversation approval requires independent possession and an authentic bounded Mac offer", async ({
  page,
}) => {
  const f = await paired(page);
  try {
    const o = await offer(f);
    await expect(prepare(page, f, o)).rejects.toThrow("DENIED");
    await f.proveBrowser();
    await f.proveMac();
    await expect(
      prepare(page, f, o, { peerId: randomUUID() }),
    ).rejects.toThrow();
    const tampered = structuredClone(o);
    tampered.envelope.header.messageId = randomUUID();
    await expect(prepare(page, f, tampered)).rejects.toThrow();
    await expect(
      prepare(page, f, o, { expiresAt: f.f.now + 300001 }),
    ).rejects.toThrow("DENIED");
    const narrow = await offer(f, {
      permissions: { ...permissions, answersToMac: false },
    });
    await expect(prepare(page, f, narrow)).rejects.toThrow("DENIED");
    await expect(
      prepare(page, f, o, {
        permissions: { ...permissions, questionsToBrowser: false },
      }),
    ).rejects.toThrow("DENIED");
    const r = await prepare(page, f, o, {
      permissions: { ...permissions, messagesToBrowser: false },
    });
    r.choices.permissions.messagesToBrowser = true;
    r.offer.scope.permissionId = randomUUID();
    const g = await approve(page, r);
    expect(g.choices.permissions.messagesToBrowser).toBe(false);
    expect(g.offer.scope).toEqual(o.data.scope);
    await expect(approve(page, r)).rejects.toThrow("CONFLICT");
    await expect(authorize(page, g, "messagesToBrowser")).rejects.toThrow(
      "DENIED",
    );
    await authorize(page, g);
    expect(
      await page.evaluate(() => window.browserPeersTest.conversationUse()),
    ).toBe(true);
  } finally {
    f.mac.close();
  }
});
test("conversation grants stay encrypted and separate from task permission across reload", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    expect(
      (await page.evaluate(() => window.browserPeersTest.conversationStatus()))
        .grants,
    ).toEqual([]);
    const o = await f.mac.conversationOffer(),
      g = await approve(page, await prepare(page, f, o));
    const stored = await page.evaluate(() =>
      window.browserPeersTest.conversationInspect(),
    );
    expect(stored.exportDenied).toBe(true);
    expect(stored.rows).toBe(1);
    expect(stored.json).not.toContain(o.data.scope.conversationRef);
    expect(stored.json).not.toContain("messagesToMac");
    const taskBefore = await page.evaluate(() =>
      window.browserPeersTest.consentStatus(),
    );
    await reopen(page, f.f);
    expect(
      (await page.evaluate(() => window.browserPeersTest.conversationStatus()))
        .grants,
    ).toEqual([g]);
    expect(
      await page.evaluate(() => window.browserPeersTest.consentStatus()),
    ).toEqual(taskBefore);
    await authorize(page, g);
    expect(
      await page.evaluate(() => window.browserPeersTest.conversationUse()),
    ).toBe(true);
  } finally {
    f.mac.close();
  }
});
test("renewing one conversation replaces only that grant and invalidates retained access", async ({
  page,
}) => {
  const f = await paired(page);
  try {
    await f.proveBrowser();
    await f.proveMac();
    const o = await offer(f),
      first = await approve(page, await prepare(page, f, o));
    const second = await approve(page, await prepare(page, f, await offer(f)));
    await authorize(page, first);
    const renewed = await offer(f, {
      scope: { ...o.data.scope, permissionId: randomUUID() },
    });
    const current = await approve(page, await prepare(page, f, renewed));
    await expect(
      page.evaluate(() => window.browserPeersTest.conversationUse()),
    ).rejects.toThrow();
    await expect(authorize(page, first)).rejects.toThrow("DENIED");
    const grants = (
      await page.evaluate(() => window.browserPeersTest.conversationStatus())
    ).grants;
    expect(grants).toHaveLength(2);
    expect(grants).toContainEqual(second);
    expect(grants).toContainEqual(current);
    await authorize(page, current);
    expect(
      await page.evaluate(() => window.browserPeersTest.conversationUse()),
    ).toBe(true);
  } finally {
    f.mac.close();
  }
});
test("review clocks, invalidation and stale revisions cannot save conversation access", async ({
  page,
}) => {
  const f = await paired(page);
  try {
    await f.proveBrowser();
    await f.proveMac();
    const o = await offer(f);
    const r = await prepare(page, f, o);
    await page.evaluate(
      (n) => window.browserPeersTest.time(n, 120000),
      f.f.now,
    );
    await expect(approve(page, r)).rejects.toThrow("DENIED");
    await page.evaluate((n) => window.browserPeersTest.time(n, 0), f.f.now);
    const r2 = await prepare(page, f, o);
    await page.evaluate(() => window.browserPeersTest.invalidate());
    await expect(approve(page, r2)).rejects.toThrow("CONFLICT");
    const r3 = await prepare(page, f, o);
    await page.evaluate((n) => window.browserPeersTest.time(n - 1, 0), f.f.now);
    await expect(approve(page, r3)).rejects.toThrow("DENIED");
    await page.evaluate((n) => window.browserPeersTest.time(n, 0), f.f.now);
    expect(
      (await page.evaluate(() => window.browserPeersTest.conversationStatus()))
        .grants,
    ).toEqual([]);
  } finally {
    f.mac.close();
  }
});
test("offline revocation and clearing retain tombstones without reactivating conversation access", async ({
  page,
}) => {
  const f = await paired(page);
  try {
    await f.proveBrowser();
    await f.proveMac();
    const o = await offer(f),
      g = await approve(page, await prepare(page, f, o));
    await page.evaluate(() => window.browserPeersTest.set(null));
    await page.evaluate(
      (g) =>
        window.browserPeersTest.conversationRevoke({
          grantId: g.id,
          expectedRevision: g.revision,
          confirmed: true,
        }),
      g,
    );
    const s = await page.evaluate(() =>
      window.browserPeersTest.conversationStatus(),
    );
    expect(s.grants[0]!.revoked).toBe(true);
    await page.evaluate(
      (s) =>
        window.browserPeersTest.conversationClear({
          expectedRevision: s.revision,
          confirmed: true,
        }),
      s,
    );
    const cleared = await page.evaluate(() =>
      window.browserPeersTest.conversationStatus(),
    );
    expect(cleared.grants).toEqual([]);
    expect(cleared.needsFreshDevice).toBe(true);
    expect(cleared.revision).toBeGreaterThan(s.revision);
    await page.evaluate((b) => window.browserPeersTest.set(b), f.f.binding);
    await expect(prepare(page, f, o)).rejects.toThrow("REPAIR_REQUIRED");
    await expect(
      page.evaluate(
        (s) =>
          window.browserPeersTest.conversationReset({
            expectedRevision: s.revision,
            confirmed: true,
          }),
        cleared,
      ),
    ).rejects.toThrow("REPAIR_REQUIRED");
  } finally {
    f.mac.close();
  }
});
test("corrupted encrypted consent fails closed and can only be explicitly cleared", async ({
  page,
}) => {
  const f = await paired(page);
  try {
    await f.proveBrowser();
    await f.proveMac();
    const g = await approve(page, await prepare(page, f, await offer(f)));
    await page.evaluate(() =>
      window.browserPeersTest.conversationInspect(true),
    );
    await expect(
      page.evaluate(() => window.browserPeersTest.conversationStatus()),
    ).rejects.toThrow("STORAGE_UNAVAILABLE");
    await expect(authorize(page, g)).rejects.toThrow("STORAGE_UNAVAILABLE");
    await page.evaluate(
      (g) =>
        window.browserPeersTest.conversationClear({
          expectedRevision: g.revision,
          confirmed: true,
        }),
      g,
    );
    expect(
      (await page.evaluate(() => window.browserPeersTest.conversationStatus()))
        .needsFreshDevice,
    ).toBe(true);
  } finally {
    f.mac.close();
  }
});
test("actual version7 browser storage upgrades without granting conversation access or widening existing tasks", async ({
  page,
}) => {
  const f = await ready(page, "conversation");
  try {
    const before = await page.evaluate(() =>
      window.browserPeersTest.consentStatus(),
    );
    const task = await page.evaluate(
      (p) => window.browserPeersTest.taskCreate(p),
      payload,
    );
    await reopen(page, f.f);
    expect(
      (await page.evaluate(() => window.browserPeersTest.conversationStatus()))
        .grants,
    ).toEqual([]);
    expect(
      await page.evaluate(() => window.browserPeersTest.consentStatus()),
    ).toEqual(before);
    await f.authorize();
    const exported = await page.evaluate(() =>
      window.browserPeersTest.taskExport(),
    );
    expect(exported.entries[0]!.envelope).toEqual(task.envelope);
    expect(
      (await page.evaluate(() => window.browserPeersTest.conversationInspect()))
        .version,
    ).toBe(16);
    await expect(reopen(page, f.f, "conversation")).rejects.toThrow(
      "STORAGE_UNAVAILABLE",
    );
  } finally {
    f.mac.close();
  }
});

test("current identity and peer revocation deny both fresh and retained conversation access", async ({
  page,
}) => {
  const f = await paired(page);
  try {
    await f.proveBrowser();
    await f.proveMac();
    const g = await approve(page, await prepare(page, f, await offer(f)));
    await authorize(page, g);
    await page.evaluate(
      (b) =>
        window.browserPeersTest.set({
          ...b,
          credentialEpoch: b.credentialEpoch + 1,
        }),
      f.f.binding,
    );
    await expect(
      page.evaluate(() => window.browserPeersTest.conversationUse()),
    ).rejects.toThrow();
    await expect(authorize(page, g)).rejects.toThrow();
    await page.evaluate((b) => window.browserPeersTest.set(b), f.f.binding);
    await authorize(page, g);
    const state = await page.evaluate(() => window.browserPeersTest.status());
    await page.evaluate((v) => window.browserPeersTest.revoke(v), {
      peerId: f.pin.peerId,
      expectedRevision: state.revision,
      confirmed: true,
    });
    await expect(
      page.evaluate(() => window.browserPeersTest.conversationUse()),
    ).rejects.toThrow();
    await expect(authorize(page, g)).rejects.toThrow("DENIED");
  } finally {
    f.mac.close();
  }
});

test("offer inspection authenticates Mac choices without selecting or persisting browser consent", async ({
  page,
}) => {
  const f = await paired(page);
  try {
    const o = await offer(f);
    const input = {
      expectedRevision: 0,
      peerId: f.pin.peerId,
      peerKeyEpoch: f.pin.keyEpoch,
      envelope: o.envelope,
    };
    await expect(
      page.evaluate(
        (raw) => window.browserPeersTest.conversationOpenOffer(raw),
        input,
      ),
    ).rejects.toThrow("DENIED");
    await f.proveBrowser();
    const inspected = await page.evaluate(
      (raw) => window.browserPeersTest.conversationOpenOffer(raw),
      input,
    );
    expect(inspected.offer).toEqual(o.data);
    expect(inspected.openingExpiresAt).toBe(o.envelope.header.expiresAt);
    expect(inspected.peer.peerId).toBe(f.pin.peerId);
    expect(
      await page.evaluate(() => window.browserPeersTest.conversationStatus()),
    ).toEqual({ revision: 0, needsFreshDevice: false, grants: [] });
    expect(
      (await page.evaluate(() => window.browserPeersTest.conversationInspect()))
        .rows,
    ).toBe(0);
    const r = await prepare(page, f, o);
    await page.evaluate(
      (raw) => window.browserPeersTest.conversationOpenOffer(raw),
      input,
    );
    await expect(approve(page, r)).rejects.toThrow("CONFLICT");
    const bad = structuredClone(input);
    bad.envelope.ciphertext =
      (bad.envelope.ciphertext[0] === "A" ? "B" : "A") +
      bad.envelope.ciphertext.slice(1);
    await expect(
      page.evaluate(
        (raw) => window.browserPeersTest.conversationOpenOffer(raw),
        bad,
      ),
    ).rejects.toThrow("DENIED");
    await expect(
      page.evaluate(
        (raw) => window.browserPeersTest.conversationOpenOffer(raw),
        { ...input, expectedRevision: 1 },
      ),
    ).rejects.toThrow("CONFLICT");
    expect(
      (await page.evaluate(() => window.browserPeersTest.conversationStatus()))
        .grants,
    ).toHaveLength(0);
  } finally {
    f.mac.close();
  }
});

async function replaySnapshot(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("org.bittrees.ai.browser-endpoint-keys");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      return await new Promise<{
        version: number;
        ledger: any[];
        consent: any[];
      }>((resolve, reject) => {
        const tx = db.transaction(["incoming_replay", "conversation_consents"]),
          value = {
            version: db.version,
            ledger: [] as any[],
            consent: [] as any[],
          };
        const ledger = tx.objectStore("incoming_replay").getAll(),
          consent = tx.objectStore("conversation_consents").getAll();
        ledger.onsuccess = () => {
          value.ledger = ledger.result;
        };
        consent.onsuccess = () => {
          value.consent = consent.result.map(({ key, ...row }) => ({
            ...row,
            keyExtractable: key?.extractable ?? null,
          }));
        };
        tx.oncomplete = () => resolve(value);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  });
}

test("offer replay records commit only on approval and exact original offers support fresh narrowed review", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const o = await offer(f),
      before = await replaySnapshot(page);
    await page.evaluate(
      (input) => window.browserPeersTest.conversationOpenOffer(input),
      {
        expectedRevision: 0,
        peerId: f.pin.peerId,
        peerKeyEpoch: f.pin.keyEpoch,
        envelope: o.envelope,
      },
    );
    expect(await replaySnapshot(page)).toEqual(before);
    const review = await prepare(page, f, o);
    expect(await replaySnapshot(page)).toEqual(before);
    const first = await approve(page, review),
      accepted = await replaySnapshot(page);
    expect(accepted.ledger).toHaveLength(before.ledger.length + 1);
    expect(first.offerReplay?.type).toBe("conversation.offer");
    const narrowed = await approve(
      page,
      await prepare(page, f, o, {
        permissions: { ...permissions, messagesToBrowser: false },
      }),
    );
    expect(narrowed.id).not.toBe(first.id);
    expect(narrowed.offerReplay).toEqual(first.offerReplay);
    expect((await replaySnapshot(page)).ledger).toEqual(accepted.ledger);
    await expect(authorize(page, first)).rejects.toThrow("DENIED");
    await authorize(page, narrowed);
    await expect(
      authorize(page, narrowed, "messagesToBrowser"),
    ).rejects.toThrow("DENIED");
    const resealed = await offer(f, o.data, o.envelope.header);
    await expect(
      approve(page, await prepare(page, f, resealed)),
    ).rejects.toThrow("CONFLICT");
    await reopen(page, f.f);
    const renewed = await offer(f, {
      scope: { ...o.data.scope, permissionId: randomUUID() },
    });
    const current = await approve(page, await prepare(page, f, renewed)),
      saved = await replaySnapshot(page);
    await expect(approve(page, await prepare(page, f, o))).rejects.toThrow(
      "CONFLICT",
    );
    expect(await replaySnapshot(page)).toEqual(saved);
    await authorize(page, current);
  } finally {
    f.mac.close();
  }
});

test("conversation offers and task receipts reject reused message and sequence identities in both directions", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const first = await page.evaluate(
        (p) => window.browserPeersTest.taskCreate(p),
        payload,
      ),
      t = await f.mac.executeTask(first.envelope);
    await page.evaluate(
      (w) => window.browserPeersTest.taskReceipt(w),
      t.acceptance,
    );
    const before = await replaySnapshot(page);
    for (const field of ["messageId", "sequence"] as const) {
      const collision = await offer(
        f,
        {},
        { [field]: t.acceptance.header[field] },
      );
      await expect(
        approve(page, await prepare(page, f, collision)),
      ).rejects.toThrow("CONFLICT");
      expect(await replaySnapshot(page)).toEqual(before);
    }
    const o = await offer(f);
    await approve(page, await prepare(page, f, o));
    const next = await page.evaluate(
        (p) => window.browserPeersTest.taskCreate(p),
        payload,
      ),
      task = await f.mac.executeTask(next.envelope);
    const k = await f.mac.keys.resolve(),
      p = await f.mac.peers.resolve(f.f.binding.deviceId, f.local.keyEpoch);
    const entries = await page.evaluate(() =>
        window.browserPeersTest.taskExport(),
      ),
      saved = await replaySnapshot(page);
    for (const field of ["messageId", "sequence"] as const) {
      const wire = await sealPrivateEnvelope(
        { ...task.acceptance.header, [field]: o.envelope.header[field] },
        new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            type: "task.accepted",
            receipt: task.receipt,
          }),
        ),
        { senderKey: k.pair, recipientPublicKey: p.publicKey },
        () => f.f.now,
      );
      await expect(
        page.evaluate((w) => window.browserPeersTest.taskReceipt(w), wire),
      ).rejects.toThrow("CONFLICT");
      expect(
        await page.evaluate(() => window.browserPeersTest.taskExport()),
      ).toEqual(entries);
      expect(await replaySnapshot(page)).toEqual(saved);
    }
    await page.evaluate(
      (w) => window.browserPeersTest.taskReceipt(w),
      task.acceptance,
    );
  } finally {
    f.mac.close();
  }
});

test("offer approval rolls back consent and replay together on failed writes, expiry or changed identity", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const o = await offer(f),
      before = await replaySnapshot(page);
    for (const mode of [
      "replay-write",
      "consent-write",
      "expiry",
      "identity",
    ] as const) {
      const review = await prepare(page, f, o);
      await page.evaluate(
        ({ mode, expiry }) => {
          const method = mode === "consent-write" ? "put" : "add",
            store =
              mode === "consent-write"
                ? "conversation_consents"
                : "incoming_replay";
          const original = IDBObjectStore.prototype[method];
          IDBObjectStore.prototype[method] = function (
            ...args: Parameters<typeof original>
          ) {
            if (this.name === store) {
              IDBObjectStore.prototype[method] = original;
              if (mode === "expiry") window.browserPeersTest.time(expiry, 0);
              else if (mode === "identity") window.browserPeersTest.set(null);
              else
                throw new DOMException(
                  "synthetic failure",
                  "QuotaExceededError",
                );
            }
            return original.apply(this, args);
          };
        },
        { mode, expiry: review.expiresAt },
      );
      await expect(approve(page, review)).rejects.toThrow(
        mode.endsWith("write")
          ? "CAPACITY"
          : mode === "identity"
            ? "CONFLICT"
            : "DENIED",
      );
      expect(await replaySnapshot(page)).toEqual(before);
      await reopen(page, f.f);
    }
    await approve(page, await prepare(page, f, o));
    expect((await replaySnapshot(page)).ledger).toHaveLength(
      before.ledger.length + 1,
    );
  } finally {
    f.mac.close();
  }
});

test("two browser reviews of one offer commit only one consent and replay identity", async ({
  page,
  context,
}) => {
  const f = await ready(page),
    other = await context.newPage();
  try {
    const o = await offer(f),
      before = await replaySnapshot(page);
    await reopen(other, f.f);
    const a = await prepare(page, f, o),
      b = await prepare(other, f, o);
    const results = await Promise.allSettled([
      approve(page, a),
      approve(other, b),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const denied = results.find((r) => r.status === "rejected");
    expect(
      String(denied?.status === "rejected" ? denied.reason : ""),
    ).toContain("CONFLICT");
    const state = await page.evaluate(() =>
      window.browserPeersTest.conversationStatus(),
    );
    expect(state.grants).toHaveLength(1);
    expect((await replaySnapshot(page)).ledger).toHaveLength(
      before.ledger.length + 1,
    );
  } finally {
    await other.close();
    f.mac.close();
  }
});

test("actual version9 upgrade preserves prior grant and shared ledger without inventing offer history", async ({
  page,
}) => {
  const f = await ready(page, "offer-replay");
  try {
    const o = await offer(f),
      original = await approve(page, await prepare(page, f, o));
    const before = await replaySnapshot(page),
      key = await page.evaluate(() => window.browserPeersTest.key());
    expect(before.version).toBe(9);
    expect(original.offerReplay).toBeUndefined();
    await reopen(page, f.f);
    expect(await replaySnapshot(page)).toEqual({ ...before, version: 16 });
    expect(
      (await page.evaluate(() => window.browserPeersTest.conversationStatus()))
        .grants,
    ).toEqual([original]);
    expect(await page.evaluate(() => window.browserPeersTest.key())).toEqual(
      key,
    );
    await authorize(page, original);
    const reviewed = await approve(page, await prepare(page, f, o)),
      after = await replaySnapshot(page);
    expect(reviewed.offerReplay?.type).toBe("conversation.offer");
    expect(after.ledger).toHaveLength(before.ledger.length + 1);
    expect(after.ledger).toEqual(expect.arrayContaining(before.ledger));
    await expect(reopen(page, f.f, "offer-replay")).rejects.toThrow(
      "STORAGE_UNAVAILABLE",
    );
  } finally {
    f.mac.close();
  }
});

async function selectedOffer(o: Awaited<ReturnType<typeof offer>>) {
  const { privateRelayEnvelopeHash } =
    await import("../../modules/remote/private-relay-contracts.js");
  return {
    envelope: o.envelope,
    selection: {
      messageId: o.envelope.header.messageId,
      envelopeHash: await privateRelayEnvelopeHash(o.envelope),
      revision: 1,
      storedAt: o.envelope.header.issuedAt,
    },
  };
}
const beginAck = (
  page: Page,
  g: any,
  selected?: any,
  expectedRevision = g.revision,
) =>
  page.evaluate((raw) => window.browserPeersTest.conversationBeginAck(raw), {
    grantId: g.id,
    expectedRevision,
    confirmed: true,
    ...(selected ? { selected } : {}),
  });
const recordAck = (page: Page, attempt: any, patch: any = {}) =>
  page.evaluate((raw) => window.browserPeersTest.conversationRecordAck(raw), {
    grantId: attempt.grant.id,
    expectedRevision: attempt.revision,
    confirmed: true,
    receipt: {
      version: 1,
      ...attempt.grant.relayAcknowledgement.selection,
      revision: 2,
      state: "received",
      ...patch,
    },
  });
test("offer acknowledgement persists uncertain attempts across reopen and keeps exact consent and replay", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const o = await offer(f),
      grant = await approve(page, await prepare(page, f, o)),
      ledger = (await replaySnapshot(page)).ledger,
      selection = await selectedOffer(o),
      first = await beginAck(page, grant, selection);
    expect(first.grant.relayAcknowledgement!.attempts).toBe(1);
    expect(first.grant.relayAcknowledgement!.observation).toBeNull();
    await reopen(page, f.f);
    const retry = await beginAck(page, first.grant);
    expect(retry.acknowledgement).toEqual(first.acknowledgement);
    expect(retry.grant.relayAcknowledgement!.attempts).toBe(2);
    const saved = await recordAck(page, retry);
    expect(saved.grant.id).toBe(grant.id);
    expect(saved.grant.approvedAt).toBe(grant.approvedAt);
    expect(saved.grant.choices).toEqual(grant.choices);
    expect(saved.grant.relayAcknowledgement!.observation!.attempt).toBe(2);
    const uncertain = await beginAck(page, saved.grant);
    expect(uncertain.grant.relayAcknowledgement!.observation).toEqual(
      saved.grant.relayAcknowledgement!.observation,
    );
    expect((await replaySnapshot(page)).ledger).toEqual(ledger);
    await reopen(page, f.f);
    const retained = await page.evaluate(() =>
      window.browserPeersTest.conversationStatus(),
    );
    expect(retained.grants).toEqual([uncertain.grant]);
  } finally {
    f.mac.close();
  }
});
test("offer acknowledgement rejects altered ciphertext, selection, stale state and wrong server receipts", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const o = await offer(f),
      grant = await approve(page, await prepare(page, f, o)),
      selected = await selectedOffer(o),
      before = await replaySnapshot(page);
    await expect(beginAck(page, grant)).rejects.toThrow("DENIED");
    for (const field of ["ciphertext", "messageId", "envelopeHash"] as const) {
      const changed = structuredClone(selected);
      if (field === "ciphertext")
        changed.envelope.ciphertext =
          (changed.envelope.ciphertext[0] === "A" ? "B" : "A") +
          changed.envelope.ciphertext.slice(1);
      else
        changed.selection[field] =
          field === "messageId" ? randomUUID() : "a".repeat(64);
      await expect(beginAck(page, grant, changed)).rejects.toThrow("CONFLICT");
      expect(await replaySnapshot(page)).toEqual(before);
    }
    const attempt = await beginAck(page, grant, selected),
      saved = await replaySnapshot(page);
    await expect(beginAck(page, grant, selected)).rejects.toThrow("CONFLICT");
    for (const patch of [
      { messageId: randomUUID() },
      { envelopeHash: "b".repeat(64) },
      { storedAt: selected.selection.storedAt + 1 },
      { state: "stored" },
      { revision: 1 },
    ]) {
      await expect(recordAck(page, attempt, patch)).rejects.toThrow("CONFLICT");
      expect(await replaySnapshot(page)).toEqual(saved);
    }
    const observed = await recordAck(page, attempt, {
        state: "deleted",
        revision: 3,
      }),
      retry = await beginAck(page, observed.grant);
    await expect(recordAck(page, retry)).rejects.toThrow("CONFLICT");
    await expect(
      recordAck(page, retry, { state: "received", revision: 4 }),
    ).rejects.toThrow("CONFLICT");
  } finally {
    f.mac.close();
  }
});
test("offer acknowledgement requires an existing replay outcome and cannot recreate a deleted fence", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const o = await offer(f),
      grant = await approve(page, await prepare(page, f, o)),
      selected = await selectedOffer(o);
    await page.evaluate(async (operation) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open("org.bittrees.ai.browser-endpoint-keys");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("incoming_replay", "readwrite"),
            s = tx.objectStore("incoming_replay"),
            r = s.getAll();
          r.onsuccess = () => {
            for (const row of r.result)
              if (row.operation === operation)
                s.delete([row.scope, row.operation]);
          };
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    }, grant.offerReplay!.operation);
    const before = await replaySnapshot(page);
    await expect(beginAck(page, grant, selected)).rejects.toThrow("CONFLICT");
    expect(await replaySnapshot(page)).toEqual(before);
  } finally {
    f.mac.close();
  }
});
test("offer acknowledgement denies revoked, expired and superseded conversation consent", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const o = await offer(f),
      grant = await approve(page, await prepare(page, f, o)),
      attempt = await beginAck(page, grant, await selectedOffer(o));
    const narrowed = await approve(
      page,
      await prepare(page, f, o, {
        permissions: { ...permissions, messagesToBrowser: false },
      }),
    );
    expect(narrowed.relayAcknowledgement).toEqual(
      attempt.grant.relayAcknowledgement,
    );
    await expect(
      beginAck(page, attempt.grant, undefined, narrowed.revision),
    ).rejects.toThrow("DENIED");
    const latest = await beginAck(page, narrowed);
    await page.evaluate(
      (raw) => window.browserPeersTest.conversationRevoke(raw),
      {
        grantId: latest.grant.id,
        expectedRevision: latest.revision,
        confirmed: true,
      },
    );
    await expect(
      beginAck(page, latest.grant, undefined, latest.revision + 1),
    ).rejects.toThrow("DENIED");
    const fresh = await approve(page, await prepare(page, f, o)),
      before = await replaySnapshot(page);
    await page.evaluate(
      (t) => window.browserPeersTest.time(t, 0),
      fresh.choices.expiresAt,
    );
    await expect(beginAck(page, fresh)).rejects.toThrow("DENIED");
    expect(await replaySnapshot(page)).toEqual(before);
  } finally {
    f.mac.close();
  }
});
test("offer acknowledgement write failure and identity loss roll back attempts and observations", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const o = await offer(f),
      grant = await approve(page, await prepare(page, f, o)),
      selection = await selectedOffer(o);
    for (const mode of ["write", "identity", "expiry"] as const) {
      const before = await replaySnapshot(page);
      await page.evaluate(
        ({ mode, expires }) => {
          const put = IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put = function (
            ...args: Parameters<typeof put>
          ) {
            if (this.name === "conversation_consents") {
              IDBObjectStore.prototype.put = put;
              if (mode === "write")
                throw new DOMException("synthetic quota", "QuotaExceededError");
              if (mode === "identity") window.browserPeersTest.set(null);
              if (mode === "expiry") window.browserPeersTest.time(expires, 0);
            }
            return put.apply(this, args);
          };
        },
        { mode, expires: grant.choices.expiresAt },
      );
      await expect(beginAck(page, grant, selection)).rejects.toThrow(
        mode === "write"
          ? "CAPACITY"
          : mode === "identity"
            ? "CONFLICT"
            : "DENIED",
      );
      expect(await replaySnapshot(page)).toEqual(before);
      await reopen(page, f.f);
    }
    const attempt = await beginAck(page, grant, selection),
      before = await replaySnapshot(page);
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        ...args: Parameters<typeof put>
      ) {
        if (this.name === "conversation_consents") {
          IDBObjectStore.prototype.put = put;
          throw new DOMException("synthetic quota", "QuotaExceededError");
        }
        return put.apply(this, args);
      };
    });
    await expect(recordAck(page, attempt)).rejects.toThrow("CAPACITY");
    expect(await replaySnapshot(page)).toEqual(before);
    await reopen(page, f.f);
    await recordAck(page, await beginAck(page, attempt.grant));
  } finally {
    f.mac.close();
  }
});
test("actual version10 upgrade preserves consent and replay without inventing relay acknowledgement", async ({
  page,
}) => {
  const f = await ready(page, "offer-ack");
  try {
    const o = await offer(f),
      grant = await approve(page, await prepare(page, f, o)),
      before = await replaySnapshot(page);
    expect(before.version).toBe(10);
    expect(grant.offerReplay).toBeDefined();
    expect(grant.relayAcknowledgement).toBeUndefined();
    await reopen(page, f.f);
    expect(await replaySnapshot(page)).toEqual({ ...before, version: 16 });
    expect(
      (await page.evaluate(() => window.browserPeersTest.conversationStatus()))
        .grants,
    ).toEqual([grant]);
    const first = await beginAck(page, grant, await selectedOffer(o));
    await recordAck(page, first);
    expect((await replaySnapshot(page)).ledger).toEqual(before.ledger);
    await expect(reopen(page, f.f, "offer-ack")).rejects.toThrow(
      "STORAGE_UNAVAILABLE",
    );
  } finally {
    f.mac.close();
  }
});
