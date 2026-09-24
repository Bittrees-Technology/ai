import React from "react";
import { createRoot } from "react-dom/client";
import { PrivateRelayPanel } from "../../../apps/dashboard/private-relay.js";
import type {
  RelayRecord,
  RelayReview,
  RelayStatus,
} from "../../../apps/dashboard/private-relay-state.js";
import "../../../apps/dashboard/style.css";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ownerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  deviceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const grant = {
  id,
  ownerId,
  endpointKind: "mac" as const,
  endpointId: deviceId,
  credentialEpoch: 1,
  operationId: crypto.randomUUID(),
  revision: 1,
  state: "pending" as "pending" | "active" | "revoked",
  createdAt: Date.now() - 1000,
  expiresAt: Date.now() + 3600000,
  approvalExpiresAt: (Date.now() + 60000) as number | null,
  revokedAt: null as number | null,
};
const binding = {
  ownerId,
  deviceId,
  credentialEpoch: 1,
  expiresAt: grant.expiresAt,
};
const status: RelayStatus = {
  available: true,
  canSetup: true,
  canCheckRemote: true,
  transportActive: false,
  state: { version: 1, restoreAuthority: false, items: [] },
};
let review: RelayReview | null = null,
  release: (() => void) | undefined;
const fixture = {
  calls: [] as { path: string; body: any }[],
  holdReview: false,
  failConfirm: false,
  release: () => release?.(),
  id,
};
(window as any).relayControlFixture = fixture;
const api = async (path: string, _method?: string, body?: any) => {
  fixture.calls.push({ path, body });
  if (path === "/v1/private-relay") return structuredClone(status);
  if (path.endsWith("/cancel-review")) {
    review = null;
    return;
  }
  if (path.endsWith("/review")) {
    const candidate = {
      id: crypto.randomUUID(),
      action: body.action,
      expiresAt: Date.now() + 120000,
      permission: { ...grant },
      binding,
      record: status.state.items.find((r) => r.id === body.id) ?? null,
      cleanupAfter: body.after ?? null,
    };
    review = candidate;
    if (fixture.holdReview)
      await new Promise<void>((r) => {
        release = r;
      });
    return structuredClone(candidate);
  }
  if (path.endsWith("/confirm")) {
    const current = review;
    review = null;
    if (
      !current ||
      body.reviewId !== current.id ||
      body.confirmed !== true ||
      body.acknowledged !== true
    )
      throw Error("DENIED");
    if (fixture.failConfirm) {
      if (current.action === "revoke" && current.record) {
        const row = status.state.items[0]!;
        row.locked = true;
        row.phase = "stopped";
        row.revision++;
      }
      throw Error("UNAVAILABLE");
    }
    let result: any = {};
    if (current.action === "accept") {
      grant.state = "active";
      grant.revision = 2;
      grant.approvalExpiresAt = null;
      status.state.items.push({
        id: crypto.randomUUID(),
        revision: 3,
        locked: false,
        phase: "active",
        permission: { ...grant },
        binding,
      });
    } else if (current.record) {
      const row = status.state.items.find((r) => r.id === current.record!.id)!;
      row.revision++;
      if (current.action === "stop") {
        row.locked = true;
        row.phase = "stopped";
        result = { remoteRevocationConfirmed: false };
      }
      if (current.action === "revoke") {
        row.locked = true;
        row.phase = "stopped";
        row.permission!.state = "revoked";
        row.permission!.revokedAt = Date.now();
        row.permission!.revision++;
        result = { remoteRevocationConfirmed: true };
      }
      if (current.action === "remove") {
        row.locked = true;
        row.phase = "deleted";
        row.permission = null;
        row.binding = null;
        result = {
          credentialAbsentObserved: true,
          remoteRevocationConfirmed: false,
        };
      }
    } else if (current.action === "cleanup")
      result = { nextCursor: null, checked: [] };
    return structuredClone({
      ...status,
      completedAction: current.action,
      result,
    });
  }
  throw Error("Unknown fixture route");
};
const main = document.createElement("main");
main.style.cssText = "max-width:1000px;margin:auto;padding:20px;";
document.body.replaceChildren(main);
createRoot(main).render(React.createElement(PrivateRelayPanel, { api }));
