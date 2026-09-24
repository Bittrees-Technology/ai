import { randomUUID } from "node:crypto";
import { macConversationRelayFixture } from "./mac-conversation-relay.js";
import {
  privateEnvelopeSuite,
  sealPrivateEnvelope,
} from "../../modules/remote/private-envelope.js";

export async function macConversationReceiveFixture(questions = false) {
  const g = await macConversationRelayFixture(true, questions);
  const permission = g.e.store.exportPrivateConversationConsent(g.e.owner)
    .grants[0]!;
  let sequence = 100;
  const envelope = (body: any) =>
    g.f.a.remote.withVerifiedDevice((a) =>
      g.e.remote.withVerifiedDevice(async (b) => {
        const sender = await g.f.a.keys(a.current).resolve(),
          recipient = await g.e.keys(b.current).resolve();
        return sealPrivateEnvelope(
          {
            version: 1,
            suite: privateEnvelopeSuite,
            ownerId: g.e.grant.ownerId,
            senderId: g.f.a.grant.deviceId,
            recipientId: g.e.grant.deviceId,
            senderKeyEpoch: 1,
            recipientKeyEpoch: 1,
            messageId: randomUUID(),
            operationId: body.operationId ?? body.id,
            sequence: sequence++,
            issuedAt: g.f.clock(),
            expiresAt: g.f.clock() + 60000,
          },
          new TextEncoder().encode(JSON.stringify(body)),
          {
            senderKey: sender.pair,
            recipientPublicKey: recipient.pair.publicKey,
          },
          g.f.clock,
        );
      }),
    );
  const scope = {
    permissionId: permission.id,
    conversationRef: permission.conversationRef,
  };
  const message = (parentId: string | null = null) => ({
    version: 1,
    type: "conversation.message",
    scope,
    id: randomUUID(),
    parentId,
    content: "SYNTHETIC_RELAY_CONVERSATION",
  });
  const query = () => ({
    connection: g.input().connection,
    after: null,
    confirmed: true as const,
  });
  const inspect = () =>
    g.e.controls.inspectRelayedConversation(g.relay, query());
  const selected = async (
    target: any = { action: "receive", permissionId: permission.id },
  ) => ({
    ...query(),
    selection: (await inspect()).item!.selection,
    target,
  });
  const check = async (raw?: any) =>
    g.e.controls.receiveRelayedConversation(g.relay, raw ?? (await selected()));
  const messages = () =>
    g.e.store.messages(g.e.owner, g.inbox.id, g.conversationId);
  // Every fixture may override this with a stronger per-operation assertion.
  g.control.beforeAck = () => {
    if (!g.e.store.exportPrivateConversationContent(g.e.owner).length)
      throw Error(
        "Expected durable conversation outcome before acknowledgement",
      );
  };
  return {
    ...g,
    get relay() {
      return g.relay;
    },
    permission,
    scope,
    envelope,
    message,
    query,
    inspect,
    selected,
    check,
    messages,
  };
}
