import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { ready, reopen } from "./support/retained-browser-task.js";
import {
  sealPrivateEnvelope,
  openPrivateEnvelope,
  privateEnvelopeSuite,
} from "../../modules/remote/private-envelope.js";

async function setup(page: Page, previous: false | "content" = false) {
  const f = await ready(page, previous);
  try {
    const offer = await f.mac.conversationOffer();
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
      { operationId: f.offer.envelope.header.operationId },
    ]) {
      const b = await incoming(
        f,
        header.operationId ? { id: header.operationId } : {},
        header,
      );
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
    expect(after.version).toBe(13);
    expect(after.count).toBe(0);
    const oldRows = JSON.parse(before.all),
      newRows = JSON.parse(after.all);
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
