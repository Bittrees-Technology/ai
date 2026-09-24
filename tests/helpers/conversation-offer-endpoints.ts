import { randomUUID } from "node:crypto";
import { privateEndpoints } from "./private-endpoints.js";
export async function conversationOfferEndpoints() {
  const f = await privateEndpoints(),
    e = f.b;
  const inbox = {
    id: "personal",
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
      content: "SYNTHETIC_NEVER_IN_OFFER",
    },
    randomUUID(),
  );
  const status = e.controls.conversationPermissionStatus();
  const permission = await e.controls.prepareConversationPermission({
    action: "grant",
    expectedRevision: status.revision,
    expectedKeyRevision: status.keyRevision,
    expectedPeerRevision: status.peerRevision,
    peerId: f.a.grant.deviceId,
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
  const approved = await e.controls.confirmConversationPermission({
    reviewId: permission.id,
    confirmed: true,
    acknowledged: true,
  });
  const input = {
    action: "create",
    permissionId: approved.grants[0]!.id,
    expectedConsentRevision: approved.revision,
  };
  const prepare = (overrides = {}) =>
    e.controls.prepareConversationOffer({ ...input, ...overrides });
  const confirm = (id: string) =>
    e.controls.confirmConversationOffer({
      reviewId: id,
      confirmed: true,
      acknowledged: true,
    });
  return { ...f, e, input, prepare, confirm, inbox, conversationId };
}
