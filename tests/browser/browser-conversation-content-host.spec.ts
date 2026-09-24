import { expect, type Page } from "@playwright/test";
import { test } from "./support/browser-identity-server.js";
import { ready } from "./support/relay-endpoints.js";
import { randomUUID } from "node:crypto";

type Fixture = Awaited<ReturnType<typeof ready>>;
async function grant(page: Page, f: Fixture) {
  const offer = await f.mac.conversationOffer();
  const saved = await page.evaluate(
    async ({ envelope, route, permissions, expiresAt }) => {
      const api = window.browserPeersTest,
        state = await api.conversationStatus();
      const review = await api.conversationPrepare({
        ...route,
        expectedRevision: state.revision,
        envelope,
        permissions,
        expiresAt,
      });
      return api.conversationApprove({
        reviewId: review.reviewId,
        expectedRevision: review.expectedRevision,
        confirmed: true,
        acknowledged: true,
      });
    },
    {
      envelope: offer.envelope,
      route: f.route,
      permissions: offer.data.permissions,
      expiresAt: Math.min(Date.now() + 240000, offer.data.expiresAt),
    },
  );
  return { offer, grant: saved };
}
const list = (page: Page, grantId: string) =>
  page.evaluate(
    (grantId) => window.browserPeersTest.contentList({ grantId }),
    grantId,
  );
const accept = (page: Page, grantId: string, envelope: unknown) =>
  page.evaluate((raw) => window.browserPeersTest.contentAccept(raw), {
    grantId,
    envelope,
    confirmed: true,
  });
const prepare = (
  page: Page,
  grantId: string,
  patch: Record<string, unknown> = {},
) =>
  page.evaluate((raw) => window.browserPeersTest.contentPrepare(raw), {
    grantId,
    id: randomUUID(),
    kind: "message",
    parentId: null,
    content: "SYNTHETIC_HOST_PRIVATE_REPLY",
    expiresAt: Date.now() + 60000,
    confirmed: true,
    ...patch,
  });
const read = (page: Page, entry: any) =>
  page.evaluate((raw) => window.browserPeersTest.contentRead(raw), {
    grantId: entry.grantId,
    id: entry.id,
  });
const wire = (page: Page, entry: any) =>
  page.evaluate((raw) => window.browserPeersTest.contentEnvelope(raw), {
    grantId: entry.grantId,
    id: entry.id,
    expectedRevision: entry.revision,
    confirmed: true,
  });
const snapshot = (page: Page) =>
  page.evaluate(() => window.browserPeersTest.contentInspect());

test("trusted browser host opens actual Mac content, keeps listing metadata-only and reuses encrypted replies after reload", async ({
  page,
  identityServer,
}) => {
  identityServer.enablePrivateRelay();
  const f = await ready(
    page,
    identityServer.pool,
    identityServer.nativeTransport,
  );
  try {
    const selected = await grant(page, f),
      envelope = await selected.offer.message("SYNTHETIC_MAC_HOST_MESSAGE");
    const tasks = await page.evaluate(() =>
      window.browserPeersTest.consentStatus(),
    );
    identityServer.events.length = 0;
    expect(await list(page, selected.grant.id)).toEqual([]);
    const accepted = await accept(page, selected.grant.id, envelope);
    const listing = await list(page, selected.grant.id);
    expect(listing).toEqual([accepted.entry]);
    expect(JSON.stringify(listing)).not.toContain("SYNTHETIC_MAC_HOST_MESSAGE");
    expect(JSON.stringify(listing)).not.toContain('"key"');
    expect((await read(page, accepted.entry)).content.content).toBe(
      "SYNTHETIC_MAC_HOST_MESSAGE",
    );
    const reply = await prepare(page, selected.grant.id, {
      parentId: accepted.entry.id,
    });
    const encrypted = await wire(page, reply);
    expect((await selected.offer.receive(encrypted)).duplicate).toBe(false);
    expect((await selected.offer.receive(encrypted)).duplicate).toBe(true);
    const archive = await page.evaluate(() =>
      window.browserPeersTest.contentExport({ confirmed: true }),
    );
    expect(archive.items).toHaveLength(2);
    expect(archive.restoreAuthority).toBe(false);
    expect(
      identityServer.events.filter(
        (path) => path === "/browser/registration/identity",
      ).length,
    ).toBeGreaterThanOrEqual(7);
    expect(
      identityServer.events.filter((path) => path.includes("/relay/")),
    ).toEqual([]);
    expect(
      await page.evaluate(() => window.browserPeersTest.consentStatus()),
    ).toEqual(tasks);
    await page.reload();
    await page.waitForFunction(() => !!window.browserPeersTest);
    await page.evaluate(() => window.browserPeersTest.resume());
    expect(await list(page, selected.grant.id)).toHaveLength(2);
    expect(await wire(page, { ...reply, revision: 2 })).toEqual(encrypted);
    expect((await read(page, accepted.entry)).content.content).toBe(
      "SYNTHETIC_MAC_HOST_MESSAGE",
    );
  } finally {
    f.mac.close();
  }
});

test("unavailable identity denies every content action while explicit owner deletion stays offline", async ({
  page,
  identityServer,
}) => {
  identityServer.enablePrivateRelay();
  const f = await ready(
    page,
    identityServer.pool,
    identityServer.nativeTransport,
  );
  try {
    const selected = await grant(page, f),
      incoming = await selected.offer.message("SYNTHETIC_OFFLINE_HISTORY");
    const accepted = await accept(page, selected.grant.id, incoming);
    const before = await snapshot(page),
      consent = await page.evaluate(() =>
        window.browserPeersTest.conversationStatus(),
      );
    const tasks = await page.evaluate(() =>
      window.browserPeersTest.consentStatus(),
    );
    identityServer.offline(true);
    await expect(list(page, selected.grant.id)).rejects.toThrow();
    await expect(read(page, accepted.entry)).rejects.toThrow();
    await expect(prepare(page, selected.grant.id)).rejects.toThrow();
    await expect(wire(page, accepted.entry)).rejects.toThrow();
    await expect(accept(page, selected.grant.id, incoming)).rejects.toThrow();
    await expect(
      page.evaluate(() =>
        window.browserPeersTest.contentExport({ confirmed: true }),
      ),
    ).rejects.toThrow();
    expect(await snapshot(page)).toEqual(before);
    identityServer.events.length = 0;
    const cleared = await page.evaluate(
      (revision) =>
        window.browserPeersTest.contentClear({
          expectedConsentRevision: revision,
          confirmed: true,
        }),
      consent.revision,
    );
    expect(cleared.removed).toBe(1);
    expect(identityServer.events).toEqual([]);
    const after = await snapshot(page);
    expect(after.count).toBe(0);
    expect(after.ledger).toBe(before.ledger);
    expect(
      (await page.evaluate(() => window.browserPeersTest.conversationStatus()))
        .needsFreshDevice,
    ).toBe(true);
    expect(
      await page.evaluate(() => window.browserPeersTest.consentStatus()),
    ).toEqual(tasks);
  } finally {
    identityServer.offline(false);
    f.mac.close();
  }
});

test("account scope loss during local encryption rolls back admission and permits explicit retry after fresh sign-in context", async ({
  page,
  identityServer,
}) => {
  identityServer.enablePrivateRelay();
  const f = await ready(
    page,
    identityServer.pool,
    identityServer.nativeTransport,
  );
  try {
    const selected = await grant(page, f),
      incoming = await selected.offer.message("SYNTHETIC_LOST_SCOPE");
    const before = await snapshot(page);
    await page.evaluate(() => window.browserPeersTest.contentHoldEncryption());
    const pending = accept(page, selected.grant.id, incoming).then(
      () => "unexpected",
      () => "denied",
    );
    await page.waitForFunction(() => window.browserPeersTest.held());
    await page.evaluate(() => window.browserPeersTest.scopeChange());
    await page.evaluate(() => window.browserPeersTest.release());
    expect(await pending).toBe("denied");
    expect(await snapshot(page)).toEqual(before);
    await expect(list(page, selected.grant.id)).rejects.toThrow("DENIED");
    await page.reload();
    await page.waitForFunction(() => !!window.browserPeersTest);
    await page.evaluate(() => window.browserPeersTest.resume());
    expect((await accept(page, selected.grant.id, incoming)).duplicate).toBe(
      false,
    );
    expect((await accept(page, selected.grant.id, incoming)).duplicate).toBe(
      true,
    );
  } finally {
    f.mac.close();
  }
});

test("content shares the host operation lock and cancellation cannot publish pending preparation", async ({
  page,
  identityServer,
}) => {
  identityServer.enablePrivateRelay();
  const f = await ready(
    page,
    identityServer.pool,
    identityServer.nativeTransport,
  );
  try {
    const selected = await grant(page, f),
      before = await snapshot(page);
    await page.evaluate(() => window.browserPeersTest.contentHoldEncryption());
    const pending = prepare(page, selected.grant.id).then(
      () => "unexpected",
      () => "denied",
    );
    await page.waitForFunction(() => window.browserPeersTest.held());
    await expect(list(page, selected.grant.id)).rejects.toThrow("BUSY");
    await expect(
      page.evaluate(() => window.browserPeersTest.keyStatus()),
    ).rejects.toThrow("BUSY");
    await page.evaluate(() => window.browserPeersTest.invalidate());
    await page.evaluate(() => window.browserPeersTest.release());
    expect(await pending).toBe("denied");
    expect(await snapshot(page)).toEqual(before);
    expect(await list(page, selected.grant.id)).toEqual([]);
    await prepare(page, selected.grant.id);
    expect(await list(page, selected.grant.id)).toHaveLength(1);
  } finally {
    f.mac.close();
  }
});

test("revoked device keys deny conversation access but explicit verified-owner archive export retains history", async ({
  page,
  identityServer,
}) => {
  identityServer.enablePrivateRelay();
  const f = await ready(
    page,
    identityServer.pool,
    identityServer.nativeTransport,
  );
  try {
    const selected = await grant(page, f),
      incoming = await selected.offer.message("SYNTHETIC_OWNER_ARCHIVE");
    const accepted = await accept(page, selected.grant.id, incoming);
    await page.evaluate(
      (proof) =>
        window.browserPeersTest.hostKeyRevoke({
          keyId: proof.keyId,
          expectedRevision: proof.revision,
          confirmed: true,
        }),
      selected.grant.local,
    );
    await expect(list(page, selected.grant.id)).rejects.toThrow();
    await expect(read(page, accepted.entry)).rejects.toThrow();
    await expect(
      page.evaluate(() =>
        window.browserPeersTest.contentExport({ confirmed: false }),
      ),
    ).rejects.toThrow();
    const archive = await page.evaluate(() =>
      window.browserPeersTest.contentExport({ confirmed: true }),
    );
    expect(archive.items).toHaveLength(1);
    expect(archive.items[0]!.content.content).toBe("SYNTHETIC_OWNER_ARCHIVE");
    expect(JSON.stringify(archive)).not.toContain('"grant"');
    expect(JSON.stringify(archive)).not.toContain('"key"');
    await page.evaluate(() => window.browserPeersTest.logout());
    await expect(
      page.evaluate(() =>
        window.browserPeersTest.contentExport({ confirmed: true }),
      ),
    ).rejects.toThrow("DENIED");
    await expect(
      page.evaluate(() =>
        window.browserPeersTest.contentClear({
          expectedConsentRevision: 1,
          confirmed: true,
        }),
      ),
    ).rejects.toThrow("DENIED");
  } finally {
    f.mac.close();
  }
});

test("selected-grant listing excludes other conversations and refuses stale grants after revocation", async ({
  page,
  identityServer,
}) => {
  identityServer.enablePrivateRelay();
  const f = await ready(
    page,
    identityServer.pool,
    identityServer.nativeTransport,
  );
  try {
    const first = await grant(page, f),
      one = await prepare(page, first.grant.id);
    const second = await grant(page, f),
      two = await prepare(page, second.grant.id);
    expect(await list(page, first.grant.id)).toEqual([one]);
    expect(await list(page, second.grant.id)).toEqual([two]);
    await expect(list(page, randomUUID())).rejects.toThrow("DENIED");
    const status = await page.evaluate(() =>
      window.browserPeersTest.conversationStatus(),
    );
    await page.evaluate(
      (raw) => window.browserPeersTest.conversationRevoke(raw),
      {
        grantId: first.grant.id,
        expectedRevision: status.revision,
        confirmed: true,
      },
    );
    await expect(list(page, first.grant.id)).rejects.toThrow("DENIED");
    expect(await list(page, second.grant.id)).toEqual([two]);
    expect(
      (
        await page.evaluate(() =>
          window.browserPeersTest.contentExport({ confirmed: true }),
        )
      ).items,
    ).toHaveLength(2);
  } finally {
    f.mac.close();
  }
});

test("lost final identity responses retain committed preparation, original ciphertext and exactly-once acceptance for explicit reconciliation", async ({
  page,
  identityServer,
}) => {
  identityServer.enablePrivateRelay();
  const f = await ready(
    page,
    identityServer.pool,
    identityServer.nativeTransport,
  );
  try {
    const selected = await grant(page, f),
      request = { id: randomUUID(), expiresAt: Date.now() + 60000 };
    identityServer.reject("/browser/registration/identity", 1);
    await expect(prepare(page, selected.grant.id, request)).rejects.toThrow();
    const [pending] = await list(page, selected.grant.id);
    expect(pending).toMatchObject({
      id: request.id,
      state: "preparing",
      revision: 1,
    });
    const preparedSnapshot = await snapshot(page);
    expect(await prepare(page, selected.grant.id, request)).toEqual(pending);
    expect(await snapshot(page)).toEqual(preparedSnapshot);
    identityServer.reject("/browser/registration/identity", 1);
    await expect(wire(page, pending)).rejects.toThrow();
    const [sealed] = await list(page, selected.grant.id);
    expect(sealed).toMatchObject({
      id: request.id,
      state: "ready",
      revision: 2,
    });
    const envelope = await wire(page, sealed);
    expect(await wire(page, sealed)).toEqual(envelope);
    expect((await selected.offer.receive(envelope)).duplicate).toBe(false);
    const reply = await selected.offer.message(
      "SYNTHETIC_RECONCILED_REPLY",
      request.id,
    );
    identityServer.reject("/browser/registration/identity", 1);
    await expect(accept(page, selected.grant.id, reply)).rejects.toThrow();
    expect(await list(page, selected.grant.id)).toHaveLength(2);
    const admittedSnapshot = await snapshot(page);
    expect((await accept(page, selected.grant.id, reply)).duplicate).toBe(true);
    expect(await snapshot(page)).toEqual(admittedSnapshot);
  } finally {
    f.mac.close();
  }
});
