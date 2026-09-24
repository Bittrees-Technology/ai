import { conversationTaskAccess } from "../../../apps/companion/conversation-access.js";
import { SourceTasks } from "../../../modules/connectors/source-tasks.js";
import { PrivateConversationContent } from "../../../modules/remote/private-conversation-content.js";
import { PrivateConversationConsent } from "../../../modules/remote/private-conversation-consent.js";
import { PrivateConversationOffers } from "../../../modules/remote/private-conversation-offers.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { localApi } from "../../../apps/companion/http.js";
import { RemoteClient } from "../../../modules/remote/client.js";
import { CompanionPrivateKeys } from "../../../apps/companion/private-keys.js";
import { CompanionPrivateRelay } from "../../../apps/companion/private-relay.js";
import { PrivateTaskConsent } from "../../../modules/remote/private-task-consent.js";
import { PrivateTaskReceiver } from "../../../modules/remote/private-task-receiver.js";
import { PrivateTaskResponses } from "../../../modules/remote/private-task-responses.js";
import { LocalWorker } from "../../../apps/companion/worker.js";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../../modules/storage/store.js";
import { Vault } from "../../../modules/storage/vault.js";
import { PrivateKeyLifecycle } from "../../../modules/remote/private-key-lifecycle.js";
import { PrivatePeerChecks } from "../../../modules/remote/private-peer-checks.js";
import { PrivatePeerEnrollment } from "../../../modules/remote/private-peers.js";
import type { PrivateBinding } from "../../../modules/remote/private-peer-contracts.js";
import type { PrivateKeyEntries } from "../../../modules/remote/private-endpoint-keys.js";
class Slot {
  private bytes?: Uint8Array;
  async getSecret() {
    return this.bytes ? Uint8Array.from(this.bytes) : undefined;
  }
  async addSecretIfAbsent(bytes: Uint8Array) {
    if (this.bytes) return false;
    // Buffer.slice() shares memory; the actual provider wipes its owned buffers.
    this.bytes = Uint8Array.from(bytes);
    return true;
  }
  async deleteCredential() {
    const found = !!this.bytes;
    this.bytes?.fill(0);
    this.bytes = undefined;
    return found;
  }
}
/** Actual Mac lifecycle/peer modules with disposable encrypted SQLite and
 * simulated native slots. Never reads the user's Keychain or installed app. */
export async function retainedMac(
  browser: PrivateBinding,
  now: number,
  registered?: PrivateBinding,
) {
  const dir = mkdtempSync(join(tmpdir(), "bittrees-browser-peer-mac-")),
    vault = new Vault(randomBytes(32));
  const owner = { userId: randomUUID(), tenantId: "synthetic-browser-peer" };
  let liveClock = false;
  const clock = () => (liveClock ? Date.now() : now);
  const store = new Store(join(dir, "tasks.db"), vault, clock);
  const binding = registered
    ? { ...registered }
    : { ...browser, deviceId: randomUUID() };
  if (
    binding.ownerId !== browser.ownerId ||
    binding.deviceId === browser.deviceId
  ) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    throw Error("Invalid synthetic Mac registration");
  }
  const slots = new Map<string, PrivateKeyEntries>();
  const entries = (id: string) => {
    let value = slots.get(id);
    if (!value) {
      value = { key: new Slot(), attempt: new Slot(), deleted: new Slot() };
      slots.set(id, value);
    }
    return value;
  };
  const keys = new PrivateKeyLifecycle(
    store,
    vault,
    owner,
    () => binding,
    entries,
    () => true,
    clock,
  );
  const peers = new PrivatePeerEnrollment(
    store,
    vault,
    owner,
    () => binding,
    clock,
  );
  const activate = async () => {
    const slot = keys.begin({
      expectedRevision: keys.list().revision,
      confirmed: true,
    });
    return keys.provision({
      keyId: slot.keyId,
      expectedRevision: slot.revision,
      confirmed: true,
    });
  };
  try {
    await activate();
  } catch (e) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const consent = new PrivateTaskConsent(
    store,
    vault,
    owner,
    () => binding,
    keys,
    peers,
    clock,
  );
  const profile = {
    id: "synthetic-browser-tasks",
    runtime: "ollama" as const,
    model: "synthetic",
    contextTokens: 4096,
    maxOutputTokens: 512,
    temperature: 0.2,
  };
  store.addProfile(owner, profile);
  const work = async () => {
    const worker = new LocalWorker(
      store,
      owner,
      {
        pin: async () => ({ profile, digest: "a".repeat(64) }),
        generate: async () =>
          "Synthetic result from independently consented Mac task.",
      },
      (id) => store.profile(owner, id),
    );
    await worker.runOnce();
  };
  return {
    binding,
    consent,
    work,
    async conversationOffer(
      deliveryExpiresAt?: number,
      options: { questions?: boolean } = {},
    ) {
      const conversationId = randomUUID(),
        inboxId = options.questions ? "personal" : "conversation-offer-pilot";
      store.createInbox(owner, {
        id: inboxId,
        tenantId: owner.tenantId,
        ownerId: owner.userId,
        ownerType: "user",
        memberUserIds: [owner.userId],
      });
      store.appendMessage(
        owner,
        {
          conversationId,
          recipientInboxId: inboxId,
          type: "notification",
          content: "Synthetic offer thread",
        },
        randomUUID(),
      );
      const consent = new PrivateConversationConsent(
          store,
          vault,
          owner,
          () => binding,
          keys,
          peers,
          clock,
        ),
        browserKey = peers
          .list()
          .peers.find((p) => p.peerId === browser.deviceId)!,
        review = await consent.prepare({
          expectedRevision: consent.list().revision,
          choices: {
            peerId: browser.deviceId,
            peerKeyEpoch: browserKey.keyEpoch,
            conversationId,
            inboxId,
            permissions: {
              messagesToMac: true,
              messagesToBrowser: true,
              questionsToBrowser: true,
              answersToMac: true,
            },
            expiresAt: Math.min(
              clock() + 300000,
              deliveryExpiresAt ?? Infinity,
            ),
          },
        }),
        saved = consent.approve({
          reviewId: review.id,
          expectedRevision: review.revision,
          confirmed: true,
          acknowledged: true,
        }),
        offers = new PrivateConversationOffers(
          store,
          vault,
          owner,
          consent,
          clock,
        ),
        reserved = await offers.prepare({
          clientRequestId: randomUUID(),
          permissionId: saved.grant.id,
          expectedConsentRevision: saved.revision,
          confirmed: true,
        }),
        ready = await offers.resume({
          id: reserved.id,
          expectedRevision: reserved.revision,
          confirmed: true,
        }),
        envelope = await offers.delivery({
          id: ready.id,
          expectedRevision: ready.revision,
          confirmed: true,
        });
      const engine = new PrivateConversationContent(
        store,
        vault,
        owner,
        consent,
        keys,
        conversationTaskAccess(
          store,
          owner,
          new SourceTasks(),
          undefined,
          clock,
        ),
        clock,
      );
      const messageIds = new Map<string, string>();
      return {
        data: ready.value.offer,
        envelope,
        original: (id: string) =>
          engine.seal({
            permissionId: saved.grant.id,
            id,
            expectedRevision: 2,
            confirmed: true,
          }),
        async question() {
          if (!options.questions)
            throw Error("Question fixture was not enabled");
          const task = store.create(
            owner,
            {
              conversationId,
              kind: "query",
              prompt: "Prepare a travel checklist",
              modelProfileId: profile.id,
              allowQuestions: true,
            },
            randomUUID(),
          );
          let calls = 0;
          const worker = new LocalWorker(
            store,
            owner,
            {
              pin: async () => ({ profile, digest: "c".repeat(64) }),
              generate: async (_model, prompt, _signal, format) => {
                calls++;
                if (format)
                  return JSON.stringify(
                    calls === 1
                      ? {
                          decision: "ask",
                          question: "Where are you travelling?",
                        }
                      : { decision: "continue" },
                  );
                if (!prompt.includes("Lisbon"))
                  throw Error("Exact browser answer not supplied to worker");
                return "Bring a map of Lisbon.";
              },
            },
            () => profile,
          );
          await worker.runOnce();
          const wait = store.inputWaitHistory(owner, task.id)[0];
          if (!wait || store.get(owner, task.id).status !== "awaiting_input")
            throw Error("Worker did not ask its question");
          const entry = await engine.prepare({
            id: randomUUID(),
            permissionId: saved.grant.id,
            expectedConsentRevision: consent.list().revision,
            localMessageId: wait.questionId,
            parentId: null,
            kind: "question",
            expiresAt: Math.min(clock() + 120000, wait.deadline),
            confirmed: true,
          });
          const envelope = await engine.seal({
            permissionId: saved.grant.id,
            id: entry.value.content.id,
            expectedRevision: entry.revision,
            confirmed: true,
          });
          messageIds.set(entry.value.content.id, wait.questionId);
          return {
            envelope,
            task: () => store.get(owner, task.id),
            run: () => worker.runOnce(),
            calls: () => calls,
          };
        },
        async message(text: string, parentId: string | null = null) {
          const local = store.appendMessage(
            owner,
            {
              conversationId,
              recipientInboxId: inboxId,
              type: "notification",
              content: text,
              ...(parentId ? { replyToId: messageIds.get(parentId) } : {}),
            },
            randomUUID(),
          );
          const localId = local.id;
          const entry = await engine.prepare({
            id: randomUUID(),
            permissionId: saved.grant.id,
            expectedConsentRevision: consent.list().revision,
            localMessageId: localId,
            parentId,
            kind: "message",
            expiresAt: clock() + 120000,
            confirmed: true,
          });
          const sealed = await engine.seal({
            permissionId: saved.grant.id,
            id: entry.value.content.id,
            expectedRevision: entry.revision,
            confirmed: true,
          });
          messageIds.set(entry.value.content.id, localId);
          return sealed;
        },
        async receipt(incoming: unknown) {
          const { entry } = await engine.accept({
            permissionId: saved.grant.id,
            envelope: incoming,
            confirmed: true,
          });
          return engine.seal({
            permissionId: saved.grant.id,
            id: entry.value.content.id,
            expectedRevision: entry.revision,
            confirmed: true,
          });
        },
        async receive(incoming: unknown) {
          const accepted = await engine.accept({
            permissionId: saved.grant.id,
            envelope: incoming,
            confirmed: true,
          });
          messageIds.set(
            accepted.entry.value.content.id,
            accepted.entry.value.localMessageId,
          );
          return accepted;
        },
      };
    },
    async connectRelay(
      device: {
        ownerId: string;
        deviceId: string;
        epoch: number;
        credential: string;
        expiresAt: number;
        scope: string;
      },
      transport: typeof fetch,
      permissionId: string,
    ) {
      if (
        device.ownerId !== binding.ownerId ||
        device.deviceId !== binding.deviceId ||
        device.epoch !== binding.credentialEpoch ||
        device.expiresAt !== binding.expiresAt
      )
        throw Error("Native registration must match retained endpoint");
      // Native HTTP identity and SQLite/worker timestamps use the same live clock.
      liveClock = true;
      let saved: Uint8Array | undefined = new TextEncoder().encode(
        JSON.stringify({
          localOwner: owner.userId,
          grant: device,
          mode: "active",
          sequence: 1,
        }),
      );
      const remote = new RemoteClient(
        owner.userId,
        {
          async getSecret() {
            return saved ? Uint8Array.from(saved) : undefined;
          },
          async setSecret(value) {
            saved = Uint8Array.from(value);
          },
          async deleteCredential() {
            saved = undefined;
            return true;
          },
        },
        transport,
      );
      const controls = new CompanionPrivateKeys(
        store,
        vault,
        owner,
        entries,
        remote,
        true,
        Date.now,
        true,
        {
          enabled: true,
          taskAccess: conversationTaskAccess(
            store,
            owner,
            new SourceTasks(),
            undefined,
            clock,
          ),
        },
      );
      const relaySlots = new Map<string, PrivateKeyEntries>();
      const relay = new CompanionPrivateRelay(
        store,
        vault,
        owner,
        {
          forSlot(_owner, id) {
            let value = relaySlots.get(id);
            if (!value) {
              value = {
                key: new Slot(),
                attempt: new Slot(),
                deleted: new Slot(),
              };
              relaySlots.set(id, value);
            }
            return value;
          },
        },
        remote,
        true,
        Date.now,
        () => performance.now(),
        transport,
      );
      const review = await relay.prepare({ action: "accept", permissionId });
      await relay.confirm({
        reviewId: review.id,
        confirmed: true,
        acknowledged: true,
      });
      const record = () => relay.status().state.items[0]!;
      return {
        controls,
        relay,
        record,
        inspect(after: any = null) {
          const r = record();
          return controls.inspectRelayedTask(relay, {
            id: r.id,
            expectedRevision: r.revision,
            after,
            confirmed: true,
          });
        },
        check(after: any = null, selection?: any) {
          const r = record();
          return controls.checkRelayedTask(relay, {
            id: r.id,
            expectedRevision: r.revision,
            after,
            ...(selection ? { selection } : {}),
            confirmed: true,
          });
        },
        prepareResponse(operationId: string, kind: "accepted" | "result") {
          const r = record();
          return controls.prepareRelayedResponse(relay, {
            connection: { id: r.id, expectedRevision: r.revision },
            response: {
              operationId,
              peerId: browser.deviceId,
              kind,
              confirmed: true,
            },
            confirmed: true,
          });
        },
        sendResponse(id: string) {
          const r = record(),
            response = controls
              .taskStatus()
              .responses.find((v) => v.id === id)!;
          return controls.sendRelayedResponse(relay, {
            connection: { id: r.id, expectedRevision: r.revision },
            response: {
              id,
              expectedRevision: response.revision,
              confirmed: true,
            },
            confirmed: true,
          });
        },
        async openLocalApi() {
          const server = createServer();
          await new Promise<void>((resolve) =>
            server.listen(0, "127.0.0.1", resolve),
          );
          const port = (server.address() as AddressInfo).port;
          const token = randomBytes(32).toString("hex");
          const origin = `http://127.0.0.1:${port}`;
          server.on(
            "request",
            localApi({
              store,
              owner,
              port,
              token,
              privateKeys: controls,
              privateRelay: relay,
            }),
          );
          const calls: { path: string; method: string; status: number }[] = [];
          // Only these local routes are exposed to the test's rendered Mac panel.
          // The token stays in the Node test process; this is not a native-shell test.
          const allowed = new Set([
            "GET /v1/private-relay",
            "GET /v1/private-tasks",
            "POST /v1/private-relay/cancel-review",
            "POST /v1/private-relay/check-task",
            "POST /v1/private-relay/inspect-conversation",
            "POST /v1/private-relay/check-conversation",
            "POST /v1/private-relay/inspect-task",
            "POST /v1/private-relay/responses/prepare",
            "POST /v1/private-relay/responses/send",
            "POST /v1/private-tasks/responses/stop",
          ]);
          return {
            calls,
            async deniedStatus() {
              const res = await fetch(origin + "/v1/private-tasks");
              return { status: res.status, body: await res.json() };
            },
            async call(path: string, method = "GET", body?: unknown) {
              if (!allowed.has(`${method} ${path}`))
                throw Error("Fixture route denied");
              const res = await fetch(origin + path, {
                method,
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              });
              calls.push({ path, method, status: res.status });
              if (res.status === 204) return;
              const data = await res.json();
              if (!res.ok)
                throw Error(data.error ?? "Local API rejected request");
              return data;
            },
            async close() {
              server.closeAllConnections();
              if (server.listening)
                await new Promise<void>((resolve) =>
                  server.close(() => resolve()),
                );
            },
          };
        },
        tasks: () => store.export(owner),
        task: (id: string) => store.get(owner, id),
      };
    },
    async allowTasks(peerId: string, peerKeyEpoch: number, results = true) {
      const review = await consent.prepare({
        expectedRevision: consent.list().revision,
        choices: {
          peerId,
          peerKeyEpoch,
          receiveTasks: true,
          sendTasks: false,
          sendReceipts: true,
          sendResults: results,
          modelProfileId: profile.id,
          expiresAt: now + 300000,
        },
      });
      return consent.approve({
        reviewId: review.id,
        expectedRevision: review.revision,
        confirmed: true,
        acknowledged: true,
      });
    },
    async executeTask(envelope: unknown) {
      const peerId = browser.deviceId;
      const providers = await consent.resolve(peerId);
      const receiver = new PrivateTaskReceiver(
        store,
        vault,
        owner,
        () => binding,
        providers.receive,
        clock,
      );
      const receipt = await receiver.accept(envelope);
      const responses = new PrivateTaskResponses(
        store,
        vault,
        owner,
        () => binding,
        providers.respond,
        clock,
      );
      const accepted = await responses.prepare({
        operationId: receipt.header.operationId,
        peerId,
        kind: "accepted",
        confirmed: true,
      });
      await work();
      const result = await responses.prepare({
        operationId: receipt.header.operationId,
        peerId,
        kind: "result",
        confirmed: true,
      });
      return {
        receipt,
        acceptance: accepted.value.envelope!,
        result: result.value.envelope!,
        task: store.get(owner, receipt.taskId),
      };
    },
    keys,
    peers,
    checks: new PrivatePeerChecks(
      store,
      vault,
      owner,
      () => binding,
      keys,
      peers,
      clock,
    ),
    activate,
    invitation: (recipientId = browser.deviceId) =>
      keys.invitation({ recipientId, confirmed: true }),
    close() {
      keys.invalidate();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
