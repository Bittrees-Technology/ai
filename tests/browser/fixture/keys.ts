import React from "react";
import { createRoot } from "react-dom/client";
import { PrivateKeyPanel } from "../../../apps/dashboard/private-keys.js";
import type {
  KeyStatus,
  KeyReview,
} from "../../../apps/dashboard/private-key-state.js";
import "../../../apps/dashboard/style.css";
let status: KeyStatus = {
  available: true,
  canSetup: true,
  state: {
    revision: 0,
    needsFreshPairing: false,
    pendingKeyDeletionCount: 0,
    slots: [],
  },
};
let review: KeyReview | null = null,
  release: (() => void) | undefined;
const fixture = {
  calls: [] as { path: string; body: any }[],
  holdReview: false,
  failConfirm: false,
  release: () => release?.(),
};
(window as any).keyFixture = fixture;
const api = async (path: string, _method?: string, body?: any) => {
  fixture.calls.push({ path, body });
  if (path === "/v1/private-keys") return structuredClone(status);
  if (path.endsWith("/review")) {
    review = {
      ...body,
      id: crypto.randomUUID(),
      expiresAt: Date.now() + 300000,
      binding: {
        ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        deviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
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
      body.confirmed !== true ||
      body.acknowledged !== true
    )
      throw Error("DENIED");
    const slot = status.state.slots.find((s) => s.id === review!.keyId);
    if (review.action === "remove" && slot) {
      slot.state = "deleted";
      slot.publicKey = null;
    } else if (review.action === "revoke" && slot) slot.state = "retired";
    else if (review.action === "cleanup")
      status.state.pendingKeyDeletionCount = 0;
    else if (review.action === "resume" && slot) slot.state = "active";
    else {
      status.state.slots.forEach((s) => {
        if (s.state === "active" || s.state === "preparing")
          s.state = "retired";
      });
      status.state.slots.push({
        id: crypto.randomUUID(),
        keyEpoch: status.state.slots.length + 1,
        createdAt: Date.now(),
        state: "active",
        publicKey: "synthetic-public-key",
      });
    }
    status.state.revision += 2;
    review = null;
    return structuredClone(status);
  }
  throw Error("UNKNOWN_ROUTE");
};
const main = document.createElement("main");
main.className = "content";
document.body.replaceChildren(main);
createRoot(main).render(React.createElement(PrivateKeyPanel, { api }));
