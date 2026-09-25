import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { ready, reopen } from "./support/retained-browser-task.js";
import {
  sealPrivateEnvelope,
  openPrivateEnvelope,
  privateEnvelopeSuite,
} from "../../modules/remote/private-envelope.js";

async function setup(
  page: Page,
  previous:
    | false
    | "content"
    | "receipts"
    | "relay-content"
    | "key-boundary"
    | "resume"
    | "resume-delivery" = false,
  questions = false,
) {
  const f = await ready(page, previous);
  try {
    const offer = await f.mac.conversationOffer(undefined, { questions });
    const grant = await page.evaluate(
      async ({ offer, pin, now }) => {
        const api = window.browserPeersTest;
        const status = await api.conversationStatus();
        const review = await api.conversationPrepare({
          expectedRevision: status.revision,
          peerId: pin.peerId,
          peerKeyEpoch: pin.keyEpoch,
          envelope: offer.envelope,
          permissions: offer.data.permissions,
          expiresAt: now + 240000,
        });
        return api.conversationApprove({
          reviewId: review.reviewId,
          expectedRevision: review.expectedRevision,
          confirmed: true,
          acknowledged: true,
        });
      },
      {
        offer: { envelope: offer.envelope, data: offer.data },
        pin: f.pin,
        now: f.f.now,
      },
    );
    return { ...f, offer, grant };
  } catch (e) {
    f.mac.close();
    throw e;
  }
}
type Fixture = Awaited<ReturnType<typeof setup>>;
const inspect = (page: Page) =>
  page.evaluate(() => window.browserPeersTest.contentInspect());
const prepare = (page: Page, f: Fixture, patch: Record<string, unknown> = {}) =>
  page.evaluate((raw) => window.browserPeersTest.contentPrepare(raw), {
    grantId: f.grant.id,
    id: randomUUID(),
    kind: "message",
    parentId: null,
    content: "SYNTHETIC_PRIVATE_BROWSER_MESSAGE",
    expiresAt: f.f.now + 120000,
    confirmed: true,
    ...patch,
  });
const wire = (page: Page, entry: any) =>
  page.evaluate((raw) => window.browserPeersTest.contentEnvelope(raw), {
    grantId: entry.grantId,
    id: entry.id,
    expectedRevision: entry.revision,
    confirmed: true,
  });
const accept = (page: Page, f: Fixture, envelope: unknown) =>
  page.evaluate((raw) => window.browserPeersTest.contentAccept(raw), {
    grantId: f.grant.id,
    envelope,
    confirmed: true,
  });
const read = (page: Page, entry: any) =>
  page.evaluate((raw) => window.browserPeersTest.contentRead(raw), {
    grantId: entry.grantId,
    id: entry.id,
  });
const sequences = new WeakMap<Fixture, number>();
async function incoming(
  f: Fixture,
  patch: Record<string, unknown> = {},
  headerPatch: Record<string, unknown> = {},
) {
  const data = {
    version: 1,
    type: "conversation.message",
    scope: f.offer.data.scope,
    id: randomUUID(),
    parentId: null,
    content: "SYNTHETIC_PRIVATE_MAC_MESSAGE",
    ...patch,
  };
  const sequence = (sequences.get(f) ?? 1000) + 1;
  sequences.set(f, sequence);
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
      operationId: data.id,
      messageId: randomUUID(),
      sequence,
      issuedAt: f.f.now,
      expiresAt: f.f.now + 120000,
      ...headerPatch,
    },
    new TextEncoder().encode(JSON.stringify(data)),
    { senderKey: k.pair, recipientPublicKey: p.publicKey },
    () => f.f.now,
  );
  return { data, envelope };
}
async function openMac(f: Fixture, envelope: any) {
  const k = await f.mac.keys.resolve(),
    p = await f.mac.peers.resolve(f.f.binding.deviceId, f.local.keyEpoch);
  const opened = await openPrivateEnvelope(
    envelope,
    envelope.header,
    { recipientKey: k.pair, senderPublicKey: p.publicKey },
    () => f.f.now,
  );
  try {
    return JSON.parse(new TextDecoder().decode(opened.plaintext));
  } finally {
    opened.plaintext.fill(0);
  }
}
test.beforeEach(async ({ context }) => {
  await context.route("**/*", (r) =>
    new URL(r.request().url()).origin === "http://127.0.0.1:44137"
      ? r.continue()
      : r.abort(),
  );
});

test("actual Mac and browser message engines retain original ciphertext and accept exactly once", async ({
  page,
}) => {
  const f = await setup(page);
  try {
    const first = await prepare(page, f),
      envelope = await wire(page, first);
    expect((await openMac(f, envelope)).content).toBe(
      "SYNTHETIC_PRIVATE_BROWSER_MESSAGE",
    );
    const received = await f.offer.receive(envelope);
    expect(received.duplicate).toBe(false);
    expect((await f.offer.receive(envelope)).duplicate).toBe(true);
    const reply = await f.offer.message("SYNTHETIC_ACTUAL_MAC_REPLY", first.id),
      accepted = await accept(page, f, reply);
    expect(accepted.duplicate).toBe(false);
    expect((await read(page, accepted.entry)).content).toMatchObject({
      parentId: first.id,
      content: "SYNTHETIC_ACTUAL_MAC_REPLY",
    });
    const before = await inspect(page);
    expect(before.count).toBe(2);
    expect(before.exportDenied).toBe(true);
    expect(before.json).not.toContain("SYNTHETIC");
    expect(before.json).not.toContain(f.grant.id);
    expect(before.json).not.toContain(first.id);
    expect((await accept(page, f, reply)).duplicate).toBe(true);
    expect(await inspect(page)).toEqual(before);
    const receipt = await wire(page, accepted.entry);
    expect(await openMac(f, receipt)).toMatchObject({
      type: "conversation.received",
      acceptedId: accepted.entry.id,
      acceptedType: "conversation.message",
    });
    await reopen(page, f.f);
    expect(await wire(page, { ...first, revision: 2 })).toEqual(envelope);
    expect(await wire(page, { ...accepted.entry, revision: 2 })).toEqual(
      receipt,
    );
    expect((await read(page, accepted.entry)).content.content).toBe(
      "SYNTHETIC_ACTUAL_MAC_REPLY",
    );
  } finally {
    f.mac.close();
  }
});

test("pending parents have no effects and authenticated parents permit retry", async ({
  page,
}) => {
  const f = await setup(page);
  try {
    const parent = await incoming(f),
      child = await incoming(f, { parentId: parent.data.id });
    const before = await inspect(page);
    await expect(accept(page, f, child.envelope)).rejects.toThrow(
      "PARENT_PENDING",
    );
    expect(await inspect(page)).toEqual(before);
    await expect(
      prepare(page, f, { parentId: parent.data.id }),
    ).rejects.toThrow("PARENT_PENDING");
    expect(await inspect(page)).toEqual(before);
    await accept(page, f, parent.envelope);
    expect((await accept(page, f, child.envelope)).duplicate).toBe(false);
    const reply = await prepare(page, f, { parentId: child.data.id });
    expect((await read(page, reply)).content).toMatchObject({
      parentId: child.data.id,
    });
  } finally {
    f.mac.close();
  }
});

test("answers derive the exact authenticated question revision and remain distinct from ordinary replies", async ({
  page,
}) => {
  const f = await setup(page);
  try {
    const taskId = randomUUID();
    const q = await incoming(f, {
      type: "conversation.question",
      parentId: undefined,
      taskId,
      taskRevision: 7,
      deadline: f.f.now + 120000,
    });
    const question = await accept(page, f, q.envelope);
    const reply = await prepare(page, f, { parentId: q.data.id });
    expect((await openMac(f, await wire(page, reply))).type).toBe(
      "conversation.message",
    );
    await expect(
      prepare(page, f, { kind: "answer", parentId: null }),
    ).rejects.toThrow("DENIED");
    await expect(
      prepare(page, f, {
        kind: "answer",
        parentId: q.data.id,
        expectedRevision: 2,
      }),
    ).rejects.toThrow("DENIED");
    const answer = await prepare(page, f, {
      kind: "answer",
      parentId: question.entry.id,
      content: "Use the supplied record.",
    });
    expect(await openMac(f, await wire(page, answer))).toMatchObject({
      type: "conversation.answer",
      questionId: q.data.id,
      taskId,
      expectedRevision: 7,
      confirmed: true,
    });
    await page.evaluate(
      (t) => window.browserPeersTest.time(t, 120000),
      f.f.now + 120000,
    );
    await expect(
      prepare(page, f, {
        kind: "answer",
        parentId: question.entry.id,
        expiresAt: f.f.now + 120001,
      }),
    ).rejects.toThrow("DENIED");
  } finally {
    f.mac.close();
  }
});

test("wire IDs and replay identities cannot be reused within or across protocol families", async ({
  page,
}) => {
  const f = await setup(page);
  try {
    const a = await incoming(f);
    await accept(page, f, a.envelope);
    const before = await inspect(page);
    for (const header of [
      { messageId: a.envelope.header.messageId },
      { sequence: a.envelope.header.sequence },
      { messageId: f.offer.envelope.header.messageId },
      { sequence: f.offer.envelope.header.sequence },
    ]) {
      // Operation IDs are role-scoped (e.g. acceptance and result share one).
      // Message IDs and directed sequences are shared across all families.
      const b = await incoming(f, {}, header);
      await expect(accept(page, f, b.envelope)).rejects.toThrow("CONFLICT");
      expect(await inspect(page)).toEqual(before);
    }
    const changed = await incoming(f, {
      id: a.data.id,
      content: "Different content",
    });
    await expect(accept(page, f, changed.envelope)).rejects.toThrow("CONFLICT");
    expect(await inspect(page)).toEqual(before);
    const id = randomUUID(),
      first = await prepare(page, f, { id });
    expect(await prepare(page, f, { id })).toEqual(first);
    await expect(prepare(page, f, { id, content: "changed" })).rejects.toThrow(
      "CONFLICT",
    );
  } finally {
    f.mac.close();
  }
});

test("content-write failure rolls back replay and shared sequence so the same message can retry", async ({
  page,
}) => {
  const f = await setup(page);
  try {
    const message = await incoming(f),
      before = await inspect(page);
    await page.evaluate(() => window.browserPeersTest.contentFailWrite());
    await expect(accept(page, f, message.envelope)).rejects.toThrow("CAPACITY");
    expect(await inspect(page)).toEqual(before);
    expect((await accept(page, f, message.envelope)).duplicate).toBe(false);
    expect((await inspect(page)).count).toBe(1);
  } finally {
    f.mac.close();
  }
});

for (const loss of ["identity", "permission", "coverage", "deadline"] as const)
  test(`loss of ${loss} during encryption rejects publication without replay or sequence effects`, async ({
    page,
  }) => {
    const f = await setup(page);
    try {
      const message = await incoming(f),
        before = await inspect(page);
      // First AES-GCM encryption in content admission is the retained row capsule.
      await page.evaluate(() =>
        window.browserPeersTest.contentHoldEncryption(),
      );
      const pending = accept(page, f, message.envelope).then(
        () => "unexpected success",
        () => "denied",
      );
      await page.waitForFunction(() => window.browserPeersTest.held());
      if (loss === "identity")
        await page.evaluate(() => window.browserPeersTest.set(null));
      if (loss === "permission")
        await page.evaluate(async (id) => {
          const api = window.browserPeersTest,
            s = await api.conversationStatus();
          return api.conversationRevoke({
            grantId: id,
            expectedRevision: s.revision,
            confirmed: true,
          });
        }, f.grant.id);
      if (loss === "coverage")
        await page.evaluate(() =>
          window.browserPeersTest.contentInspect("strip-coverage"),
        );
      if (loss === "deadline")
        await page.evaluate(
          (t) => window.browserPeersTest.time(t, 120000),
          f.f.now + 120000,
        );
      await page.evaluate(() => window.browserPeersTest.release());
      expect(await pending).toBe("denied");
      const after = await inspect(page);
      expect(after.count).toBe(0);
      expect(after.ledger).toBe(before.ledger);
      expect(after.channels).toBe(before.channels);
    } finally {
      f.mac.close();
    }
  });

test("explicit archive export outlives delivery TTL while deletion locks consent and preserves replay fences", async ({
  page,
}) => {
  const f = await setup(page);
  try {
    const a = await incoming(f),
      accepted = await accept(page, f, a.envelope);
    const before = await inspect(page);
    await page.evaluate(
      (t) => window.browserPeersTest.time(t, 120001),
      f.f.now + 120001,
    );
    expect((await read(page, accepted.entry)).content.content).toBe(
      a.data.content,
    );
    await expect(wire(page, accepted.entry)).rejects.toThrow("DENIED");
    await page.evaluate(
      (t) => window.browserPeersTest.time(t, 250000),
      f.f.now + 250000,
    );
    await expect(read(page, accepted.entry)).rejects.toThrow("DENIED");
    await expect(
      page.evaluate(() =>
        window.browserPeersTest.contentExport({ confirmed: false }),
      ),
    ).rejects.toThrow("DENIED");
    const archive = await page.evaluate(() =>
      window.browserPeersTest.contentExport({ confirmed: true }),
    );
    expect(archive.restoreAuthority).toBe(false);
    expect(archive.items).toHaveLength(1);
    expect(JSON.stringify(archive)).not.toContain('"key"');
    expect(JSON.stringify(archive)).not.toContain('"grant"');
    await page.evaluate(
      (b) =>
        window.browserPeersTest.set({ ...b, ownerId: crypto.randomUUID() }),
      f.f.binding,
    );
    expect(
      (
        await page.evaluate(() =>
          window.browserPeersTest.contentExport({ confirmed: true }),
        )
      ).items,
    ).toEqual([]);
    await page.evaluate(() => window.browserPeersTest.set(null));
    await expect(
      page.evaluate(() =>
        window.browserPeersTest.contentExport({ confirmed: true }),
      ),
    ).rejects.toThrow("DENIED");
    const consent = await page.evaluate(() =>
      window.browserPeersTest.conversationStatus(),
    );
    await expect(
      page.evaluate(
        (revision) =>
          window.browserPeersTest.contentClear({
            expectedConsentRevision: revision + 1,
            confirmed: true,
          }),
        consent.revision,
      ),
    ).rejects.toThrow("CONFLICT");
    expect((await inspect(page)).count).toBe(1);
    const cleared = await page.evaluate(
      (revision) =>
        window.browserPeersTest.contentClear({
          expectedConsentRevision: revision,
          confirmed: true,
        }),
      consent.revision,
    );
    expect(cleared.removed).toBe(1);
    expect((await inspect(page)).ledger).toBe(before.ledger);
    await reopen(page, f.f);
    expect(
      (await page.evaluate(() => window.browserPeersTest.conversationStatus()))
        .needsFreshDevice,
    ).toBe(true);
    expect((await inspect(page)).count).toBe(0);
    await expect(accept(page, f, a.envelope)).rejects.toThrow("DENIED");
  } finally {
    f.mac.close();
  }
});

test("missing retained outcome cannot be recreated by replay and tampered storage fails closed", async ({
  page,
}) => {
  const f = await setup(page);
  try {
    const a = await incoming(f);
    const accepted = await accept(page, f, a.envelope);
    await page.evaluate(() =>
      window.browserPeersTest.contentInspect("corrupt"),
    );
    await expect(read(page, accepted.entry)).rejects.toThrow(
      "STORAGE_UNAVAILABLE",
    );
    await page.evaluate(() => window.browserPeersTest.contentInspect("remove"));
    const before = await inspect(page);
    await expect(accept(page, f, a.envelope)).rejects.toThrow("CONFLICT");
    expect(await inspect(page)).toEqual(before);
  } finally {
    f.mac.close();
  }
});

test("actual version12 upgrade preserves keys, grants, shared replay and channels and refuses old writers", async ({
  page,
}) => {
  const f = await setup(page, "content");
  try {
    const before = await inspect(page);
    expect(before.version).toBe(12);
    await reopen(page, f.f);
    const after = await inspect(page);
    expect(after.version).toBe(20);
    expect(after.count).toBe(0);
    const oldRows = JSON.parse(before.all),
      newRows = JSON.parse(after.all);
    expect(newRows.resume_consents).toEqual([]);
    delete newRows.resume_consents;
    expect(newRows.resume_delivery).toEqual([]);
    delete newRows.resume_delivery;
    expect(newRows.autonote_approval_inbox).toEqual([]);
    delete newRows.autonote_approval_inbox;
    expect(newRows.autonote_approval_decisions).toEqual([]);
    delete newRows.autonote_approval_decisions;
    delete newRows.conversation_content;
    expect(newRows).toEqual(oldRows);
    expect(
      (await page.evaluate(() => window.browserPeersTest.conversationStatus()))
        .grants,
    ).toContainEqual(f.grant);
    const entry = await prepare(page, f);
    await wire(page, entry);
    await expect(reopen(page, f.f, "content")).rejects.toThrow(
      "STORAGE_UNAVAILABLE",
    );
    await reopen(page, f.f);
    expect((await read(page, entry)).content.content).toBe(
      "SYNTHETIC_PRIVATE_BROWSER_MESSAGE",
    );
  } finally {
    f.mac.close();
  }
});

test("offer transport acknowledgement does not invalidate retained content authority", async ({
  page,
}) => {
  const f = await setup(page);
  try {
    const a = await incoming(f),
      accepted = await accept(page, f, a.envelope);
    const { privateRelayEnvelopeHash } =
      await import("../../modules/remote/private-relay-contracts.js");
    const envelope = f.offer.envelope;
    const attempt = await page.evaluate(
      (raw) => window.browserPeersTest.conversationBeginAck(raw),
      {
        grantId: f.grant.id,
        expectedRevision: f.grant.revision,
        confirmed: true,
        selected: {
          envelope,
          selection: {
            messageId: envelope.header.messageId,
            envelopeHash: await privateRelayEnvelopeHash(envelope),
            revision: 1,
            storedAt: envelope.header.issuedAt,
          },
        },
      },
    );
    await page.evaluate(
      (raw) => window.browserPeersTest.conversationRecordAck(raw),
      {
        grantId: attempt.grant.id,
        expectedRevision: attempt.revision,
        confirmed: true,
        receipt: {
          version: 1,
          ...attempt.grant.relayAcknowledgement!.selection,
          revision: 2,
          state: "received",
        },
      },
    );
    expect((await read(page, accepted.entry)).content.content).toBe(
      a.data.content,
    );
    expect((await accept(page, f, a.envelope)).duplicate).toBe(true);
    expect(
      (await openMac(f, await wire(page, accepted.entry))).acceptedId,
    ).toBe(a.data.id);
  } finally {
    f.mac.close();
  }
});

test("narrowing independent conversation directions rejects new admission and old grants", async ({
  page,
}) => {
  const f = await setup(page);
  try {
    const old = await prepare(page, f);
    const grant = await page.evaluate(
      async ({ grant, envelope, pin, now }) => {
        const api = window.browserPeersTest,
          status = await api.conversationStatus();
        const review = await api.conversationPrepare({
          expectedRevision: status.revision,
          peerId: pin.peerId,
          peerKeyEpoch: pin.keyEpoch,
          envelope,
          permissions: {
            ...grant.choices.permissions,
            messagesToBrowser: false,
            messagesToMac: false,
          },
          expiresAt: now + 240000,
        });
        return api.conversationApprove({
          reviewId: review.reviewId,
          expectedRevision: review.expectedRevision,
          confirmed: true,
          acknowledged: true,
        });
      },
      { grant: f.grant, envelope: f.offer.envelope, pin: f.pin, now: f.f.now },
    );
    await expect(wire(page, old)).rejects.toThrow("DENIED");
    await expect(prepare(page, { ...f, grant })).rejects.toThrow("DENIED");
    const message = await incoming(f);
    const before = await inspect(page);
    await expect(
      accept(page, { ...f, grant }, message.envelope),
    ).rejects.toThrow("DENIED");
    expect(await inspect(page)).toEqual(before);
  } finally {
    f.mac.close();
  }
});

const reconcile = (
  page: Page,
  entry: any,
  envelope: unknown,
  patch: Record<string, unknown> = {},
) =>
  page.evaluate((raw) => window.browserPeersTest.contentReconcile(raw), {
    grantId: entry.grantId,
    id: entry.id,
    expectedRevision: entry.revision,
    envelope,
    confirmed: true,
    ...patch,
  });
async function independentReceipt(
  f: Fixture,
  original: any,
  bodyPatch: Record<string, unknown> = {},
  headerPatch: Record<string, unknown> = {},
) {
  const content = await openMac(f, original);
  const key = await f.mac.keys.resolve(),
    peer = await f.mac.peers.resolve(f.f.binding.deviceId, f.local.keyEpoch);
  const sequence = (sequences.get(f) ?? 1000) + 1;
  sequences.set(f, sequence);
  return sealPrivateEnvelope(
    {
      ...original.header,
      senderId: original.header.recipientId,
      recipientId: original.header.senderId,
      senderKeyEpoch: original.header.recipientKeyEpoch,
      recipientKeyEpoch: original.header.senderKeyEpoch,
      messageId: randomUUID(),
      sequence,
      ...headerPatch,
    },
    new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        type: "conversation.received",
        scope: content.scope,
        acceptedId: content.id,
        acceptedType: content.type,
        operationId: content.id,
        acceptedAt: f.f.now,
        ...bodyPatch,
      }),
    ),
    { senderKey: key.pair, recipientPublicKey: peer.publicKey },
    () => f.f.now,
  );
}

test("actual Mac storage receipt survives reload and duplicate inspection without replacing outgoing ciphertext", async ({
  page,
}) => {
  const f = await setup(page);
  try {
    const prepared = await prepare(page, f),
      envelope = await wire(page, prepared);
    const entry = await read(page, prepared),
      receipt = await f.offer.receipt(envelope);
    const before = await inspect(page),
      admitted = await reconcile(page, entry, receipt);
    expect(admitted).toMatchObject({
      status: "recipient-storage-confirmed",
      duplicate: false,
      entry: {
        id: entry.id,
        revision: 3,
        recipientAccepted: true,
        state: "ready",
        recipientAcceptedAt: f.f.now,
      },
    });
    expect(JSON.stringify(admitted)).not.toContain("SYNTHETIC");
    const after = await inspect(page);
    expect(after.count).toBe(before.count);
    expect(after.channels).toBe(before.channels);
    expect(after.ledger).not.toBe(before.ledger);
    expect(after.json).not.toContain("SYNTHETIC");
    await reopen(page, f.f);
    expect((await reconcile(page, admitted.entry, receipt)).duplicate).toBe(
      true,
    );
    expect(await inspect(page)).toEqual(after);
    expect(await wire(page, admitted.entry)).toEqual(envelope);
    await expect(reconcile(page, entry, receipt)).rejects.toThrow("CONFLICT");
    expect(await inspect(page)).toEqual(after);
    const archive = await page.evaluate(() =>
      window.browserPeersTest.contentExport({ confirmed: true }),
    );
    expect(archive.items[0]).toMatchObject({
      recipientAccepted: true,
      envelope,
      receiptEnvelope: receipt,
    });
  } finally {
    f.mac.close();
  }
});

test("storage receipts for exact answers do not run or complete the Mac worker", async ({
  page,
}) => {
  const f = await setup(page, false, true);
  try {
    const worker = await f.offer.question();
    const question = await accept(page, f, worker.envelope);
    const answer = await prepare(page, f, {
      kind: "answer",
      parentId: question.entry.id,
      content: "Lisbon",
    });
    const envelope = await wire(page, answer),
      receipt = await f.offer.receipt(envelope);
    expect(worker.task().status).toBe("queued");
    const calls = worker.calls();
    const admitted = await reconcile(page, await read(page, answer), receipt);
    expect(admitted.entry).toMatchObject({
      kind: "conversation.answer",
      recipientAccepted: true,
    });
    expect(worker.task().status).toBe("queued");
    expect(worker.calls()).toBe(calls);
    await reconcile(page, admitted.entry, receipt);
    expect(worker.calls()).toBe(calls);
    await worker.run();
    expect(worker.task().status).toBe("completed");
    expect(worker.calls()).toBeGreaterThan(calls);
  } finally {
    f.mac.close();
  }
});

test("receipt identity, type, consent, directed keys and delivery bounds cannot be substituted", async ({
  page,
}) => {
  const f = await setup(page);
  try {
    const prepared = await prepare(page, f),
      envelope = await wire(page, prepared),
      entry = await read(page, prepared);
    const before = await inspect(page);
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ acceptedId: randomUUID() }, {}],
      [{ operationId: randomUUID() }, {}],
      [{ acceptedType: "conversation.answer" }, {}],
      [{ scope: { ...f.offer.data.scope, conversationRef: randomUUID() } }, {}],
      [{ acceptedAt: f.f.now - 30001 }, {}],
      [{ acceptedAt: f.f.now + 30001 }, {}],
      [{}, { operationId: randomUUID() }],
      [{}, { recipientId: randomUUID() }],
      [{}, { senderKeyEpoch: envelope.header.recipientKeyEpoch + 1 }],
      [{}, { expiresAt: envelope.header.expiresAt + 1 }],
      [{}, { issuedAt: f.f.now - 30001 }],
      [{}, { sequence: f.offer.envelope.header.sequence }],
      [{}, { messageId: f.offer.envelope.header.messageId }],
    ];
    for (const [body, header] of cases) {
      await expect(
        reconcile(
          page,
          entry,
          await independentReceipt(f, envelope, body, header),
        ),
      ).rejects.toThrow();
      expect(await inspect(page)).toEqual(before);
    }
    const receipt = await independentReceipt(f, envelope);
    for (const patch of [
      { confirmed: false },
      { grantId: randomUUID() },
      { ownerId: randomUUID() },
      { id: randomUUID() },
    ]) {
      await expect(reconcile(page, entry, receipt, patch)).rejects.toThrow();
      expect(await inspect(page)).toEqual(before);
    }
    const admitted = await reconcile(page, entry, receipt);
    const saved = await inspect(page);
    await expect(
      reconcile(page, admitted.entry, await independentReceipt(f, envelope)),
    ).rejects.toThrow("CONFLICT");
    expect(await inspect(page)).toEqual(saved);
  } finally {
    f.mac.close();
  }
});

test("receipt write failure rolls back the already-inserted shared replay outcome", async ({
  page,
}) => {
  const f = await setup(page);
  try {
    const prepared = await prepare(page, f),
      envelope = await wire(page, prepared),
      entry = await read(page, prepared);
    const receipt = await f.offer.receipt(envelope),
      before = await inspect(page);
    await page.evaluate(() =>
      window.browserPeersTest.contentFailReceiptWrite(),
    );
    await expect(reconcile(page, entry, receipt)).rejects.toThrow("CAPACITY");
    expect(await inspect(page)).toEqual(before);
    expect((await reconcile(page, entry, receipt)).duplicate).toBe(false);
  } finally {
    f.mac.close();
  }
});

for (const loss of ["identity", "permission", "coverage", "deadline"] as const)
  test(`receipt reconciliation loses ${loss} during encryption without retained or replay effects`, async ({
    page,
  }) => {
    const f = await setup(page);
    try {
      const prepared = await prepare(page, f),
        envelope = await wire(page, prepared),
        entry = await read(page, prepared);
      const receipt = await f.offer.receipt(envelope),
        before = await inspect(page);
      await page.evaluate(() =>
        window.browserPeersTest.contentHoldEncryption(),
      );
      const pending = reconcile(page, entry, receipt).then(
        () => "unexpected",
        () => "denied",
      );
      await page.waitForFunction(() => window.browserPeersTest.held());
      if (loss === "identity")
        await page.evaluate(() => window.browserPeersTest.set(null));
      if (loss === "permission")
        await page.evaluate(async (grantId) => {
          const api = window.browserPeersTest,
            state = await api.conversationStatus();
          await api.conversationRevoke({
            grantId,
            expectedRevision: state.revision,
            confirmed: true,
          });
        }, f.grant.id);
      if (loss === "coverage")
        await page.evaluate(() =>
          window.browserPeersTest.contentInspect("strip-coverage"),
        );
      if (loss === "deadline")
        await page.evaluate(
          (time) => window.browserPeersTest.time(time, 120000),
          f.f.now + 120000,
        );
      await page.evaluate(() => window.browserPeersTest.release());
      expect(await pending).toBe("denied");
      const after = await inspect(page);
      expect(after.json).toBe(before.json);
      expect(after.ledger).toBe(before.ledger);
      expect(after.channels).toBe(before.channels);
    } finally {
      f.mac.close();
    }
  });

test("receipts cannot acknowledge unsealed, incoming or deleted originals", async ({
  page,
}) => {
  const f = await setup(page);
  try {
    const prepared = await prepare(page, f),
      other = await prepare(page, f);
    const envelope = await wire(page, prepared),
      entry = await read(page, prepared),
      receipt = await f.offer.receipt(envelope);
    const incomingMessage = await f.offer.message("SYNTHETIC_DIRECTION"),
      incomingEntry = await accept(page, f, incomingMessage);
    const before = await inspect(page);
    await expect(reconcile(page, other, receipt)).rejects.toThrow();
    await expect(
      reconcile(page, incomingEntry.entry, receipt),
    ).rejects.toThrow();
    expect(await inspect(page)).toEqual(before);
    await reconcile(page, entry, receipt);
    await page.evaluate(() => window.browserPeersTest.contentInspect("remove"));
    const removed = await inspect(page);
    await expect(
      reconcile(page, { ...entry, revision: 3 }, receipt),
    ).rejects.toThrow();
    expect(await inspect(page)).toEqual(removed);
  } finally {
    f.mac.close();
  }
});

test("actual version13 upgrade preserves encrypted originals and receipts fence the old writer", async ({
  page,
}) => {
  const f = await setup(page, "receipts");
  try {
    const prepared = await prepare(page, f),
      envelope = await wire(page, prepared),
      before = await inspect(page);
    expect(before.version).toBe(13);
    const receipt = await f.offer.receipt(envelope);
    await reopen(page, f.f);
    const upgraded = await inspect(page);
    expect(upgraded.version).toBe(20);
    expect(JSON.parse(upgraded.all)).toEqual({
      ...JSON.parse(before.all),
      resume_consents: [],
      resume_delivery: [],
      autonote_approval_inbox: [],
      autonote_approval_decisions: [],
    });
    expect(await wire(page, { ...prepared, revision: 2 })).toEqual(envelope);
    const result = await reconcile(page, await read(page, prepared), receipt);
    await expect(reopen(page, f.f, "receipts")).rejects.toThrow(
      "STORAGE_UNAVAILABLE",
    );
    await reopen(page, f.f);
    expect((await reconcile(page, result.entry, receipt)).duplicate).toBe(true);
    expect(await wire(page, result.entry)).toEqual(envelope);
    const consent = await page.evaluate(() =>
      window.browserPeersTest.conversationStatus(),
    );
    const ledger = (await inspect(page)).ledger;
    await page.evaluate(
      (expectedConsentRevision) =>
        window.browserPeersTest.contentClear({
          expectedConsentRevision,
          confirmed: true,
        }),
      consent.revision,
    );
    const cleared = await inspect(page);
    expect(cleared.count).toBe(0);
    expect(cleared.ledger).toBe(ledger);
  } finally {
    f.mac.close();
  }
});

const relayInput = (entry: any) => ({
  grantId: entry.grantId,
  id: entry.id,
  expectedRevision: entry.revision,
  confirmed: true,
});
const beginRelay = (page: Page, entry: any, expiresAt: number) =>
  page.evaluate((raw) => window.browserPeersTest.contentRelayBegin(raw), {
    ...relayInput(entry),
    deliveryExpiresAt: expiresAt,
  });
const recordRelay = (page: Page, entry: any, receipt: unknown) =>
  page.evaluate((raw) => window.browserPeersTest.contentRelayRecord(raw), {
    ...relayInput(entry),
    receipt,
  });

test("conversation relay attempts survive reload and retain original ciphertext across explicit retry and server observations", async ({
  page,
}) => {
  const f = await setup(page);
  try {
    const prepared = await prepare(page, f),
      envelope = await wire(page, prepared),
      entry = await read(page, prepared);
    const before = await inspect(page);
    const first = await beginRelay(page, entry, f.f.now + 180000);
    expect(first.envelope).toEqual(envelope);
    expect(first.entry.relayAttempts).toBe(1);
    expect(first.entry.relayObservation).toBeNull();
    await reopen(page, f.f);
    const saved = await read(page, entry);
    expect(saved.relayAttempts).toBe(1);
    const retry = await beginRelay(page, saved, f.f.now + 180000);
    expect(retry.envelope).toEqual(envelope);
    expect(retry.entry.relayAttempts).toBe(2);
    const { privateRelayEnvelopeHash } =
      await import("../../modules/remote/private-relay-contracts.js");
    const receipt = {
      version: 1,
      messageId: envelope.header.messageId,
      envelopeHash: await privateRelayEnvelopeHash(envelope),
      revision: 1,
      state: "stored",
      storedAt: f.f.now,
    };
    await expect(
      recordRelay(page, retry.entry, {
        ...receipt,
        envelopeHash: "0".repeat(64),
      }),
    ).rejects.toThrow("DENIED");
    const recorded = await recordRelay(page, retry.entry, receipt);
    expect(recorded.relayObservation?.attempt).toBe(2);
    expect(recorded.recipientAccepted).toBe(false);
    const advanced = await recordRelay(page, recorded, {
      ...receipt,
      revision: 2,
      state: "received",
    });
    await expect(recordRelay(page, advanced, receipt)).rejects.toThrow(
      "CONFLICT",
    );
    expect(await wire(page, advanced)).toEqual(envelope);
    const after = await inspect(page);
    expect(after.ledger).toBe(before.ledger);
    expect(after.channels).toEqual(before.channels);
  } finally {
    f.mac.close();
  }
});

test("conversation relay stop remains local after identity loss and prevents later uploads without erasing content", async ({
  page,
}) => {
  const f = await setup(page);
  try {
    const prepared = await prepare(page, f),
      envelope = await wire(page, prepared),
      entry = await read(page, prepared);
    await page.evaluate(() => window.browserPeersTest.set(null));
    const stopped = await page.evaluate(
      (raw) => window.browserPeersTest.contentRelayStop(raw),
      relayInput(entry),
    );
    expect(stopped.relayStopped).toBe(true);
    expect(stopped.relayAttempts).toBe(0);
    await reopen(page, f.f);
    await expect(beginRelay(page, stopped, f.f.now + 180000)).rejects.toThrow(
      "DENIED",
    );
    expect(await wire(page, stopped)).toEqual(envelope);
    expect((await read(page, stopped)).content.content).toBe(
      "SYNTHETIC_PRIVATE_BROWSER_MESSAGE",
    );
  } finally {
    f.mac.close();
  }
});

test("failed conversation relay attempt writes roll back and short delivery windows cannot create attempts", async ({
  page,
}) => {
  const f = await setup(page);
  try {
    const prepared = await prepare(page, f);
    await wire(page, prepared);
    const entry = await read(page, prepared),
      before = await inspect(page);
    await expect(beginRelay(page, entry, f.f.now + 1000)).rejects.toThrow(
      "DENIED",
    );
    await page.evaluate(() =>
      window.browserPeersTest.contentFailReceiptWrite(),
    );
    await expect(beginRelay(page, entry, f.f.now + 180000)).rejects.toThrow(
      "CAPACITY",
    );
    expect(await inspect(page)).toEqual(before);
    expect(
      (await beginRelay(page, entry, f.f.now + 180000)).entry.relayAttempts,
    ).toBe(1);
  } finally {
    f.mac.close();
  }
});

test("actual version14 content upgrades without invented relay history and the old writer is fenced", async ({
  page,
}) => {
  const f = await setup(page, "relay-content");
  try {
    const prepared = await prepare(page, f),
      envelope = await wire(page, prepared),
      before = await inspect(page);
    expect(before.version).toBe(14);
    await reopen(page, f.f);
    const upgraded = await inspect(page);
    expect(upgraded.version).toBe(20);
    expect(JSON.parse(upgraded.all)).toEqual({
      ...JSON.parse(before.all),
      resume_consents: [],
      resume_delivery: [],
      autonote_approval_inbox: [],
      autonote_approval_decisions: [],
    });
    const entry = await read(page, prepared);
    expect(entry.relayAttempts).toBe(0);
    expect(entry.relayObservation).toBeNull();
    expect(await wire(page, entry)).toEqual(envelope);
    await expect(reopen(page, f.f, "relay-content")).rejects.toThrow(
      "STORAGE_UNAVAILABLE",
    );
    await reopen(page, f.f);
    const attempt = await beginRelay(page, entry, f.f.now + 180000);
    expect(attempt.envelope).toEqual(envelope);
  } finally {
    f.mac.close();
  }
});

for (const kind of ["message", "question"] as const)
  test(`actual version11 historical key rejects authenticated ${kind} content after upgrade and fresh consent`, async ({
    page,
  }) => {
    const f = await setup(page, "key-boundary", kind === "question");
    try {
      const question = kind === "question" ? await f.offer.question() : null;
      const envelope =
        question?.envelope ??
        (await f.offer.message("SYNTHETIC_HISTORICAL_KEY_MESSAGE"));
      const before = await page.evaluate(async (keyId) => {
        const api = window.browserPeersTest;
        return {
          key: await api.key(),
          kit: await api.recovery(keyId),
          grants: await api.conversationStatus(),
        };
      }, f.local.keyId);
      const old = await inspect(page);
      expect(old.version).toBe(11);
      const oldSlots = JSON.parse(old.all).slots;
      expect(oldSlots).toHaveLength(1);
      expect(oldSlots[0].incomingReplayBoundary).toBeUndefined();
      // Authenticate actual Mac-produced bytes with the retained browser key.
      // Cryptographic validity is deliberately separate from content admission.
      const opened = await page.evaluate(
        ({ peerId, keyEpoch, envelope }) =>
          window.browserPeersTest.open(
            peerId,
            keyEpoch,
            envelope,
            envelope.header,
          ),
        { peerId: f.pin.peerId, keyEpoch: f.pin.keyEpoch, envelope },
      );
      expect(JSON.parse(opened).type).toBe(`conversation.${kind}`);
      await reopen(page, f.f);
      expect(await page.evaluate(() => window.browserPeersTest.key())).toEqual(
        before.key,
      );
      expect(
        await page.evaluate(
          (id) => window.browserPeersTest.recovery(id),
          f.local.keyId,
        ),
      ).toEqual(before.kit);
      expect(
        await page.evaluate(() => window.browserPeersTest.conversationStatus()),
      ).toEqual(before.grants);
      const upgraded = await inspect(page);
      expect(upgraded.version).toBe(20);
      expect(upgraded.ledger).toBe(old.ledger);
      expect(upgraded.channels).toBe(old.channels);
      expect(JSON.parse(upgraded.all).slots).toEqual(oldSlots);
      await expect(accept(page, f, envelope)).rejects.toThrow("DENIED");
      await expect(prepare(page, f)).rejects.toThrow("DENIED");
      expect(await inspect(page)).toEqual(upgraded);
      // A newly reviewed offer under the same old key cannot manufacture provenance.
      const next = await f.mac.conversationOffer(undefined, {
        questions: kind === "question",
      });
      const saved = await page.evaluate(
        async ({ offer, peerId, peerKeyEpoch, now }) => {
          const api = window.browserPeersTest;
          const state = await api.conversationStatus();
          const review = await api.conversationPrepare({
            expectedRevision: state.revision,
            peerId,
            peerKeyEpoch,
            envelope: offer.envelope,
            permissions: offer.permissions,
            expiresAt: now + 240000,
          });
          return api.conversationApprove({
            reviewId: review.reviewId,
            expectedRevision: review.expectedRevision,
            confirmed: true,
            acknowledged: true,
          });
        },
        {
          offer: {
            envelope: next.envelope,
            permissions: next.data.permissions,
          },
          peerId: f.pin.peerId,
          peerKeyEpoch: f.pin.keyEpoch,
          now: f.f.now,
        },
      );
      const nextEnvelope = await next.message(
        "SYNTHETIC_FRESH_CONSENT_OLD_KEY",
      );
      const renewed = await inspect(page);
      const oldReplay = JSON.parse(old.ledger);
      const renewedReplay = JSON.parse(renewed.ledger);
      expect(renewedReplay).toHaveLength(oldReplay.length + 1);
      expect(renewedReplay).toEqual(expect.arrayContaining(oldReplay));
      expect(
        renewedReplay
          .filter((entry: { type: string }) =>
            entry.type.startsWith("conversation."),
          )
          .map((entry: { type: string }) => entry.type),
      ).toEqual(["conversation.offer", "conversation.offer"]);
      await expect(
        page.evaluate((raw) => window.browserPeersTest.contentAccept(raw), {
          grantId: saved.id,
          envelope: nextEnvelope,
          confirmed: true,
        }),
      ).rejects.toThrow("DENIED");
      expect(await inspect(page)).toEqual(renewed);
      await reopen(page, f.f);
      await expect(accept(page, f, envelope)).rejects.toThrow("DENIED");
      const final = await inspect(page);
      expect(final.count).toBe(0);
      expect(final.ledger).toBe(renewed.ledger);
      expect(final.channels).toBe(renewed.channels);
      expect(JSON.parse(final.all).slots).toEqual(oldSlots);
      expect(
        await page.evaluate(
          (id) => window.browserPeersTest.recovery(id),
          f.local.keyId,
        ),
      ).toEqual(before.kit);
      if (question) {
        expect(question.task().status).toBe("awaiting_input");
        expect(await question.run()).toBe(false);
      }
    } finally {
      f.mac.close();
    }
  });

for (const kind of ["message", "question"] as const)
  test(`actual version11 replacement requires new consent before fresh ${kind} delivery and old recovery stays historical`, async ({
    page,
  }) => {
    const f = await setup(page, "key-boundary", kind === "question");
    try {
      const oldWire = await f.offer.message("SYNTHETIC_OLD_KEY_HISTORY");
      const old = await page.evaluate(
        async (keyId) => ({
          code: window.browserPeersTest.recoveryCode(),
          kit: await window.browserPeersTest.recovery(keyId),
        }),
        f.local.keyId,
      );
      await reopen(page, f.f);
      const upgraded = await inspect(page);
      const recovered = await page.evaluate(
        ({ code, kit }) => window.browserPeersTest.checkRecovery(kit, code),
        old,
      );
      expect(recovered.publicKey).toBe(f.local.publicKey);
      expect(recovered.privateExtractable).toBe(false);
      await expect(accept(page, f, oldWire)).rejects.toThrow("DENIED");
      expect(await inspect(page)).toEqual(upgraded);

      const replacement = await page.evaluate(() =>
        window.browserPeersTest.activate(),
      );
      expect(replacement.keyEpoch).toBe(f.local.keyEpoch + 1);
      expect(replacement.publicKey).not.toBe(f.local.publicKey);
      await expect(accept(page, f, oldWire)).rejects.toThrow("CONFLICT");
      await expect(prepare(page, f)).rejects.toThrow("CONFLICT");
      expect((await inspect(page)).count).toBe(0);
      expect(
        await page.evaluate(
          (id) => window.browserPeersTest.recovery(id),
          f.local.keyId,
        ),
      ).toEqual(old.kit);
      const retiredInvitation = await f.mac.invitation();
      await page.evaluate(async () => {
        const api = window.browserPeersTest;
        return api.reset({
          expectedRevision: (await api.status()).revision,
          confirmed: true,
        });
      });
      await expect(
        page.evaluate(
          (invitation) => window.browserPeersTest.prepare(invitation),
          retiredInvitation.invitation,
        ),
      ).rejects.toThrow("DENIED");
      await f.mac.activate();
      const newMacKey = (await f.mac.keys.resolve()).proof;
      expect(newMacKey.keyEpoch).toBe(f.pin.keyEpoch + 1);
      // Re-pin both directions against the new local proof, then run the real
      // challenge/response protocol. Neither step renews conversation consent.
      const outgoing = await page.evaluate(
        (id) =>
          window.browserPeersTest.invitation({
            recipientId: id,
            confirmed: true,
          }),
        f.mac.binding.deviceId,
      );
      const macReview = await f.mac.peers.prepare(outgoing.invitation);
      f.mac.peers.approve({
        reviewId: macReview.reviewId,
        expectedRevision: macReview.expectedRevision,
        comparedFingerprint: outgoing.fingerprint,
        confirmed: true,
      });
      const macInvitation = await f.mac.invitation();
      const browserReview = await page.evaluate(
        (invitation) => window.browserPeersTest.prepare(invitation),
        macInvitation.invitation,
      );
      const pin = await page.evaluate(
        (review) =>
          window.browserPeersTest.approve({
            reviewId: review.reviewId,
            expectedRevision: review.expectedRevision,
            comparedFingerprint: review.fingerprint,
            confirmed: true,
          }),
        browserReview,
      );
      const start = await page.evaluate(async (peerId) => {
        const api = window.browserPeersTest;
        return api.checkBegin({
          peerId,
          expectedKeyRevision: (await api.keyStatus()).revision,
          expectedPeerRevision: (await api.status()).revision,
          confirmed: true,
        });
      }, f.mac.binding.deviceId);
      const challenge = await page.evaluate(
        (id) => window.browserPeersTest.checkEnvelope({ id, confirmed: true }),
        start.id,
      );
      const response = await f.mac.checks.respond({
        envelope: challenge,
        confirmed: true,
      });
      const responseWire = await f.mac.checks.delivery({
        id: response.id,
        confirmed: true,
      });
      await page.evaluate(
        (envelope) =>
          window.browserPeersTest.checkComplete({ envelope, confirmed: true }),
        responseWire,
      );
      const macCheck = await f.mac.checks.begin({
        peerId: f.f.binding.deviceId,
        expectedKeyRevision: f.mac.keys.list().revision,
        expectedPeerRevision: f.mac.peers.list().revision,
        confirmed: true,
      });
      const macChallenge = await f.mac.checks.delivery({
        id: macCheck.id,
        confirmed: true,
      });
      const browserResponse = await page.evaluate(
        (envelope) =>
          window.browserPeersTest.checkRespond({ envelope, confirmed: true }),
        macChallenge,
      );
      const browserWire = await page.evaluate(
        (id) => window.browserPeersTest.checkEnvelope({ id, confirmed: true }),
        browserResponse.id,
      );
      await f.mac.checks.complete({ envelope: browserWire, confirmed: true });
      await expect(prepare(page, f)).rejects.toThrow("DENIED");
      await expect(accept(page, f, oldWire)).rejects.toThrow("DENIED");

      const offer = await f.mac.conversationOffer(undefined, {
        questions: kind === "question",
      });
      const grant = await page.evaluate(
        async ({ envelope, permissions, peerId, peerKeyEpoch, now }) => {
          const api = window.browserPeersTest;
          const review = await api.conversationPrepare({
            expectedRevision: (await api.conversationStatus()).revision,
            envelope,
            permissions,
            peerId,
            peerKeyEpoch,
            expiresAt: now + 240000,
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
          permissions: offer.data.permissions,
          peerId: pin.peerId,
          peerKeyEpoch: pin.keyEpoch,
          now: f.f.now,
        },
      );
      const next = { ...f, offer, grant, pin, local: replacement };
      const worker = kind === "question" ? await offer.question() : null;
      const envelope =
        worker?.envelope ?? (await offer.message("SYNTHETIC_NEW_KEY_MESSAGE"));
      const accepted = await accept(page, next, envelope);
      expect(accepted.duplicate).toBe(false);
      expect((await read(page, accepted.entry)).content.type).toBe(
        `conversation.${kind}`,
      );
      const beforeDuplicate = await inspect(page);
      expect((await accept(page, next, envelope)).duplicate).toBe(true);
      expect(await inspect(page)).toEqual(beforeDuplicate);
      const reply = await prepare(page, next, {
        parentId: accepted.entry.id,
        content: "SYNTHETIC_ORDINARY_REPLY",
      });
      const replyWire = await wire(page, reply);
      expect((await offer.receive(replyWire)).duplicate).toBe(false);
      if (worker) {
        expect(worker.task().status).toBe("awaiting_input");
        const answer = await prepare(page, next, {
          kind: "answer",
          parentId: accepted.entry.id,
          content: "Lisbon",
        });
        const answerWire = await wire(page, answer);
        expect((await offer.receive(answerWire)).duplicate).toBe(false);
        expect(worker.task().status).toBe("queued");
        await worker.run();
        expect(worker.task().status).toBe("completed");
        const calls = worker.calls();
        expect((await offer.receive(answerWire)).duplicate).toBe(true);
        await worker.run();
        expect(worker.calls()).toBe(calls);
      }
      await reopen(page, f.f);
      expect((await accept(page, next, envelope)).duplicate).toBe(true);
      expect(await wire(page, { ...reply, revision: 2 })).toEqual(replyWire);
      const beforeRecovery = await inspect(page);
      expect(
        (
          await page.evaluate(
            ({ code, kit }) => window.browserPeersTest.checkRecovery(kit, code),
            old,
          )
        ).publicKey,
      ).toBe(f.local.publicKey);
      await expect(accept(page, f, oldWire)).rejects.toThrow("DENIED");
      expect(await inspect(page)).toEqual(beforeRecovery);
      expect(
        (await page.evaluate(() => window.browserPeersTest.key())).proof,
      ).toEqual(replacement);
      expect(
        await page.evaluate(
          (id) => window.browserPeersTest.recovery(id),
          f.local.keyId,
        ),
      ).toEqual(old.kit);
    } finally {
      f.mac.close();
    }
  });

test("actual version15 browser storage preserves encrypted content and replay while adding empty resume consent", async ({
  page,
}) => {
  const f = await setup(page, "resume");
  try {
    const prepared = await prepare(page, f),
      envelope = await wire(page, prepared),
      before = await inspect(page);
    expect(before.version).toBe(15);
    const grants = await page.evaluate(() =>
      window.browserPeersTest.conversationStatus(),
    );
    await reopen(page, f.f);
    const upgraded = await inspect(page);
    expect(upgraded.version).toBe(20);
    expect(JSON.parse(upgraded.all)).toEqual({
      ...JSON.parse(before.all),
      resume_consents: [],
      resume_delivery: [],
      autonote_approval_inbox: [],
      autonote_approval_decisions: [],
    });
    expect(
      await page.evaluate(() => window.browserPeersTest.conversationStatus()),
    ).toEqual(grants);
    expect(
      (await page.evaluate(() => window.browserPeersTest.resumeStatus()))
        .grants,
    ).toEqual([]);
    expect(await wire(page, await read(page, prepared))).toEqual(envelope);
    await expect(reopen(page, f.f, "resume")).rejects.toThrow(
      "STORAGE_UNAVAILABLE",
    );
    await reopen(page, f.f);
    expect(await wire(page, await read(page, prepared))).toEqual(envelope);
  } finally {
    f.mac.close();
  }
});

test("actual version16 storage preserves resume consent, encrypted content and replay while adding empty resume delivery", async ({
  page,
}) => {
  const f = await setup(page, "resume-delivery");
  try {
    const prepared = await prepare(page, f),
      envelope = await wire(page, prepared);
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
    const before = await inspect(page);
    expect(before.version).toBe(16);
    const permissions = await page.evaluate(() =>
      window.browserPeersTest.resumeStatus(),
    );
    expect(permissions.grants).toEqual([grant]);
    await reopen(page, f.f);
    const after = await inspect(page);
    expect(after.version).toBe(20);
    expect(JSON.parse(after.all)).toEqual({
      ...JSON.parse(before.all),
      resume_delivery: [],
      autonote_approval_inbox: [],
      autonote_approval_decisions: [],
    });
    expect(
      await page.evaluate(() => window.browserPeersTest.resumeStatus()),
    ).toEqual(permissions);
    expect(await wire(page, await read(page, prepared))).toEqual(envelope);
    await expect(reopen(page, f.f, "resume-delivery")).rejects.toThrow(
      "STORAGE_UNAVAILABLE",
    );
    await reopen(page, f.f);
    expect(
      await page.evaluate(() => window.browserPeersTest.resumeStatus()),
    ).toEqual(permissions);
    expect(await wire(page, await read(page, prepared))).toEqual(envelope);
    expect(offer.task().status).toBe("paused");
  } finally {
    f.mac.close();
  }
});
