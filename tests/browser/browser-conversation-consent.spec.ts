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
async function offer(f: Fixture, patch: any = {}, headerPatch: any = {}) {
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
      sequence: 100,
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
    ).toBe(8);
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
