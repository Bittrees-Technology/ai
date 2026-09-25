import { conversationTaskAccess } from "../../apps/companion/conversation-access.js";
import { SourceTasks } from "../../modules/connectors/source-tasks.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../modules/storage/store.js";
import { Vault } from "../../modules/storage/vault.js";
import { RemoteClient } from "../../modules/remote/client.js";
import { PrivateKeyLifecycle } from "../../modules/remote/private-key-lifecycle.js";
import { PrivatePeerEnrollment } from "../../modules/remote/private-peers.js";
import { PrivateTaskConsent } from "../../modules/remote/private-task-consent.js";
import { PrivateTaskOutbox } from "../../modules/remote/private-task-outbox.js";
import {
  openPrivateEnvelope,
  type PrivateEnvelope,
} from "../../modules/remote/private-envelope.js";
import type { PrivateBinding } from "../../modules/remote/private-peer-contracts.js";
import { CompanionPrivateKeys } from "../../apps/companion/private-keys.js";
import { LocalWorker } from "../../apps/companion/worker.js";
const profile = {
  id: "local",
  runtime: "ollama",
  model: "synthetic",
  contextTokens: 4096,
  maxOutputTokens: 512,
  temperature: 0.2,
} as const;
class Slot {
  bytes?: Uint8Array;
  beforeRead?: () => Promise<void>;
  async getSecret() {
    await this.beforeRead?.();
    return this.bytes?.slice();
  }
  async addSecretIfAbsent(b: Uint8Array) {
    if (this.bytes) return false;
    this.bytes = Uint8Array.from(b);
    return true;
  }
  async deleteCredential() {
    this.bytes = undefined;
    return true;
  }
}
export async function privateEndpoints(
  verifyKeys = true,
  conversations = false,
  liveClock = false,
) {
  const dir = mkdtempSync(join(tmpdir(), "mac-private-dispatch-")),
    accountId = randomUUID();
  let now = Date.now();
  const clock = () => (liveClock ? Date.now() : now);
  async function endpoint(name: string) {
    const vault = new Vault(randomBytes(32)),
      owner = { userId: name, tenantId: "synthetic" },
      path = join(dir, name + ".db"),
      grant = {
        ownerId: accountId,
        deviceId: randomUUID(),
        epoch: 1,
        credential: randomBytes(32).toString("base64url"),
        expiresAt: now + 3600000,
        scope: "status:publish",
      };
    let store = new Store(path, vault, clock),
      saved: Uint8Array | undefined,
      denied = false,
      identities = 0,
      credentialReads = 0;
    let relayTransport: typeof fetch | undefined;
    let onCredentialRead: (() => void) | undefined;
    store.addProfile(owner, profile);
    const remote = new RemoteClient(
      name,
      {
        async getSecret() {
          credentialReads++;
          onCredentialRead?.();
          return saved?.slice();
        },
        async setSecret(b) {
          saved = Uint8Array.from(b);
        },
        async deleteCredential() {
          saved = undefined;
          return true;
        },
      },
      async (url, init) => {
        const route = new URL(String(url)).pathname;
        if (route.includes("/device/relay/") && relayTransport)
          return relayTransport(url, init);
        if (route.endsWith("/pairings"))
          return Response.json({
            id: randomUUID(),
            approvalCode: randomBytes(32).toString("base64url"),
            expiresAt: now + 300000,
          });
        if (route.endsWith("/redeem")) return Response.json(grant);
        assert.ok(route.endsWith("/identity"));
        identities++;
        return denied
          ? Response.json({ error: "DENIED" }, { status: 403 })
          : Response.json({
              version: 1,
              ownerId: grant.ownerId,
              deviceId: grant.deviceId,
              credentialEpoch: grant.epoch,
              expiresAt: grant.expiresAt,
            });
      },
      clock,
    );
    await remote.begin();
    await remote.finish(accountId);
    const slots = new Map<
      string,
      { key: Slot; attempt: Slot; deleted: Slot }
    >();
    const entries = (id: string) => {
      if (!slots.has(id))
        slots.set(id, {
          key: new Slot(),
          attempt: new Slot(),
          deleted: new Slot(),
        });
      return slots.get(id)!;
    };
    const build = (
      enabled = true,
      online = true,
      otherOwner = owner,
      conversationEnabled = conversations,
    ) =>
      new CompanionPrivateKeys(
        store,
        vault,
        otherOwner,
        entries,
        online ? remote : undefined,
        true,
        clock,
        enabled,
        {
          enabled: conversationEnabled,
          taskAccess: conversationTaskAccess(
            store,
            otherOwner,
            new SourceTasks(),
            undefined,
            clock,
          ),
        },
      );
    let controls = build();
    const review = await controls.prepare({
      action: "create",
      expectedRevision: 0,
    });
    await controls.confirm({
      reviewId: review.id,
      confirmed: true,
      acknowledged: true,
    });
    const keys = (current: () => PrivateBinding | null) =>
      new PrivateKeyLifecycle(
        store,
        vault,
        owner,
        current,
        entries,
        undefined,
        clock,
      );
    const consent = (current: () => PrivateBinding | null) =>
      new PrivateTaskConsent(
        store,
        vault,
        owner,
        current,
        keys(current),
        new PrivatePeerEnrollment(store, vault, owner, current, clock),
        clock,
      );
    return {
      get store() {
        return store;
      },
      get controls() {
        return controls;
      },
      vault,
      owner,
      remote,
      grant,
      relayTransport: (transport: typeof fetch) => {
        relayTransport = transport;
      },
      slots,
      entries,
      build,
      keys,
      consent,
      identities: () => identities,
      deny: () => {
        denied = true;
      },
      readHook: (fn?: () => void) => {
        onCredentialRead = fn;
      },
      reads: () => credentialReads,
      reopen: () => {
        store.close();
        store = new Store(path, vault, clock);
        controls = build();
      },
      close: () => store.close(),
    };
  }
  const a = await endpoint("sender"),
    b = await endpoint("mac");
  async function pin(source: typeof a, dest: typeof a) {
    const invitation = await source.controls.peerInvitation({
      recipientId: dest.grant.deviceId,
      expectedKeyRevision: source.controls.peerStatus().keyRevision,
      confirmed: true,
    });
    const state = dest.controls.peerStatus(),
      review = await dest.controls.preparePeer({
        action: "approve",
        expectedRevision: state.revision,
        expectedKeyRevision: state.keyRevision,
        invitation: invitation.invitation,
      });
    await dest.controls.confirmPeer({
      reviewId: review.id,
      confirmed: true,
      acknowledged: true,
      comparedFingerprint: invitation.fingerprint,
    });
  }
  await pin(a, b);
  await pin(b, a);
  async function verify(source: typeof a, dest: typeof a) {
    const s = source.controls.peerStatus(),
      start = await source.controls.beginPeerCheck({
        peerId: dest.grant.deviceId,
        expectedKeyRevision: s.keyRevision,
        expectedPeerRevision: s.revision,
        confirmed: true,
      });
    const challenge = await source.controls.peerCheckEnvelope({
      id: start.id,
      confirmed: true,
    });
    const response = await dest.controls.respondPeerCheck({
      envelope: challenge,
      confirmed: true,
    });
    const envelope = await dest.controls.peerCheckEnvelope({
      id: response.id,
      confirmed: true,
    });
    await source.controls.completePeerCheck({ envelope, confirmed: true });
  }
  if (verifyKeys) {
    await verify(a, b);
    await verify(b, a);
  }
  async function grant(
    endpoint: typeof a,
    peer: typeof a,
    incoming: boolean,
    overrides = {},
  ) {
    const s = endpoint.controls.permissionStatus();
    const review = await endpoint.controls.preparePermission({
      action: "grant",
      expectedRevision: s.revision,
      expectedKeyRevision: s.keyRevision,
      expectedPeerRevision: s.peerRevision,
      peerId: peer.grant.deviceId,
      peerKeyEpoch: 1,
      minutes: 15,
      receiveTasks: incoming,
      sendTasks: !incoming,
      sendReceipts: incoming,
      sendResults: incoming,
      modelProfileId: incoming ? profile.id : null,
      ...overrides,
    });
    return endpoint.controls.confirmPermission({
      reviewId: review.id,
      confirmed: true,
      acknowledged: true,
    });
  }
  if (verifyKeys) {
    await grant(a, b, false);
    await grant(b, a, true);
  }
  const withOutbox = <T>(fn: (outbox: PrivateTaskOutbox) => Promise<T> | T) =>
    a.remote.withVerifiedDevice(async (scope) => {
      const providers = await a
        .consent(scope.current)
        .resolve(b.grant.deviceId);
      return fn(
        new PrivateTaskOutbox(
          a.store,
          a.vault,
          a.owner,
          scope.current,
          providers.send,
          clock,
        ),
      );
    });
  const submit = (prompt = "Synthetic private prompt") =>
    withOutbox(async (outbox) => {
      const row = await outbox.enqueue({
        clientRequestId: randomUUID(),
        peerId: b.grant.deviceId,
        peerKeyEpoch: 1,
        expectedPeerRevision: a.controls.peerStatus().revision,
        content: { version: 1, type: "task.submit", kind: "query", prompt },
        confirmed: true,
      });
      return { id: row.id, envelope: outbox.delivery(row.id) };
    });
  const prepare = (
    envelope: PrivateEnvelope,
    kind: "accepted" | "result" = "accepted",
  ) =>
    b.controls.prepareTaskResponse({
      operationId: envelope.header.operationId,
      peerId: a.grant.deviceId,
      kind,
      confirmed: true,
    });
  const open = async (envelope: PrivateEnvelope) =>
    a.remote.withVerifiedDevice(async (scope) => {
      const recipient = await a.keys(scope.current).resolve(),
        peer = await new PrivatePeerEnrollment(
          a.store,
          a.vault,
          a.owner,
          scope.current,
          clock,
        ).resolve(b.grant.deviceId, 1);
      const opened = await openPrivateEnvelope(
        envelope,
        envelope.header,
        { recipientKey: recipient.pair, senderPublicKey: peer.publicKey },
        clock,
      );
      try {
        return JSON.parse(new TextDecoder().decode(opened.plaintext));
      } finally {
        opened.plaintext.fill(0);
      }
    });
  const work = async () =>
    new LocalWorker(
      b.store,
      b.owner,
      {
        pin: async () => ({ profile, digest: "a".repeat(64) }),
        generate: async () => "Synthetic private result",
      },
      (id) => b.store.profile(b.owner, id),
    ).runOnce();
  return {
    a,
    b,
    clock,
    advance: (ms: number) => {
      now += ms;
    },
    submit,
    prepare,
    open,
    work,
    grant,
    withOutbox,
    verify,
    dir,
    close: () => {
      a.close();
      b.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
