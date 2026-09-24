import React from "react";
import { createRoot } from "react-dom/client";
import { PrivateRelayPanel } from "../../../apps/dashboard/private-relay.js";
import "../../../apps/dashboard/style.css";
const id = crypto.randomUUID(),
  ownerId = crypto.randomUUID(),
  deviceId = crypto.randomUUID();
const expiresAt = Date.now() + 3600000;
const relay = {
  available: true,
  canSetup: true,
  canCheckRemote: true,
  transportActive: false,
  state: {
    version: 1,
    restoreAuthority: false,
    items: [
      {
        id,
        revision: 3,
        locked: false,
        phase: "active",
        binding: { ownerId, deviceId, credentialEpoch: 1, expiresAt },
        permission: {
          id: crypto.randomUUID(),
          ownerId,
          endpointKind: "mac",
          endpointId: deviceId,
          credentialEpoch: 1,
          operationId: crypto.randomUUID(),
          revision: 2,
          state: "active",
          createdAt: Date.now() - 1000,
          expiresAt,
          approvalExpiresAt: null,
          revokedAt: null,
        },
      },
    ],
  },
};
const accepted = {
  operationId: crypto.randomUUID(),
  taskId: crypto.randomUUID(),
  peerId: crypto.randomUUID(),
  peerKeyEpoch: 1,
  acceptedAt: Date.now(),
};
type Reply = {
  id: string;
  revision: number;
  kind: string;
  locked: boolean;
  state: string;
  operationId: string;
  peerId: string;
  expiresAt: number;
  attempts: number;
  delivery?: { state: string; observedAt: number; attempt: number };
};
const tasks = {
  available: true,
  enabled: true,
  transportActive: false,
  acceptedTasks: [] as (typeof accepted)[],
  responses: [] as Reply[],
};
let generation = 0,
  release: (() => void) | undefined;
const fixture = {
  id,
  calls: [] as { path: string; body: any }[],
  failSend: false,
  holdCheck: false,
  release: () => release?.(),
  offline: () => {
    relay.canCheckRemote = false;
    relay.state.items[0]!.locked = true;
    tasks.enabled = false;
  },
  change: () => {
    relay.state.items[0]!.revision++;
  },
};
(window as any).taskDeliveryFixture = fixture;
const receipt = (messageId: string, state: string = "stored") => ({
  version: 1,
  messageId,
  envelopeHash: "a".repeat(64),
  revision: 1,
  storedAt: accepted.acceptedAt,
  state,
});
const api = async (path: string, _method?: string, body?: any) => {
  fixture.calls.push({ path, body: structuredClone(body) });
  if (path === "/v1/private-relay") return structuredClone(relay);
  if (path === "/v1/private-tasks") return structuredClone(tasks);
  if (path.endsWith("/cancel-review")) {
    generation++;
    return;
  }
  if (!body?.confirmed) throw Error("DENIED");
  if (path.endsWith("/check-task")) {
    const start = generation;
    if (fixture.holdCheck)
      await new Promise<void>((r) => {
        release = r;
      });
    if (start !== generation) throw Error("DENIED");
    if (tasks.acceptedTasks.length) return { received: null, nextCursor: null };
    tasks.acceptedTasks.push(accepted);
    return {
      received: {
        status: "accepted-locally",
        taskId: accepted.taskId,
        operationId: accepted.operationId,
        messageId: accepted.operationId,
      },
      nextCursor: null,
      transport: {
        transportOnly: true,
        receipt: receipt(accepted.operationId, "received"),
        duplicate: false,
      },
    };
  }
  if (path.endsWith("/responses/prepare")) {
    const previous = tasks.responses.find((r) => r.kind === body.response.kind);
    if (previous) return structuredClone(previous);
    const r = {
      id: crypto.randomUUID(),
      revision: 1,
      kind: body.response.kind,
      locked: false,
      state: "pending",
      operationId: accepted.operationId,
      peerId: accepted.peerId,
      expiresAt,
      attempts: 0,
    };
    tasks.responses.push(r);
    return structuredClone(r);
  }
  if (path.endsWith("/responses/send")) {
    const r = tasks.responses.find((r) => r.id === body.response.id)!;
    if (!r || r.revision !== body.response.expectedRevision)
      throw Error("CONFLICT");
    r.attempts++;
    r.revision++;
    if (fixture.failSend) throw Error("UNAVAILABLE");
    r.delivery = {
      state: "stored",
      observedAt: Date.now(),
      attempt: r.attempts,
    };
    return {
      transportOnly: true,
      receipt: receipt(r.id),
      duplicate: r.attempts > 1,
    };
  }
  if (path.endsWith("/responses/stop")) {
    const r = tasks.responses.find((r) => r.id === body.id)!;
    if (!r || r.revision !== body.expectedRevision) throw Error("CONFLICT");
    r.state = "stopped";
    r.revision++;
    return structuredClone(r);
  }
  throw Error("Unknown fixture route");
};
const main = document.createElement("main");
main.style.cssText = "max-width:1000px;margin:auto;padding:20px;";
document.body.replaceChildren(main);
createRoot(main).render(React.createElement(PrivateRelayPanel, { api }));
