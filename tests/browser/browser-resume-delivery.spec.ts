import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { ready, reopen } from "./support/retained-browser-task.js";

test("browser retains its original resume request and reconciles one actual Mac transition after reload", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const offer = await f.mac.resumeOffer();
    const grant = await page.evaluate(
      async ({ envelope, peerId, peerKeyEpoch, expiresAt }) => {
        const api = window.browserPeersTest;
        const r = await api.resumePrepare({
          expectedRevision: 0,
          envelope,
          peerId,
          peerKeyEpoch,
          expiresAt,
        });
        return api.resumeApprove({
          reviewId: r.reviewId,
          expectedRevision: r.expectedRevision,
          confirmed: true,
          acknowledged: true,
        });
      },
      {
        envelope: offer.envelope,
        peerId: f.pin.peerId,
        peerKeyEpoch: f.pin.keyEpoch,
        expiresAt: f.f.now + 120000,
      },
    );
    const request = {
      grantId: grant.id,
      id: randomUUID(),
      expiresAt: f.f.now + 60000,
      confirmed: true,
    };
    const draft = await page.evaluate(
      (raw) => window.browserPeersTest.resumeDeliveryPrepare(raw),
      request,
    );
    expect(draft.state).toBe("preparing");
    expect(offer.task().status).toBe("paused");
    const envelope = await page.evaluate(
      (raw) => window.browserPeersTest.resumeDeliveryEnvelope(raw),
      {
        grantId: grant.id,
        id: request.id,
        expectedRevision: draft.revision,
        confirmed: true,
      },
    );
    const after = await page.evaluate(
      (raw) => window.browserPeersTest.resumeDeliveryRead(raw),
      { grantId: grant.id, id: request.id },
    );
    expect(after.state).toBe("ready");
    expect(after.revision).toBe(draft.revision + 1);
    await reopen(page, f.f);
    expect(
      await page.evaluate(
        (raw) => window.browserPeersTest.resumeDeliveryPrepare(raw),
        request,
      ),
    ).toEqual(after);
    const action = {
      grantId: grant.id,
      id: request.id,
      expectedRevision: after.revision,
      confirmed: true,
    };
    expect(
      await page.evaluate(
        (raw) => window.browserPeersTest.resumeDeliveryEnvelope(raw),
        action,
      ),
    ).toEqual(envelope);
    const delivered = await offer.receive(envelope);
    expect(delivered.result.duplicate).toBe(false);
    expect(offer.task().status).toBe("queued");
    expect(offer.task().revision).toBe(offer.data.taskRevision + 1);
    const duplicate = await offer.receive(envelope);
    expect(duplicate.result.duplicate).toBe(true);
    expect(duplicate.envelope).toEqual(delivered.envelope);
    const accepted = await page.evaluate(
      (raw) => window.browserPeersTest.resumeDeliveryReconcile(raw),
      { ...action, envelope: delivered.envelope },
    );
    expect(accepted.duplicate).toBe(false);
    expect(accepted.entry.receipt).toEqual(delivered.result.receipt);
    await reopen(page, f.f);
    expect(
      await page.evaluate(
        (raw) => window.browserPeersTest.resumeDeliveryReconcile(raw),
        {
          ...action,
          expectedRevision: accepted.entry.revision,
          envelope: delivered.envelope,
        },
      ),
    ).toEqual({ ...accepted, duplicate: true });
    await expect(
      page.evaluate(
        (raw) => window.browserPeersTest.resumeDeliveryPrepare(raw),
        { ...request, id: randomUUID() },
      ),
    ).rejects.toThrow("CONFLICT");
    expect(offer.task().revision).toBe(offer.data.taskRevision + 1);
  } finally {
    f.mac.close();
  }
});

async function prepared(page: Page) {
  const f = await ready(page);
  try {
    const offer = await f.mac.resumeOffer();
    const grant = await page.evaluate(
      async ({ envelope, peerId, peerKeyEpoch, expiresAt }) => {
        const api = window.browserPeersTest;
        const r = await api.resumePrepare({
          expectedRevision: 0,
          envelope,
          peerId,
          peerKeyEpoch,
          expiresAt,
        });
        return api.resumeApprove({
          reviewId: r.reviewId,
          expectedRevision: r.expectedRevision,
          confirmed: true,
          acknowledged: true,
        });
      },
      {
        envelope: offer.envelope,
        peerId: f.pin.peerId,
        peerKeyEpoch: f.pin.keyEpoch,
        expiresAt: f.f.now + 120000,
      },
    );
    const request = {
      grantId: grant.id,
      id: randomUUID(),
      expiresAt: f.f.now + 60000,
      confirmed: true,
    };
    const draft = await page.evaluate(
      (raw) => window.browserPeersTest.resumeDeliveryPrepare(raw),
      request,
    );

    return { f, offer, grant, request, draft };
  } catch (e) {
    f.mac.close();
    throw e;
  }
}

test("browser can stop, export and delete retained resume requests offline without restoring permission", async ({
  page,
}) => {
  const { f, offer, grant, request, draft } = await prepared(page);
  try {
    const action = {
      grantId: grant.id,
      id: request.id,
      expectedRevision: draft.revision,
      confirmed: true,
    };
    const consent = await page.evaluate(() =>
      window.browserPeersTest.resumeStatus(),
    );
    await page.evaluate(() => window.browserPeersTest.set(null));
    await page.context().setOffline(true);
    const stopped = await page.evaluate(
      (raw) => window.browserPeersTest.resumeDeliveryStop(raw),
      action,
    );
    expect(stopped.stopped).toBe(true);
    expect(stopped.revision).toBe(draft.revision + 1);
    await expect(
      page.evaluate(
        (raw) => window.browserPeersTest.resumeDeliveryStop(raw),
        action,
      ),
    ).rejects.toThrow("CONFLICT");
    expect(
      await page.evaluate(
        (raw) => window.browserPeersTest.resumeDeliveryStop(raw),
        { ...action, expectedRevision: stopped.revision },
      ),
    ).toEqual(stopped);
    const archive = await page.evaluate(() =>
      window.browserPeersTest.resumeDeliveryExport({ confirmed: true }),
    );
    expect(archive).toEqual({
      version: 1,
      restoreAuthority: false,
      items: [stopped],
    });
    expect(JSON.stringify(archive)).not.toContain("ciphertext");
    await expect(
      page.evaluate((raw) => window.browserPeersTest.resumeDeliveryClear(raw), {
        expectedConsentRevision: consent.revision + 1,
        confirmed: true,
      }),
    ).rejects.toThrow("CONFLICT");
    expect(
      await page.evaluate(() =>
        window.browserPeersTest.resumeDeliveryHistory(),
      ),
    ).toEqual([stopped]);
    const removed = await page.evaluate(
      (raw) => window.browserPeersTest.resumeDeliveryClear(raw),
      { expectedConsentRevision: consent.revision, confirmed: true },
    );
    expect(removed).toEqual({
      removed: 1,
      consentRevision: consent.revision + 1,
      needsFreshDevice: true,
    });
    expect(
      await page.evaluate(() =>
        window.browserPeersTest.resumeDeliveryHistory(),
      ),
    ).toEqual([]);
    await page.context().setOffline(false);
    await reopen(page, f.f);
    await expect(
      page.evaluate(
        (raw) => window.browserPeersTest.resumeDeliveryPrepare(raw),
        request,
      ),
    ).rejects.toThrow("DENIED");
    expect(offer.task().status).toBe("paused");
  } finally {
    await page.context().setOffline(false);
    f.mac.close();
  }
});

test("browser stop prevents new resume ciphertext but reconciles a previously delivered exact receipt", async ({
  page,
}) => {
  const { f, offer, grant, request, draft } = await prepared(page);
  try {
    const action = {
      grantId: grant.id,
      id: request.id,
      expectedRevision: draft.revision,
      confirmed: true,
    };
    const wire = await page.evaluate(
      (raw) => window.browserPeersTest.resumeDeliveryEnvelope(raw),
      action,
    );
    const stopped = await page.evaluate(
      (raw) => window.browserPeersTest.resumeDeliveryStop(raw),
      { ...action, expectedRevision: draft.revision + 1 },
    );
    const latest = { ...action, expectedRevision: stopped.revision };
    await expect(
      page.evaluate(
        (raw) => window.browserPeersTest.resumeDeliveryEnvelope(raw),
        latest,
      ),
    ).rejects.toThrow("DENIED");
    const delivered = await offer.receive(wire);
    const accepted = await page.evaluate(
      (raw) => window.browserPeersTest.resumeDeliveryReconcile(raw),
      { ...latest, envelope: delivered.envelope },
    );
    expect(accepted.entry.stopped).toBe(true);
    expect(accepted.entry.state).toBe("accepted");
    expect(accepted.entry.receipt).toEqual(delivered.result.receipt);
    const consent = await page.evaluate(() =>
      window.browserPeersTest.resumeStatus(),
    );
    await page.evaluate((raw) => window.browserPeersTest.resumeRevoke(raw), {
      grantId: grant.id,
      expectedRevision: consent.revision,
      confirmed: true,
    });
    expect(
      await page.evaluate(() =>
        window.browserPeersTest.resumeDeliveryHistory(),
      ),
    ).toEqual([accepted.entry]);
    await expect(
      page.evaluate(
        (raw) => window.browserPeersTest.resumeDeliveryReconcile(raw),
        {
          ...latest,
          expectedRevision: accepted.entry.revision,
          envelope: delivered.envelope,
        },
      ),
    ).rejects.toThrow("DENIED");
    expect(offer.task().revision).toBe(offer.data.taskRevision + 1);
  } finally {
    f.mac.close();
  }
});

test("resume receipt and deletion failures roll back their shared authority records", async ({
  page,
}) => {
  const { f, offer, grant, request, draft } = await prepared(page);
  try {
    const action = {
      grantId: grant.id,
      id: request.id,
      expectedRevision: draft.revision,
      confirmed: true,
    };
    const wire = await page.evaluate(
      (raw) => window.browserPeersTest.resumeDeliveryEnvelope(raw),
      action,
    );
    const delivered = await offer.receive(wire);
    const input = {
      ...action,
      expectedRevision: draft.revision + 1,
      envelope: delivered.envelope,
    };
    const before = await page.evaluate(() =>
      window.browserPeersTest.resumeDeliveryInspect(),
    );
    await page.evaluate(() =>
      window.browserPeersTest.resumeDeliveryFailWrite("put"),
    );
    await expect(
      page.evaluate(
        (raw) => window.browserPeersTest.resumeDeliveryReconcile(raw),
        input,
      ),
    ).rejects.toThrow("CAPACITY");
    expect(
      await page.evaluate(() =>
        window.browserPeersTest.resumeDeliveryInspect(),
      ),
    ).toEqual(before);
    const accepted = await page.evaluate(
      (raw) => window.browserPeersTest.resumeDeliveryReconcile(raw),
      input,
    );
    expect(accepted.duplicate).toBe(false);
    const retained = await page.evaluate(() =>
      window.browserPeersTest.resumeDeliveryInspect(),
    );
    const consent = await page.evaluate(() =>
      window.browserPeersTest.resumeStatus(),
    );
    await page.evaluate(() =>
      window.browserPeersTest.resumeDeliveryFailWrite("delete"),
    );
    await expect(
      page.evaluate((raw) => window.browserPeersTest.resumeDeliveryClear(raw), {
        expectedConsentRevision: consent.revision,
        confirmed: true,
      }),
    ).rejects.toThrow("CAPACITY");
    expect(
      await page.evaluate(() =>
        window.browserPeersTest.resumeDeliveryInspect(),
      ),
    ).toEqual(retained);
    expect(
      await page.evaluate(() => window.browserPeersTest.resumeStatus()),
    ).toEqual(consent);
  } finally {
    f.mac.close();
  }
});

test("a competing browser stop fences a held resume envelope write", async ({
  page,
  context,
}) => {
  const { f, offer, grant, request, draft } = await prepared(page);
  const other = await context.newPage();
  try {
    await reopen(other, f.f);
    const action = {
      grantId: grant.id,
      id: request.id,
      expectedRevision: draft.revision,
      confirmed: true,
    };
    await page.evaluate(() =>
      window.browserPeersTest.resumeDeliveryHoldEncryption(),
    );
    const late = page.evaluate(
      (raw) =>
        window.browserPeersTest.resumeDeliveryEnvelope(raw).then(
          () => "unexpected-success",
          (e: Error) => e.message,
        ),
      action,
    );
    await page.waitForFunction(() => window.browserPeersTest.held());
    const stopped = await other.evaluate(
      (raw) => window.browserPeersTest.resumeDeliveryStop(raw),
      action,
    );
    await page.evaluate(() => window.browserPeersTest.release());
    expect(await late).toBe("CONFLICT");
    expect(
      await page.evaluate(() =>
        window.browserPeersTest.resumeDeliveryHistory(),
      ),
    ).toEqual([stopped]);
    const stored = await page.evaluate(() =>
      window.browserPeersTest.resumeDeliveryInspect(),
    );
    expect(stored.count).toBe(1);
    expect(stored.exportDenied).toBe(true);
    expect(offer.task().status).toBe("paused");
  } finally {
    await page.evaluate(() => window.browserPeersTest.release());
    await other.close();
    f.mac.close();
  }
});

test("corrupt resume history fails closed and explicit deletion retains replay fences", async ({
  page,
}) => {
  const { f, offer } = await prepared(page);
  try {
    const consent = await page.evaluate(() =>
      window.browserPeersTest.resumeStatus(),
    );
    const before = await page.evaluate(() =>
      window.browserPeersTest.resumeDeliveryInspect(),
    );
    await page.evaluate(() =>
      window.browserPeersTest.resumeDeliveryInspect("corrupt"),
    );
    await expect(
      page.evaluate(() => window.browserPeersTest.resumeDeliveryHistory()),
    ).rejects.toThrow("STORAGE_UNAVAILABLE");
    await expect(
      page.evaluate(() =>
        window.browserPeersTest.resumeDeliveryExport({ confirmed: true }),
      ),
    ).rejects.toThrow("STORAGE_UNAVAILABLE");
    const deleted = await page.evaluate(
      (raw) => window.browserPeersTest.resumeDeliveryClear(raw),
      { expectedConsentRevision: consent.revision, confirmed: true },
    );
    expect(deleted.removed).toBe(1);
    const after = await page.evaluate(() =>
      window.browserPeersTest.resumeDeliveryInspect(),
    );
    expect(after.count).toBe(0);
    expect(after.ledger).toBe(before.ledger);
    expect(after.channels).toBe(before.channels);
    expect(offer.task().status).toBe("paused");
  } finally {
    f.mac.close();
  }
});
