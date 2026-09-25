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
type Fixture = Awaited<ReturnType<typeof paired>>;
const offerSequences = new WeakMap<Fixture, number>();
async function offer(f: Fixture, patch: any = {}, headerPatch: any = {}) {
  const sequence = (offerSequences.get(f) ?? 100) + 1;
  offerSequences.set(f, sequence);
  const data = {
    version: 1,
    type: "task.resume.offer",
    taskId: randomUUID(),
    permissionId: randomUUID(),
    taskRevision: 1,
    modelDigest: "a".repeat(64),
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
  const s = await page.evaluate(() => window.browserPeersTest.resumeStatus());
  return page.evaluate((raw) => window.browserPeersTest.resumePrepare(raw), {
    expectedRevision: s.revision,
    peerId: f.pin.peerId,
    peerKeyEpoch: f.pin.keyEpoch,
    envelope: o.envelope,
    expiresAt: f.f.now + 240000,
    ...patch,
  });
}
const approve = (page: Page, r: any) =>
  page.evaluate(
    (r) =>
      window.browserPeersTest.resumeApprove({
        reviewId: r.reviewId,
        expectedRevision: r.expectedRevision,
        confirmed: true,
        acknowledged: true,
      }),
    r,
  );
const task = (g: any) => ({
  permissionId: g.choices.permissionId,
  taskId: g.choices.taskId,
  taskRevision: g.choices.taskRevision,
  modelDigest: g.choices.modelDigest,
});
const authorize = (page: Page, g: any, patch: any = {}) =>
  page.evaluate(
    ({ id, value }) => window.browserPeersTest.resumeAuthorize(id, value),
    { id: g.id, value: { ...task(g), ...patch } },
  );
test.beforeEach(async ({ context }) => {
  await context.route("**/*", (r) =>
    new URL(r.request().url()).origin === "http://127.0.0.1:44137"
      ? r.continue()
      : r.abort(),
  );
});

test("resume inspection writes no authority and approval binds exact task and model", async ({
  page,
}) => {
  const f = await paired(page);
  try {
    const o = await offer(f);
    await expect(prepare(page, f, o)).rejects.toThrow("DENIED");
    await f.proveBrowser();
    await f.proveMac();
    const before = await page.evaluate(() =>
      window.browserPeersTest.resumeRows(),
    );
    const inspected = await page.evaluate(
      (raw) => window.browserPeersTest.resumeInspect(raw),
      {
        expectedRevision: 0,
        peerId: f.pin.peerId,
        peerKeyEpoch: f.pin.keyEpoch,
        envelope: o.envelope,
      },
    );
    expect(inspected.offer).toEqual(o.data);
    expect(
      await page.evaluate(() => window.browserPeersTest.resumeRows()),
    ).toEqual(before);
    const tampered = structuredClone(o);
    tampered.envelope.header.messageId = randomUUID();
    await expect(prepare(page, f, tampered)).rejects.toThrow();
    await expect(
      prepare(page, f, o, { expiresAt: f.f.now + 300001 }),
    ).rejects.toThrow("DENIED");
    const r = await prepare(page, f, o);
    expect(
      await page.evaluate(() => window.browserPeersTest.resumeRows()),
    ).toEqual(before);
    r.choices.modelDigest = "b".repeat(64);
    const g = await approve(page, r);
    expect(g.choices.modelDigest).toBe("a".repeat(64));
    await expect(approve(page, r)).rejects.toThrow("CONFLICT");
    await authorize(page, g);
    expect(await page.evaluate(() => window.browserPeersTest.resumeUse())).toBe(
      true,
    );
    for (const patch of [
      { taskId: randomUUID() },
      { taskRevision: 2 },
      { modelDigest: "b".repeat(64) },
      { permissionId: randomUUID() },
    ])
      await expect(authorize(page, g, patch)).rejects.toThrow("DENIED");
    const stored = await page.evaluate(() =>
      window.browserPeersTest.resumeRows(),
    );
    expect(stored.rows).not.toContain(o.data.taskId);
    expect(stored.rows).not.toContain(o.data.modelDigest);
    expect(
      stored.replay.filter((r: any) => r.type === "task.resume.offer"),
    ).toHaveLength(1);
    await reopen(page, f.f);
    expect(
      (await page.evaluate(() => window.browserPeersTest.resumeStatus()))
        .grants,
    ).toEqual([g]);
  } finally {
    f.mac.close();
  }
});

test("resume approval rolls back replay on failed storage and rejects changed original ciphertext", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const o = await offer(f),
      r = await prepare(page, f, o);
    const before = await page.evaluate(() =>
      window.browserPeersTest.resumeRows(),
    );
    await page.evaluate(() => window.browserPeersTest.resumeFailWrite());
    await expect(approve(page, r)).rejects.toThrow("CAPACITY");
    expect(
      await page.evaluate(() => window.browserPeersTest.resumeRows()),
    ).toEqual(before);
    const g = await approve(page, await prepare(page, f, o));
    const ledger = (
      await page.evaluate(() => window.browserPeersTest.resumeRows())
    ).replay;
    await approve(page, await prepare(page, f, o));
    expect(
      (await page.evaluate(() => window.browserPeersTest.resumeRows())).replay,
    ).toEqual(ledger);
    await expect(authorize(page, g)).rejects.toThrow("DENIED");
    const changed = await offer(f, o.data, {
      messageId: o.envelope.header.messageId,
      operationId: o.envelope.header.operationId,
      sequence: o.envelope.header.sequence,
    });
    await expect(
      approve(page, await prepare(page, f, changed)),
    ).rejects.toThrow("CONFLICT");
    expect(
      (await page.evaluate(() => window.browserPeersTest.resumeRows())).replay,
    ).toEqual(ledger);
  } finally {
    f.mac.close();
  }
});

test("resume revocation and clearing invalidate retained access without resetting replay", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const o = await offer(f),
      g = await approve(page, await prepare(page, f, o));
    await authorize(page, g);
    const ledger = (
      await page.evaluate(() => window.browserPeersTest.resumeRows())
    ).replay;
    await page.evaluate((raw) => window.browserPeersTest.resumeRevoke(raw), {
      grantId: g.id,
      expectedRevision: g.revision,
      confirmed: true,
    });
    await expect(
      page.evaluate(() => window.browserPeersTest.resumeUse()),
    ).rejects.toThrow("DENIED");
    await expect(authorize(page, g)).rejects.toThrow("DENIED");
    const s = await page.evaluate(() => window.browserPeersTest.resumeStatus());
    await page.evaluate((raw) => window.browserPeersTest.resumeClear(raw), {
      expectedRevision: s.revision,
      confirmed: true,
    });
    expect(
      (await page.evaluate(() => window.browserPeersTest.resumeStatus()))
        .needsFreshDevice,
    ).toBe(true);
    await expect(prepare(page, f, o)).rejects.toThrow("REPAIR_REQUIRED");
    expect(
      (await page.evaluate(() => window.browserPeersTest.resumeRows())).replay,
    ).toEqual(ledger);
  } finally {
    f.mac.close();
  }
});

test("resume reviews reject invalidation and monotonic expiry before any consent commit", async ({
  page,
}) => {
  const f = await ready(page);
  try {
    const o = await offer(f),
      r = await prepare(page, f, o);
    await page.evaluate(() => window.browserPeersTest.invalidate());
    await expect(approve(page, r)).rejects.toThrow("CONFLICT");
    const next = await prepare(page, f, o);
    await page.evaluate(
      (wall) => window.browserPeersTest.time(wall, 120001),
      f.f.now,
    );
    await expect(approve(page, next)).rejects.toThrow("DENIED");
    expect(
      (await page.evaluate(() => window.browserPeersTest.resumeStatus()))
        .grants,
    ).toEqual([]);
  } finally {
    f.mac.close();
  }
});
