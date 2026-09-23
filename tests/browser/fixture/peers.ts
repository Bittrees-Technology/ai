import React from "react";
import { createRoot } from "react-dom/client";
import { PrivatePeerPanel } from "../../../apps/dashboard/private-peers.js";
import type {
  PeerStatus,
  PeerReview,
} from "../../../apps/dashboard/private-peer-state.js";
import "../../../apps/dashboard/style.css";
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  deviceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  peerId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const fingerprint = "0123456789abcdef".repeat(4);
let status: PeerStatus = {
  available: true,
  canSetup: true,
  revision: 0,
  keyRevision: 2,
  hasSelectedKey: true,
  needsFreshPairing: false,
  peers: [],
};
let review: PeerReview | null = null,
  release: (() => void) | undefined;
const fixture = {
  fingerprint,
  peerId,
  calls: [] as { path: string; body: any }[],
  holdReview: false,
  failConfirm: false,
  release: () => release?.(),
};
(window as any).peerFixture = fixture;
const api = async (path: string, _method?: string, body?: any) => {
  fixture.calls.push({ path, body });
  if (path === "/v1/private-peers") return structuredClone(status);
  if (path.endsWith("/invitation"))
    return {
      invitation: {
        version: 1,
        ownerId,
        peerId: deviceId,
        recipientId: body.recipientId,
        publicKey: "synthetic-public-material",
        expiresAt: Date.now() + 300000,
      },
      fingerprint,
    };
  if (path.endsWith("/review")) {
    review = {
      id: crypto.randomUUID(),
      action: body.action,
      peerId,
      keyEpoch: 1,
      expiresAt: Date.now() + 300000,
      binding: body.action === "approve" ? { ownerId, deviceId } : null,
      fingerprint,
      replaces: null,
    };
    if (fixture.holdReview)
      await new Promise<void>((r) => {
        release = r;
      });
    return structuredClone(review);
  }
  if (path.endsWith("/confirm")) {
    if (fixture.failConfirm) throw Error("CONFLICT");
    if (
      !review ||
      body.reviewId !== review.id ||
      !body.acknowledged ||
      !body.confirmed ||
      (review.action === "approve" && body.comparedFingerprint !== fingerprint)
    )
      throw Error("DENIED");
    if (review.action === "approve")
      status.peers = [{ peerId, keyEpoch: 1, fingerprint, revoked: false }];
    else status.peers[0]!.revoked = true;
    status.revision++;
    review = null;
    return structuredClone(status);
  }
  throw Error("UNKNOWN_ROUTE");
};
const main = document.createElement("main");
main.className = "content";
document.body.replaceChildren(main);
createRoot(main).render(React.createElement(PrivatePeerPanel, { api }));
