import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { paired } from "./support/retained-browser-task.js";
import { splitAutoNoteApproval } from "../../modules/remote/private-autonote-approval-content.js";
import {
  sealPrivateEnvelope,
  privateEnvelopeSuite,
} from "../../modules/remote/private-envelope.js";
test("encrypted AutoNote notes retain partial progress, exact replay and complete review across reopen", async ({
  page,
}) => {
  const f = await paired(page);
  try {
    await f.proveBrowser();
    const now = f.f.now,
      meetingId = randomUUID(),
      proposal = {
        operationId: randomUUID(),
        meetingId,
        version: 1,
        projectionHash: "a".repeat(64),
        summary: [{ text: "Synthetic plan", evidence: ["s1"] }],
        actions: [],
      };
    const detail = {
      id: randomUUID(),
      digest: createHash("sha256")
        .update(JSON.stringify(proposal))
        .digest("hex"),
      expiresAt: new Date(now + 600000).toISOString(),
      meetingId,
      title: "Retained synthetic meeting",
      visibility: "workspace",
      proposal,
      notes: {
        summary: "Retained context",
        topics: [],
        decisions: [],
        actions: Array.from({ length: 10 }, (_, i) => ({
          id: String(i),
          text: "🌳".repeat(1900),
          evidence: ["s1"],
          owner: null,
          dueDate: null,
          status: "proposed",
        })),
        questions: [],
        recommendations: [],
      },
    };
    const offerId = randomUUID(),
      transfer = await splitAutoNoteApproval(
        detail,
        {
          offerId,
          permissionId: randomUUID(),
          sourceApprovalId: randomUUID(),
          grantId: randomUUID(),
          issuedAt: now,
          expiresAt: now + 240000,
        },
        () => now,
      );
    const key = await f.mac.keys.resolve(),
      peer = await f.mac.peers.resolve(f.f.binding.deviceId, f.local.keyEpoch);
    let sequence = 100;
    const envelopes: Awaited<ReturnType<typeof sealPrivateEnvelope>>[] = [];
    for (const packet of [transfer.manifest, ...transfer.chunks])
      envelopes.push(
        await sealPrivateEnvelope(
          {
            version: 1,
            suite: privateEnvelopeSuite,
            ownerId: f.f.binding.ownerId,
            senderId: f.mac.binding.deviceId,
            recipientId: f.f.binding.deviceId,
            senderKeyEpoch: key.proof.keyEpoch,
            recipientKeyEpoch: f.local.keyEpoch,
            messageId: randomUUID(),
            operationId: "id" in packet ? packet.id : packet.offerId,
            sequence: sequence++,
            issuedAt: now,
            expiresAt: now + 240000,
          },
          new TextEncoder().encode(JSON.stringify(packet)),
          { senderKey: key.pair, recipientPublicKey: peer.publicKey },
          () => now,
        ),
      );
    const receive = (envelope: (typeof envelopes)[number]) =>
      page.evaluate(
        (envelope) =>
          window.browserPeersTest.approvalReceive({
            envelope,
            confirmed: true,
          }),
        envelope,
      );
    const reveal = () =>
      page.evaluate(
        (offerId) =>
          window.browserPeersTest.approvalReveal({ offerId, confirmed: true }),
        offerId,
      );
    await expect(receive(envelopes[1]!)).rejects.toThrow();
    await receive(envelopes[0]!);
    await expect(reveal()).rejects.toThrow();
    await receive(envelopes[1]!);
    await page.evaluate(() => window.browserPeersTest.approvalReopen());
    expect(
      (await page.evaluate(() => window.browserPeersTest.approvalStatus()))[0],
    ).toMatchObject({ offerId, received: 2 });
    expect((await receive(envelopes[1]!)).duplicate).toBe(true);
    for (const envelope of envelopes.slice(2).reverse())
      await receive(envelope);
    expect((await reveal()).detail).toEqual(detail);
    const exported = await page.evaluate(
      (offerId) =>
        window.browserPeersTest.approvalExport({ offerId, confirmed: true }),
      offerId,
    );
    expect(exported.envelopes.length).toBe(envelopes.length);
    expect(JSON.stringify(exported)).not.toContain(detail.title);
    await page.evaluate(
      (offerId) =>
        window.browserPeersTest.approvalRemove({ offerId, confirmed: true }),
      offerId,
    );
    await expect(reveal()).rejects.toThrow();
    await expect(receive(envelopes[0]!)).rejects.toThrow();
  } finally {
    f.mac.close();
  }
});
