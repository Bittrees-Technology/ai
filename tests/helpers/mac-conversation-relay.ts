import { randomUUID } from "node:crypto";
import { macRelayFixture } from "./mac-relay.js";

export async function macConversationRelayFixture() {
  const g = await macRelayFixture(),
    e = g.f.b;
  try {
    const inbox = {
      id: "offer-inbox",
      tenantId: e.owner.tenantId,
      ownerId: e.owner.userId,
      ownerType: "user",
      memberUserIds: [e.owner.userId],
    };
    e.store.createInbox(e.owner, inbox);
    const conversationId = randomUUID();
    e.store.appendMessage(
      e.owner,
      {
        conversationId,
        recipientInboxId: inbox.id,
        type: "notification",
        content: "PRIVATE_NEVER_IN_OFFER",
      },
      randomUUID(),
    );
    const status = e.controls.conversationPermissionStatus();
    const review = await e.controls.prepareConversationPermission({
      action: "grant",
      expectedRevision: status.revision,
      expectedKeyRevision: status.keyRevision,
      expectedPeerRevision: status.peerRevision,
      peerId: g.f.a.grant.deviceId,
      peerKeyEpoch: 1,
      conversationId,
      inboxId: inbox.id,
      minutes: 15,
      permissions: {
        messagesToMac: true,
        messagesToBrowser: true,
        questionsToBrowser: false,
        answersToMac: false,
      },
    });
    const consent = await e.controls.confirmConversationPermission({
      reviewId: review.id,
      confirmed: true,
      acknowledged: true,
    });
    const offerReview = await e.controls.prepareConversationOffer({
      action: "create",
      permissionId: consent.grants[0]!.id,
      expectedConsentRevision: consent.revision,
    });
    const offer = await e.controls.confirmConversationOffer({
      reviewId: offerReview.id,
      confirmed: true,
      acknowledged: true,
    });
    const input = () => ({
      action: "send",
      id: offer.offer.id,
      expectedRevision: e.controls
        .conversationOfferStatus()
        .offers.find((o) => o.id === offer.offer.id)!.revision,
      connection: {
        id: g.input().id,
        expectedRevision: g.input().expectedRevision,
      },
    });
    const prepare = (raw = input()) =>
      e.controls.prepareConversationOffer(raw, g.relay);
    const confirm = (reviewId: string) =>
      e.controls.confirmConversationOffer(
        { reviewId, confirmed: true, acknowledged: true },
        g.relay,
      );
    const statusOffer = () =>
      e.controls
        .conversationOfferStatus()
        .offers.find((o) => o.id === offer.offer.id)!;
    return { ...g, e, offer, consent, input, prepare, confirm, statusOffer };
  } catch (err) {
    g.close();
    throw err;
  }
}
