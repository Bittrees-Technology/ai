import {
  sealPrivateEnvelope,
  privateEnvelopeSuite,
} from "../../modules/remote/private-envelope.js";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { localApi } from "../../apps/companion/http.js";
import { LocalWorker } from "../../apps/companion/worker.js";
import { macConversationRelayFixture } from "./mac-conversation-relay.js";
import { ConversationContentPanelState } from "../../apps/dashboard/conversation-content-state.js";
export async function macConversationDeliveryFixture(questions = false) {
  const g = await macConversationRelayFixture(true, questions),
    server = createServer(),
    token = randomBytes(32).toString("base64url");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  server.on(
    "request",
    localApi({
      store: g.e.store,
      owner: g.e.owner,
      token,
      port,
      privateKeys: g.e.controls,
      privateRelay: g.relay,
    }),
  );
  const calls: { path: string; method: string; body: any }[] = [];
  const api = async (path: string, method = "GET", body?: unknown) => {
    calls.push({ path, method, body });
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await r.json();
    if (!r.ok) throw Error(JSON.stringify(result));
    return result;
  };
  const permissions = g.e.controls.conversationPermissionStatus(),
    permissionId = g.consent.grants[0]!.id;
  const controller = (
    overrides?: typeof api,
    now = Date.now,
    mono = () => performance.now(),
  ) =>
    new ConversationContentPanelState(
      overrides ?? api,
      { inboxId: g.inbox.id, conversationId: g.conversationId },
      permissions,
      () => {},
      now,
      mono,
    );
  const message = g.e.store.messages(
    g.e.owner,
    g.inbox.id,
    g.conversationId,
  )[0]!;
  const prepare = async (c: ConversationContentPanelState, m = message.id) => {
    await c.refresh();
    await c.prepare(m, permissionId);
    await c.confirm(true, () => true);
  };
  const question = async () => {
    const profile = {
      id: "local",
      runtime: "ollama",
      model: "synthetic",
      contextTokens: 4096,
      maxOutputTokens: 512,
      temperature: 0.2,
    } as const;
    const task = g.e.store.create(
      g.e.owner,
      {
        conversationId: g.conversationId,
        kind: "query",
        prompt: "Plan my trip",
        modelProfileId: "local",
        allowQuestions: true,
      },
      randomUUID(),
    );
    const worker = new LocalWorker(
      g.e.store,
      g.e.owner,
      {
        pin: async () => ({ profile, digest: "c".repeat(64) }),
        generate: async () =>
          JSON.stringify({
            decision: "ask",
            question: "Where are you travelling?",
          }),
      },
      () => profile,
    );
    await worker.runOnce();
    const wait = g.e.store.inputWaitHistory(g.e.owner, task.id)[0]!;
    return { task, wait };
  };
  const incomingReceipt = async () => {
    const id = randomUUID(),
      grant = g.e.store.exportPrivateConversationConsent(g.e.owner).grants[0]!;
    const content = {
      version: 1,
      type: "conversation.message",
      id,
      parentId: null,
      content: "SYNTHETIC_INCOMING_FOR_RECEIPT",
      scope: { permissionId, conversationRef: grant.conversationRef },
    };
    const envelope = await g.f.a.remote.withVerifiedDevice((a) =>
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
            operationId: id,
            messageId: randomUUID(),
            sequence: 1000,
            issuedAt: g.f.clock(),
            expiresAt: g.f.clock() + 60000,
          },
          new TextEncoder().encode(JSON.stringify(content)),
          {
            senderKey: sender.pair,
            recipientPublicKey: recipient.pair.publicKey,
          },
          g.f.clock,
        );
      }),
    );
    const received = await g.e.controls.receiveConversationContent({
      permissionId,
      envelope,
      confirmed: true,
    });
    const sealed = await g.e.controls.conversationContentEnvelope({
      id,
      permissionId,
      expectedRevision: received.entry.revision,
      confirmed: true,
    });
    return { id, envelope: sealed.envelope };
  };
  return {
    ...g,
    port,
    token,
    api,
    calls,
    permissions,
    incomingReceipt,
    permissionId,
    controller,
    message,
    prepare,
    question,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      g.close();
    },
  };
}
