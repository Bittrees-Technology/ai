import React from "react";
import { createRoot } from "react-dom/client";
import { PrivatePermissionPanel } from "../../../apps/dashboard/private-permissions.js";
import type {
  PermissionStatus,
  PermissionReview,
} from "../../../apps/dashboard/private-permission-state.js";
import "../../../apps/dashboard/style.css";
const peerId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
let status: PermissionStatus = {
  available: true,
  canSetup: true,
  revision: 0,
  keyRevision: 2,
  peerRevision: 1,
  needsFreshPairing: false,
  hasSelectedKey: true,
  peers: [{ peerId, keyEpoch: 1, fingerprint: "0123456789abcdef".repeat(4) }],
  profiles: [{ id: "local", model: "Local test model" }],
  grants: [],
};
let review: PermissionReview | null = null,
  release: (() => void) | undefined;
const fixture = {
  calls: [] as { path: string; body: any }[],
  holdReview: false,
  failConfirm: false,
  release: () => release?.(),
};
(window as any).permissionFixture = fixture;
const api = async (path: string, _method?: string, body?: any) => {
  fixture.calls.push({ path, body });
  if (path.endsWith("permissions")) return structuredClone(status);
  if (path.endsWith("review")) {
    review = {
      id: crypto.randomUUID(),
      action: body.action,
      peerId: body.peerId,
      expiresAt: Date.now() + 300000,
      binding:
        body.action === "grant"
          ? {
              ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              deviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            }
          : null,
      fingerprint:
        body.action === "grant" ? status.peers[0]!.fingerprint : null,
      model: body.modelProfileId ? "Local test model" : null,
      choices:
        body.action === "grant"
          ? {
              peerId: body.peerId,
              peerKeyEpoch: body.peerKeyEpoch,
              receiveTasks: body.receiveTasks,
              sendTasks: body.sendTasks,
              sendReceipts: body.sendReceipts,
              sendResults: body.sendResults,
              modelProfileId: body.modelProfileId,
              expiresAt: Date.now() + body.minutes * 60000,
            }
          : null,
    };
    if (fixture.holdReview)
      await new Promise<void>((r) => {
        release = r;
      });
    return structuredClone(review);
  }
  if (path.endsWith("confirm")) {
    if (fixture.failConfirm) throw Error("CONFLICT");
    if (
      !review ||
      body.reviewId !== review.id ||
      !body.confirmed ||
      !body.acknowledged
    )
      throw Error("DENIED");
    if (review.choices)
      status.grants = [
        { id: crypto.randomUUID(), choices: review.choices, state: "saved" },
      ];
    else
      status.grants.forEach((g) => {
        if (g.choices.peerId === review!.peerId) g.state = "revoked";
      });
    status.revision++;
    review = null;
    return structuredClone(status);
  }
  throw Error("UNKNOWN_ROUTE");
};
const main = document.createElement("main");
main.className = "content";
document.body.replaceChildren(main);
createRoot(main).render(React.createElement(PrivatePermissionPanel, { api }));
