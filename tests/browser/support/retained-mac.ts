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
  const store = new Store(join(dir, "tasks.db"), vault, () => now);
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
    () => now,
  );
  const peers = new PrivatePeerEnrollment(
    store,
    vault,
    owner,
    () => binding,
    () => now,
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
    () => now,
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
  return {
    binding,
    consent,
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
        check() {
          const r = record();
          return controls.checkRelayedTask(relay, {
            id: r.id,
            expectedRevision: r.revision,
            after: null,
            confirmed: true,
          });
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
        () => now,
      );
      const receipt = await receiver.accept(envelope);
      const responses = new PrivateTaskResponses(
        store,
        vault,
        owner,
        () => binding,
        providers.respond,
        () => now,
      );
      const accepted = await responses.prepare({
        operationId: receipt.header.operationId,
        peerId,
        kind: "accepted",
        confirmed: true,
      });
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
      () => now,
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
