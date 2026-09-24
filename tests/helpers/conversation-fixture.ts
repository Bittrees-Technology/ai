import { PrivatePeerChecks } from "../../modules/remote/private-peer-checks.js";
import { peerCheckResponse } from "./peer-check-response.js";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../modules/storage/store.js";
import { Vault } from "../../modules/storage/vault.js";
import { PrivateConversationConsent } from "../../modules/remote/private-conversation-consent.js";
import { PrivateKeyLifecycle } from "../../modules/remote/private-key-lifecycle.js";
import { PrivatePeerEnrollment } from "../../modules/remote/private-peers.js";
export const owner = { userId: "synthetic", tenantId: "personal" };
class Slot {
  value?: Uint8Array;
  beforeRead?: () => Promise<void>;
  async getSecret() {
    await this.beforeRead?.();
    return this.value?.slice();
  }
  async addSecretIfAbsent(v: Uint8Array) {
    if (this.value) return false;
    this.value = Uint8Array.from(v);
    return true;
  }
  async deleteCredential() {
    this.value = undefined;
    return true;
  }
}
export async function conversationFixture() {
  const dir = mkdtempSync(join(tmpdir(), "conversation-consent-")),
    path = join(dir, "tasks.db"),
    vault = new Vault(randomBytes(32));
  let now = 1800000000000,
    monotonic = 0;
  const clock = () => now,
    store = new Store(path, vault, clock);
  const binding = {
    ownerId: randomUUID(),
    deviceId: randomUUID(),
    credentialEpoch: 1,
    expiresAt: now + 3600000,
  };
  let live: typeof binding | null = binding;
  const current = () => live,
    slots = new Map<string, { key: Slot; attempt: Slot; deleted: Slot }>();
  const entries = (id: string) => {
    if (!slots.has(id))
      slots.set(id, {
        key: new Slot(),
        attempt: new Slot(),
        deleted: new Slot(),
      });
    return slots.get(id)!;
  };
  const build = (s = store, scope = owner) => {
    const keys = new PrivateKeyLifecycle(
        s,
        vault,
        scope,
        current,
        entries,
        undefined,
        clock,
      ),
      peers = new PrivatePeerEnrollment(s, vault, scope, current, clock);
    return {
      keys,
      peers,
      consent: new PrivateConversationConsent(
        s,
        vault,
        scope,
        current,
        keys,
        peers,
        clock,
        () => monotonic,
      ),
    };
  };
  const { keys, peers, consent } = build();
  const reserved = keys.begin({ expectedRevision: 0, confirmed: true });
  await keys.provision({
    keyId: reserved.keyId,
    expectedRevision: reserved.revision,
    confirmed: true,
  });
  const sender = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    ),
    peerId = randomUUID();
  const review = await peers.prepare({
    version: 1,
    ownerId: binding.ownerId,
    recipientId: binding.deviceId,
    peerId,
    keyEpoch: 1,
    publicKey: Buffer.from(
      await crypto.subtle.exportKey("raw", sender.publicKey),
    ).toString("base64url"),
    nonce: randomUUID(),
    issuedAt: now,
    expiresAt: now + 300000,
  });
  peers.approve({
    reviewId: review.reviewId,
    expectedRevision: review.expectedRevision,
    comparedFingerprint: review.fingerprint,
    confirmed: true,
  });
  const checks = new PrivatePeerChecks(
    store,
    vault,
    owner,
    current,
    keys,
    peers,
    clock,
  );
  const check = await checks.begin({
    peerId,
    expectedKeyRevision: keys.list().revision,
    expectedPeerRevision: peers.list().revision,
    confirmed: true,
  });
  const challenge = checks.delivery({ id: check.id, confirmed: true });
  const response = await peerCheckResponse(
    challenge,
    sender,
    (await keys.resolve()).pair.publicKey,
    clock,
  );
  await checks.complete({ envelope: response, confirmed: true });
  const inbox = {
    id: "personal",
    tenantId: owner.tenantId,
    ownerId: owner.userId,
    ownerType: "user" as const,
    memberUserIds: [owner.userId],
  };
  store.createInbox(owner, inbox);
  const conversationId = randomUUID();
  const message = store.appendMessage(
    owner,
    {
      conversationId,
      recipientInboxId: inbox.id,
      content: "SYNTHETIC_THREAD",
      type: "notification",
    },
    randomUUID(),
  );
  const choices = {
    peerId,
    peerKeyEpoch: 1,
    conversationId,
    inboxId: inbox.id,
    permissions: {
      messagesToMac: true,
      messagesToBrowser: true,
      questionsToBrowser: false,
      answersToMac: false,
    },
    expiresAt: now + 600000,
  };
  const prepare = (overrides = {}, c = consent) =>
    c.prepare({
      expectedRevision: c.list().revision,
      choices: { ...choices, ...overrides },
    });
  const approve = (r: Awaited<ReturnType<typeof prepare>>, c = consent) =>
    c.approve({
      reviewId: r.id,
      expectedRevision: r.revision,
      confirmed: true,
      acknowledged: true,
    });
  return {
    dir,
    path,
    store,
    vault,
    clock,
    binding,
    current,
    keys,
    peers,
    consent,
    peerId,
    sender,
    entries,
    slots,
    build,
    inbox,
    message,
    choices,
    prepare,
    approve,
    setBinding: (b: typeof live) => {
      live = b;
    },
    time: (value: number) => {
      now = value;
    },
    monotonic: (value: number) => {
      monotonic = value;
    },
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
