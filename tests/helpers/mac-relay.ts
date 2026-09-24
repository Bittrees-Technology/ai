import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { CompanionPrivateRelay } from "../../apps/companion/private-relay.js";
import {
  privateRelayEnvelopeHash,
  parsePrivateRelaySubmission,
} from "../../modules/remote/private-relay-contracts.js";
import type { PrivateEnvelope } from "../../modules/remote/private-envelope.js";
import { privateEndpoints } from "./private-endpoints.js";

export async function macRelayFixture(conversations = false) {
  const f = await privateEndpoints(true, conversations),
    wire = await f.submit();
  const credential = randomBytes(32).toString("base64url");
  let grant = {
    id: randomUUID(),
    ownerId: f.b.grant.ownerId,
    endpointKind: "mac",
    endpointId: f.b.grant.deviceId,
    credentialEpoch: 1,
    operationId: randomUUID(),
    revision: 1,
    state: "pending",
    createdAt: f.clock() - 1,
    expiresAt: f.b.grant.expiresAt,
    approvalExpiresAt: (f.clock() + 60000) as number | null,
    revokedAt: null as number | null,
  };
  let receipt = {
    version: 1,
    messageId: wire.envelope.header.messageId,
    envelopeHash: await privateRelayEnvelopeHash(wire.envelope),
    revision: 1,
    storedAt: f.clock(),
    state: "stored",
  };
  const control = {
    loseSubmit: false,
    denyRecipient: false,
    recipientExpiresAt: f.clock() + 1800000,
    beforeRecipient: undefined as undefined | (() => Promise<void>),
    afterSubmit: undefined as undefined | (() => Promise<void>),
    beforePoll: undefined as undefined | (() => Promise<void>),
    loseAck: false,
    ackAfterSave: false,
    beforeAck: undefined as undefined | (() => void),
    calls: [] as string[],
  };
  const recipientPermissionId = randomUUID();
  const recipient = () => ({
    version: 1 as const,
    scope: "private:relay" as const,
    ownerId: grant.ownerId,
    endpointId: f.a.grant.deviceId,
    endpointKind: "browser" as const,
    credentialEpoch: 1,
    permissionId: recipientPermissionId,
    expiresAt: control.recipientExpiresAt,
  });
  const sender = () => ({
    version: 1 as const,
    scope: "private:relay" as const,
    ownerId: grant.ownerId,
    endpointId: grant.endpointId,
    endpointKind: "mac" as const,
    credentialEpoch: 1,
    permissionId: grant.id,
    expiresAt: grant.expiresAt,
  });
  const outgoing = new Map<
    string,
    {
      envelope: PrivateEnvelope;
      receipt: {
        version: 1;
        messageId: string;
        envelopeHash: string;
        revision: number;
        storedAt: number;
        state: "stored";
      };
    }
  >();
  const transport: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname.split("/device/")[1]!;
    const bearer = new Headers(init?.headers).get("authorization");
    control.calls.push(path);
    let value: unknown,
      responseStatus = 200;
    if (path === "relay/approval/inspect") {
      assert.equal(bearer, "Bearer " + f.b.grant.credential);
      value = grant;
    } else if (path === "relay/permission/accept") {
      assert.equal(bearer, "Bearer " + f.b.grant.credential);
      grant = {
        ...grant,
        state: "active",
        revision: 2,
        approvalExpiresAt: null,
      };
      value = { grant, credential, scope: "private:relay" };
    } else {
      assert.equal(bearer, "Bearer " + credential);
      if (path === "relay/permission/inspect")
        value = {
          version: 1,
          scope: "private:relay",
          ownerId: grant.ownerId,
          endpointId: grant.endpointId,
          endpointKind: "mac",
          credentialEpoch: 1,
          permissionId: grant.id,
          expiresAt: grant.expiresAt,
        };
      else {
        assert.equal(
          new Headers(init?.headers).get("x-bittrees-relay-permission"),
          grant.id,
        );
        const body = JSON.parse(String(init?.body));
        if (path === "relay/messages/recipient") {
          assert.equal(body.endpointId, f.a.grant.deviceId);
          await control.beforeRecipient?.();
          if (control.denyRecipient) {
            responseStatus = 403;
            value = { error: "DENIED" };
          } else value = recipient();
        } else if (path === "relay/messages/submit") {
          const input = parsePrivateRelaySubmission(
            body,
            sender(),
            recipient(),
            f.clock(),
          );
          const envelope = input.envelope,
            previous = outgoing.get(envelope.header.messageId);
          if (previous) assert.deepEqual(envelope, previous.envelope);
          const saved = previous ?? {
            envelope: structuredClone(envelope),
            receipt: {
              version: 1 as const,
              messageId: envelope.header.messageId,
              envelopeHash: await privateRelayEnvelopeHash(envelope),
              revision: 1,
              storedAt: f.clock(),
              state: "stored" as const,
            },
          };
          outgoing.set(envelope.header.messageId, saved);
          await control.afterSubmit?.();
          if (control.loseSubmit) throw Error("lost submission response");
          value = { receipt: saved.receipt, duplicate: !!previous };
        } else if (path === "relay/messages/poll") {
          assert.equal(body.limit, 1);
          await control.beforePoll?.();
          value = {
            items:
              receipt.state === "stored" &&
              (!body.after ||
                receipt.storedAt > body.after.storedAt ||
                (receipt.storedAt === body.after.storedAt &&
                  receipt.messageId > body.after.messageId))
                ? [{ receipt, envelope: wire.envelope }]
                : [],
            nextCursor: null,
          };
        } else if (path === "relay/messages/acknowledge") {
          if (control.beforeAck) control.beforeAck();
          else
            assert.equal(
              f.b.store.export(f.b.owner).length,
              1,
              "local commit precedes acknowledgement",
            );
          assert.deepEqual(body, {
            messageId: receipt.messageId,
            envelopeHash: receipt.envelopeHash,
            expectedRevision: 1,
            confirmed: true,
          });
          if (!control.loseAck || control.ackAfterSave)
            receipt = { ...receipt, revision: 2, state: "received" };
          if (control.loseAck) throw Error("lost acknowledgement");
          value = { receipt, duplicate: false };
        } else throw Error("Unexpected relay route " + path);
      }
    }
    const response = Response.json(value, { status: responseStatus });
    Object.defineProperty(response, "url", { value: String(url) });
    return response;
  };
  f.b.relayTransport(transport);
  // Separate synthetic slots for the relay credential and endpoint cryptographic key.
  const slots = new Map<string, any>();
  const slot = () => {
    let value: Uint8Array | undefined;
    return {
      async getSecret() {
        return value ? Uint8Array.from(value) : undefined;
      },
      async addSecretIfAbsent(v: Uint8Array) {
        if (value) return false;
        value = Uint8Array.from(v);
        return true;
      },
      async deleteCredential() {
        const present = !!value;
        value = undefined;
        return present;
      },
    };
  };
  const entries = {
    forSlot(_owner: unknown, id: string) {
      if (!slots.has(id))
        slots.set(id, { key: slot(), attempt: slot(), deleted: slot() });
      return slots.get(id)!;
    },
  };
  const build = (enabled = true) =>
    new CompanionPrivateRelay(
      f.b.store,
      f.b.vault,
      f.b.owner,
      entries,
      f.b.remote,
      enabled,
      f.clock,
      () => performance.now(),
      transport,
    );
  let relay = build();
  const review = await relay.prepare({
    action: "accept",
    permissionId: grant.id,
  });
  await relay.confirm({
    reviewId: review.id,
    confirmed: true,
    acknowledged: true,
  });
  const input = () => {
    const r = relay.status().state.items[0]!;
    return {
      id: r.id,
      expectedRevision: r.revision,
      after: null,
      confirmed: true,
    };
  };
  const check = () => f.b.controls.checkRelayedTask(relay, input());
  return {
    f,
    wire,
    control,
    outgoing,
    build,
    input,
    check,
    async queueEnvelope(envelope: PrivateEnvelope) {
      wire.envelope = structuredClone(envelope);
      receipt = {
        version: 1,
        messageId: envelope.header.messageId,
        envelopeHash: await privateRelayEnvelopeHash(envelope),
        revision: 1,
        storedAt: f.clock(),
        state: "stored",
      };
    },
    get relay() {
      return relay;
    },
    reopen() {
      f.b.reopen();
      relay = build();
    },
    async tamper() {
      wire.envelope.ciphertext =
        (wire.envelope.ciphertext[0] === "A" ? "B" : "A") +
        wire.envelope.ciphertext.slice(1);
      receipt.envelopeHash = await privateRelayEnvelopeHash(wire.envelope);
    },
    close: f.close,
  };
}
