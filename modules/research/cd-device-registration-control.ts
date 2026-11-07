import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Vault } from "../storage/vault.js";
import { ProtectedLoopbackBroker } from "../task-sync/enrollment-broker.js";
import { cdDeviceRegistrationNative } from "./cd-device-registration-native.js";
import type { CDRolesPrepareTransport } from "./cd-roles-prepare-transport.js";

const action = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("propose") }),
  z.strictObject({
    action: z.literal("approve"),
    id: z.uuid(),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    packetDigest: z.string().regex(/^[a-f0-9]{64}$/),
    confirmed: z.literal(true),
  }),
  z.strictObject({ action: z.literal("revoke") }),
]);

/** Native shell only. The returned capability must never reach the model/core.
 * Canonical Roles session provisioning and source/cost admission are external
 * prerequisites. No registration POST, enrollment, key creation or grant here. */
export async function launchCDDeviceRegistrationReview(options: {
  enabled?: boolean;
  path: string;
  vault: Vault;
  transport: CDRolesPrepareTransport;
}) {
  if (options.enabled !== true) return null;
  const transport = options.transport;
  const native = cdDeviceRegistrationNative({
    enabled: true,
    path: options.path,
    vault: options.vault,
    currentOwner: transport.currentOwner,
  });
  let busy = false,
    closed = false;
  let current = new AbortController();
  let proof: ReturnType<typeof native.sign> | undefined;
  const revoke = () => {
    current.abort();
    current = new AbortController();
    proof = undefined;
    native.revoke();
    transport.revoke();
  };
  const session = {
    async execute(input: z.infer<typeof action>, caller: AbortSignal) {
      if (closed) throw Error("Native CD review closed");
      if (input.action === "revoke") {
        revoke();
        return { revoked: true };
      }
      if (busy) throw Error("Native CD review busy");
      busy = true;
      const signal = AbortSignal.any([caller, current.signal]);
      try {
        signal.throwIfAborted();
        if (input.action === "propose") {
          proof = undefined;
          native.revoke();
          const packet = await transport.prepare(signal);
          signal.throwIfAborted();
          return native.review(packet);
        }
        await transport.refresh(signal);
        signal.throwIfAborted();
        const { action: _action, ...choice } = input;
        native.approve(choice);
        proof = native.sign();
        return { signed: true, registered: false, permissionsGranted: false };
      } catch (error) {
        revoke();
        throw error;
      } finally {
        busy = false;
      }
    },
  };
  const token = randomBytes(32).toString("hex");
  const broker = new ProtectedLoopbackBroker(
    token,
    () => (closed ? null : session),
    {
      path: "/cd-device-registration-control",
      parse: (raw) => action.parse(raw),
      maxRequest: 1024,
      maxResponse: 4096,
      deadline: 16000,
    },
  );
  try {
    const endpoint = await broker.listen();
    return {
      environment: {
        BITTREES_CD_DEVICE_CONTROL_URL: endpoint,
        BITTREES_CD_DEVICE_CONTROL_TOKEN: token,
      },
      takeProof() {
        const selected = proof;
        proof = undefined;
        return transport.currentOwner() ? selected : undefined;
      },
      async close() {
        closed = true;
        revoke();
        await broker.close();
      },
    };
  } catch (error) {
    closed = true;
    revoke();
    await broker.close();
    throw error;
  }
}
