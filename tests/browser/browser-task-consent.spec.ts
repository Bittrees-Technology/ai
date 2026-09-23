import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { retainedMac } from "./support/retained-mac.js";
const payload = {
  version: 1,
  type: "task.submit",
  kind: "query",
  prompt: "SYNTHETIC_RETAINED_BROWSER_TASK",
};
const confirmed = (id: string) => ({ id, confirmed: true });
async function init(page: Page, previous = false) {
  const f = {
    owner: "synthetic:" + randomUUID(),
    binding: {
      ownerId: randomUUID(),
      deviceId: randomUUID(),
      credentialEpoch: 1,
      expiresAt: Date.now() + 3600000,
    },
    now: Date.now(),
  };
  await reopen(page, f, previous);
  await page.evaluate(() => window.browserPeersTest.activate());
  return f;
}
async function reopen(
  page: Page,
  f: { owner: string; binding: any; now: number },
  previous = false,
) {
  await page.goto("/?browser-peers");
  await page.waitForFunction(() => !!window.browserPeersTest);
  await page.evaluate(
    ({ f, previous }) =>
      window.browserPeersTest.init(f.owner, f.binding, f.now, previous),
    { f, previous },
  );
}
async function paired(page: Page, previous = false) {
  const f = await init(page, previous),
    mac = await retainedMac(f.binding, f.now);
  try {
    const i = await mac.invitation();
    const r = await page.evaluate(
      (i) => window.browserPeersTest.prepare(i),
      i.invitation,
    );
    const pin = await page.evaluate(
      (r) =>
        window.browserPeersTest.approve({
          reviewId: r.reviewId,
          expectedRevision: r.expectedRevision,
          comparedFingerprint: r.fingerprint,
          confirmed: true,
        }),
      r,
    );
    const outgoing = await page.evaluate(
      (id) =>
        window.browserPeersTest.invitation({
          recipientId: id,
          confirmed: true,
        }),
      mac.binding.deviceId,
    );
    const mr = await mac.peers.prepare(outgoing.invitation);
    mac.peers.approve({
      reviewId: mr.reviewId,
      expectedRevision: mr.expectedRevision,
      comparedFingerprint: outgoing.fingerprint,
      confirmed: true,
    });
    const local = (await page.evaluate(() => window.browserPeersTest.key()))
      .proof;
    const proveBrowser = async () => {
      const c = await page.evaluate(
        (p) =>
          window.browserPeersTest.checkBegin({
            peerId: p.id,
            expectedKeyRevision: p.key,
            expectedPeerRevision: p.peer,
            confirmed: true,
          }),
        { id: pin.peerId, key: local.revision, peer: pin.revision },
      );
      const wire = await page.evaluate(
        (c) => window.browserPeersTest.checkEnvelope(c),
        confirmed(c.id),
      );
      const a = await mac.checks.respond({ envelope: wire, confirmed: true });
      const reply = await mac.checks.delivery(confirmed(a.id));
      await page.evaluate(
        (envelope) =>
          window.browserPeersTest.checkComplete({ envelope, confirmed: true }),
        reply,
      );
    };
    const proveMac = async () => {
      const c = await mac.checks.begin({
        peerId: f.binding.deviceId,
        expectedKeyRevision: mac.keys.list().revision,
        expectedPeerRevision: mac.peers.list().revision,
        confirmed: true,
      });
      const wire = await mac.checks.delivery(confirmed(c.id));
      const a = await page.evaluate(
        (envelope) =>
          window.browserPeersTest.checkRespond({ envelope, confirmed: true }),
        wire,
      );
      const reply = await page.evaluate(
        (c) => window.browserPeersTest.checkEnvelope(c),
        confirmed(a.id),
      );
      await mac.checks.complete({ envelope: reply, confirmed: true });
    };
    const choices = {
      peerId: pin.peerId,
      peerKeyEpoch: pin.keyEpoch,
      sendTasks: true,
      receiveResults: true,
      expiresAt: f.now + 300000,
    };
    const prepare = async (override = {}) => {
      const state = await page.evaluate(() =>
        window.browserPeersTest.consentStatus(),
      );
      return page.evaluate(
        (input) => window.browserPeersTest.consentPrepare(input),
        {
          expectedRevision: state.revision,
          choices: { ...choices, ...override },
        },
      );
    };
    const approve = (r: Awaited<ReturnType<typeof prepare>>) =>
      page.evaluate(
        (r) =>
          window.browserPeersTest.consentApprove({
            reviewId: r.reviewId,
            expectedRevision: r.expectedRevision,
            confirmed: true,
            acknowledged: true,
          }),
        r,
      );
    const authorize = () =>
      page.evaluate(
        (p) => window.browserPeersTest.authorize(p.peerId, p.keyEpoch),
        pin,
      );
    return {
      f,
      mac,
      pin,
      local,
      proveBrowser,
      proveMac,
      prepare,
      approve,
      authorize,
    };
  } catch (e) {
    mac.close();
    throw e;
  }
}
async function ready(page: Page) {
  const f = await paired(page);
  try {
    await f.proveBrowser();
    await f.proveMac();
    await f.mac.allowTasks(f.f.binding.deviceId, f.local.keyEpoch);
    await f.approve(await f.prepare());
    await f.authorize();
    await page.evaluate(() =>
      window.browserPeersTest.taskInitialize({
        expectedRevision: 0,
        confirmed: true,
      }),
    );
    return f;
  } catch (e) {
    f.mac.close();
    throw e;
  }
}
test.beforeEach(async ({ context }) => {
  await context.route("**/*", (r) =>
    new URL(r.request().url()).origin === "http://127.0.0.1:44137"
      ? r.continue()
      : r.abort(),
  );
});
test("retained browser choices require independent completed proof and one-use original review", async ({
  page,
}) => {
  const f = await paired(page);
  try {
    await expect(f.prepare()).rejects.toThrow("DENIED");
    await f.proveMac();
    await expect(f.prepare()).rejects.toThrow("DENIED");
    await f.proveBrowser();
    await expect(f.prepare({ sendTasks: false })).rejects.toThrow("DENIED");
    await expect(
      f.prepare({ modelProfileId: "remote-selected" }),
    ).rejects.toThrow("DENIED");
    await expect(f.prepare({ expiresAt: f.f.now + 90000000 })).rejects.toThrow(
      "DENIED",
    );
    const r = await f.prepare({ receiveResults: false });
    await expect(
      page.evaluate(
        (r) =>
          window.browserPeersTest.consentApprove({
            reviewId: r.reviewId,
            expectedRevision: r.expectedRevision,
            confirmed: true,
            acknowledged: false,
          }),
        r,
      ),
    ).rejects.toThrow("DENIED");
    await expect(f.approve(r)).rejects.toThrow("CONFLICT");
    const original = await f.prepare({ receiveResults: false });
    original.choices.receiveResults = true;
    original.local.binding.ownerId = randomUUID();
    const saved = await f.approve(original);
    expect(saved.choices.receiveResults).toBe(false);
    expect(saved.local.binding.ownerId).toBe(f.f.binding.ownerId);
    await expect(f.approve(original)).rejects.toThrow("CONFLICT");
    const stored = await page.evaluate(() =>
      window.browserPeersTest.inspectConsent(),
    );
    expect(stored.exportDenied).toBe(true);
    expect(stored.json).not.toContain(f.pin.peerId);
    expect(stored.json).not.toMatch(/receiveResults|sendTasks|approvedAt/);
  } finally {
    f.mac.close();
  }
});
test("real retained browser permissions drive Mac consent, task execution, receipts and result read across reload", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const created = await page.evaluate(
        (payload) => window.browserPeersTest.taskCreate(payload),
        payload,
      ),
      wire = await page.evaluate(
        (id) => window.browserPeersTest.taskDelivery(id),
        created.id,
      );
    expect(created.context.permissionId).toBeTruthy();
    expect(wire.header.sequence).toBeGreaterThan(1);
    const result = await f.mac.executeTask(wire);
    expect(result.task.input.modelProfileId).toBe("synthetic-browser-tasks");
    expect(result.task.input.sourceRefs).toEqual([]);
    expect(result.task.input.memoryIds).toBeUndefined();
    await page.evaluate(
      (envelope) => window.browserPeersTest.taskReceipt(envelope),
      result.acceptance,
    );
    const received = await page.evaluate(
      (envelope) => window.browserPeersTest.taskResult(envelope),
      result.result,
    );
    const again = await page.evaluate(
      (envelope) => window.browserPeersTest.taskResult(envelope),
      result.result,
    );
    expect(again).toEqual(received);
    const read = await page.evaluate(
      (r) =>
        window.browserPeersTest.taskRead({
          id: r.id,
          expectedRevision: r.revision,
          confirmed: true,
        }),
      received,
    );
    expect(read.task.output).toBe(
      "Synthetic result from independently consented Mac task.",
    );
    await reopen(page, f.f);
    await f.authorize();
    const reopened = await page.evaluate(
      (r) =>
        window.browserPeersTest.taskRead({
          id: r.id,
          expectedRevision: r.revision,
          confirmed: true,
        }),
      received,
    );
    expect(reopened).toEqual(read);
    expect(
      (await page.evaluate(() => window.browserPeersTest.taskExport()))
        .entries[0]?.envelope,
    ).toEqual(wire);
  } finally {
    f.mac.close();
  }
});
test("result reading is separate and a new permission cannot release an older task result", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    await f.approve(await f.prepare({ receiveResults: false }));
    await f.authorize();
    const task = await page.evaluate(
      (payload) => window.browserPeersTest.taskCreate(payload),
      payload,
    );
    const result = await f.mac.executeTask(task.envelope);
    await page.evaluate(
      (wire) => window.browserPeersTest.taskReceipt(wire),
      result.acceptance,
    );
    await expect(
      page.evaluate(
        (wire) => window.browserPeersTest.taskResult(wire),
        result.result,
      ),
    ).rejects.toThrow("DENIED");
    await f.approve(await f.prepare({ receiveResults: true }));
    await f.authorize();
    await expect(
      page.evaluate(
        (wire) => window.browserPeersTest.taskResult(wire),
        result.result,
      ),
    ).rejects.toThrow("DENIED");
    await expect(
      page.evaluate((id) => window.browserPeersTest.taskDelivery(id), task.id),
    ).rejects.toThrow("DENIED");
  } finally {
    f.mac.close();
  }
});
for (const action of ["consent", "key", "peer", "check"] as const)
  test(`cross-tab ${action} revocation during task encryption prevents guarded publication`, async ({
    page,
    context,
  }) => {
    const f = await ready(page),
      other = await context.newPage();
    try {
      await reopen(other, f.f);
      await page.evaluate(() => window.browserPeersTest.holdEncryption(0));
      const pending = page
        .evaluate(
          (payload) => window.browserPeersTest.taskCreate(payload),
          payload,
        )
        .then(
          (v) => ({ value: v }),
          (e) => ({ error: String(e) }),
        );
      await expect
        .poll(() => page.evaluate(() => window.browserPeersTest.held()))
        .toBe(true);
      if (action === "consent") {
        const s = await other.evaluate(() =>
          window.browserPeersTest.consentStatus(),
        );
        await other.evaluate((r) => window.browserPeersTest.consentRevoke(r), {
          peerId: f.pin.peerId,
          expectedRevision: s.revision,
          confirmed: true,
        });
      }
      if (action === "key")
        await other.evaluate((r) => window.browserPeersTest.keyRevoke(r), {
          keyId: f.local.keyId,
          expectedRevision: f.local.revision,
          confirmed: true,
        });
      if (action === "peer")
        await other.evaluate((r) => window.browserPeersTest.revoke(r), {
          peerId: f.pin.peerId,
          expectedRevision: f.pin.revision,
          confirmed: true,
        });
      if (action === "check") {
        const s = await other.evaluate(() =>
          window.browserPeersTest.checkStatus(),
        );
        await other.evaluate((r) => window.browserPeersTest.checkClear(r), {
          expectedRevision: s.revision,
          confirmed: true,
        });
      }
      await page.evaluate(() => window.browserPeersTest.release());
      expect(await pending).toMatchObject({
        error: expect.stringMatching(/DENIED|CONFLICT/),
      });
      await expect(
        page.evaluate(
          (payload) => window.browserPeersTest.taskCreate(payload),
          payload,
        ),
      ).rejects.toThrow(/DENIED|CONFLICT/);
    } finally {
      await other.close();
      f.mac.close();
    }
  });
test("concurrent permission reviews conflict and old sender providers fail after replacement", async ({
  page,
  context,
}) => {
  const f = await ready(page),
    other = await context.newPage();
  try {
    const review = await f.prepare();
    await reopen(other, f.f);
    const otherReview = await other.evaluate(
      (choices) =>
        window.browserPeersTest.consentPrepare({
          expectedRevision: 1,
          choices,
        }),
      review.choices,
    );
    await other.evaluate(
      (r) =>
        window.browserPeersTest.consentApprove({
          reviewId: r.reviewId,
          expectedRevision: r.expectedRevision,
          confirmed: true,
          acknowledged: true,
        }),
      otherReview,
    );
    await expect(f.approve(review)).rejects.toThrow("CONFLICT");
    await expect(
      page.evaluate(
        (payload) => window.browserPeersTest.taskCreate(payload),
        payload,
      ),
    ).rejects.toThrow("DENIED");
    await f.authorize();
    expect(
      (
        await page.evaluate(
          (payload) => window.browserPeersTest.taskCreate(payload),
          payload,
        )
      ).state,
    ).toBe("pending");
  } finally {
    await other.close();
    f.mac.close();
  }
});
for (const action of ["wall", "monotonic", "scope"] as const)
  test(`permission review and sender reject ${action} changes`, async ({
    page,
  }) => {
    const f = await ready(page);
    try {
      const review = await f.prepare();
      if (action === "wall")
        await page.evaluate(
          (n) => window.browserPeersTest.time(n, 1),
          f.f.now - 1,
        );
      if (action === "monotonic")
        await page.evaluate(
          (n) => window.browserPeersTest.time(n, 120001),
          f.f.now,
        );
      if (action === "scope")
        await page.evaluate(() => window.browserPeersTest.set(null));
      await expect(f.approve(review)).rejects.toThrow(/DENIED|CONFLICT/);
      await expect(
        page.evaluate(
          (payload) => window.browserPeersTest.taskCreate(payload),
          payload,
        ),
      ).rejects.toThrow(/DENIED|CONFLICT/);
    } finally {
      f.mac.close();
    }
  });
test("offline permission deletion removes encrypted choices and requires a different browser identity", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    await page.evaluate(() => window.browserPeersTest.set(null));
    const state = await page.evaluate(() =>
      window.browserPeersTest.consentStatus(),
    );
    await page.evaluate((r) => window.browserPeersTest.consentClear(r), {
      expectedRevision: state.revision,
      confirmed: true,
    });
    const deleted = await page.evaluate(() =>
      window.browserPeersTest.consentStatus(),
    );
    expect(deleted.grants).toEqual([]);
    expect(deleted.needsFreshDevice).toBe(true);
    const raw = JSON.parse(
      (await page.evaluate(() => window.browserPeersTest.inspectConsent()))
        .json,
    )[0];
    expect(raw.key).toBeNull();
    expect(raw.ciphertext).toBeNull();
    await page.evaluate((b) => window.browserPeersTest.set(b), f.f.binding);
    await expect(
      page.evaluate((r) => window.browserPeersTest.consentReset(r), {
        expectedRevision: deleted.revision,
        confirmed: true,
      }),
    ).rejects.toThrow("REPAIR_REQUIRED");
    await expect(f.prepare()).rejects.toThrow("REPAIR_REQUIRED");
    const next = {
      ...f.f,
      binding: { ...f.f.binding, deviceId: randomUUID() },
    };
    await reopen(page, next);
    const keyState = await page.evaluate(() =>
      window.browserPeersTest.keyStatus(),
    );
    await page.evaluate(
      (expectedRevision) =>
        window.browserPeersTest.keyReset({ expectedRevision, confirmed: true }),
      keyState.revision,
    );
    await page.evaluate(() => window.browserPeersTest.activate());
    await page.evaluate(
      (expectedRevision) =>
        window.browserPeersTest.consentReset({
          expectedRevision,
          confirmed: true,
        }),
      deleted.revision,
    );
    const fresh = await page.evaluate(() =>
      window.browserPeersTest.consentStatus(),
    );
    expect(fresh.needsFreshDevice).toBe(false);
    expect(fresh.grants).toEqual([]);
    expect(fresh.revision).toBe(deleted.revision + 1);
    await expect(f.authorize()).rejects.toThrow();
  } finally {
    f.mac.close();
  }
});
test("missing permission storage cannot recreate the identity of an older task grant", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const task = await page.evaluate(
      (payload) => window.browserPeersTest.taskCreate(payload),
      payload,
    );
    await page.evaluate(() => window.browserPeersTest.dropConsentRow());
    await expect(
      page.evaluate((id) => window.browserPeersTest.taskDelivery(id), task.id),
    ).rejects.toThrow("DENIED");
    const newGrant = await f.approve(await f.prepare());
    expect(newGrant.revision).toBe(task.context.permissionRevision);
    expect(newGrant.id).not.toBe(task.context.permissionId);
    await f.authorize();
    await expect(
      page.evaluate((id) => window.browserPeersTest.taskDelivery(id), task.id),
    ).rejects.toThrow("DENIED");
  } finally {
    f.mac.close();
  }
});
test("actual prior version4 retains keys, reciprocal proofs and original task ciphertext on upgrade without granting old tasks permission", async ({
  page,
}) => {
  const f = await paired(page, true);
  try {
    await f.proveBrowser();
    await f.proveMac();
    const old = await page.evaluate(
      (p) => window.browserPeersTest.seedPreviousTask(p.peerId, p.keyEpoch),
      f.pin,
    );
    await reopen(page, f.f);
    expect(
      (await page.evaluate(() => window.browserPeersTest.key())).proof,
    ).toEqual(f.local);
    expect(
      (await page.evaluate(() => window.browserPeersTest.checkStatus())).checks,
    ).toHaveLength(2);
    expect(
      (await page.evaluate(() => window.browserPeersTest.consentStatus()))
        .grants,
    ).toEqual([]);
    await f.approve(await f.prepare());
    await f.authorize();
    expect(
      (await page.evaluate(() => window.browserPeersTest.taskExport())).entries,
    ).toEqual([old]);
    await expect(
      page.evaluate((id) => window.browserPeersTest.taskDelivery(id), old.id),
    ).rejects.toThrow("DENIED");
    const fresh = await page.evaluate(
      (payload) => window.browserPeersTest.taskCreate(payload),
      payload,
    );
    expect(fresh.header.sequence).toBeGreaterThan(old.header.sequence);
    await expect(reopen(page, f.f, true)).rejects.toThrow(
      "STORAGE_UNAVAILABLE",
    );
  } finally {
    f.mac.close();
  }
});

test("a failed common-storage upgrade preserves the actual previous provider and task ciphertext", async ({
  page,
}) => {
  const f = await paired(page, true);
  try {
    await f.proveBrowser();
    const old = await page.evaluate(
      (p) => window.browserPeersTest.seedPreviousTask(p.peerId, p.keyEpoch),
      f.pin,
    );
    await page.evaluate(() => {
      const original = IDBDatabase.prototype.createObjectStore;
      IDBDatabase.prototype.createObjectStore = function (
        ...args: Parameters<IDBDatabase["createObjectStore"]>
      ) {
        if (args[0] === "task_consents") {
          IDBDatabase.prototype.createObjectStore = original;
          throw new DOMException(
            "synthetic failed upgrade",
            "QuotaExceededError",
          );
        }
        return original.apply(this, args);
      };
    });
    await expect(
      page.evaluate(
        (f) => window.browserPeersTest.init(f.owner, f.binding, f.now),
        f.f,
      ),
    ).rejects.toThrow("STORAGE_UNAVAILABLE");
    await reopen(page, f.f, true);
    expect(
      (await page.evaluate(() => window.browserPeersTest.key())).proof,
    ).toEqual(f.local);
    expect(
      (await page.evaluate(() => window.browserPeersTest.checkStatus()))
        .checks[0]!.state,
    ).toBe("verified");
    await reopen(page, f.f);
    await f.approve(await f.prepare());
    await f.authorize();
    expect(
      (await page.evaluate(() => window.browserPeersTest.taskExport())).entries,
    ).toEqual([old]);
  } finally {
    f.mac.close();
  }
});
test("permission quota failure rolls back approval and consumes its review", async ({
  page,
}) => {
  const f = await paired(page);
  try {
    await f.proveBrowser();
    const r = await f.prepare();
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        ...args: Parameters<IDBObjectStore["put"]>
      ) {
        if (this.name === "task_consents") {
          IDBObjectStore.prototype.put = original;
          throw new DOMException(
            "synthetic consent quota",
            "QuotaExceededError",
          );
        }
        return original.apply(this, args);
      };
    });
    await expect(f.approve(r)).rejects.toThrow("CAPACITY");
    expect(
      (await page.evaluate(() => window.browserPeersTest.consentStatus()))
        .revision,
    ).toBe(0);
    await expect(f.approve(r)).rejects.toThrow("CONFLICT");
    expect((await f.approve(await f.prepare())).revision).toBe(1);
  } finally {
    f.mac.close();
  }
});
test("Mac revocation independently denies a browser-authorized encrypted task", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const task = await page.evaluate(
      (p) => window.browserPeersTest.taskCreate(p),
      payload,
    );
    f.mac.consent.revoke({
      peerId: f.f.binding.deviceId,
      expectedRevision: f.mac.consent.list().revision,
      confirmed: true,
    });
    await expect(f.mac.executeTask(task.envelope)).rejects.toThrow("DENIED");
    expect(
      (await page.evaluate(() => window.browserPeersTest.consentStatus()))
        .grants[0]!.revoked,
    ).toBe(false);
  } finally {
    f.mac.close();
  }
});
test("cross-tab permission revocation denies disclosure after result decryption", async ({
  page,
  context,
}) => {
  const f = await ready(page),
    other = await context.newPage();
  try {
    const task = await page.evaluate(
      (p) => window.browserPeersTest.taskCreate(p),
      payload,
    );
    const result = await f.mac.executeTask(task.envelope);
    await page.evaluate(
      (e) => window.browserPeersTest.taskReceipt(e),
      result.acceptance,
    );
    const received = await page.evaluate(
      (e) => window.browserPeersTest.taskResult(e),
      result.result,
    );
    await reopen(other, f.f);
    await page.evaluate(() => {
      const original = crypto.subtle.decrypt.bind(crypto.subtle);
      let release: () => void;
      const gate = new Promise<void>((r) => (release = r));
      (window as any).consentDecryptHeld = false;
      (window as any).releaseConsentDecrypt = () => release();
      crypto.subtle.decrypt = (async (
        ...args: Parameters<SubtleCrypto["decrypt"]>
      ) => {
        crypto.subtle.decrypt = original;
        const result = await original(...args);
        (window as any).consentDecryptHeld = true;
        await gate;
        return result;
      }) as SubtleCrypto["decrypt"];
    });
    const pending = page
      .evaluate(
        (r) =>
          window.browserPeersTest.taskRead({
            id: r.id,
            expectedRevision: r.revision,
            confirmed: true,
          }),
        received,
      )
      .then(
        (v) => ({ value: v }),
        (e) => ({ error: String(e) }),
      );
    await expect
      .poll(() => page.evaluate(() => (window as any).consentDecryptHeld))
      .toBe(true);
    const state = await other.evaluate(() =>
      window.browserPeersTest.consentStatus(),
    );
    await other.evaluate((r) => window.browserPeersTest.consentRevoke(r), {
      peerId: f.pin.peerId,
      expectedRevision: state.revision,
      confirmed: true,
    });
    await page.evaluate(() => (window as any).releaseConsentDecrypt());
    expect(await pending).toMatchObject({
      error: expect.stringMatching(/DENIED|CONFLICT/),
    });
  } finally {
    await other.close();
    f.mac.close();
  }
});
