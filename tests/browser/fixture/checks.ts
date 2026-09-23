import React from "react";
import { createRoot } from "react-dom/client";
import { PrivateCheckPanel } from "../../../apps/dashboard/private-checks.js";
import type {
  CheckStatus,
  CheckRecord,
} from "../../../apps/dashboard/private-check-state.js";
import {
  privateEnvelopeSuite,
  type PrivateEnvelope,
} from "../../../modules/remote/private-envelope.js";
import "../../../apps/dashboard/style.css";
const peer = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  local = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const status: CheckStatus = { available: true, enabled: true, checks: [] };
const envelopes = new Map<string, PrivateEnvelope>();
const envelope = (id: string, incoming = false): PrivateEnvelope => ({
  header: {
    version: 1,
    suite: privateEnvelopeSuite,
    ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    senderId: incoming ? peer : local,
    recipientId: incoming ? local : peer,
    senderKeyEpoch: 1,
    recipientKeyEpoch: 1,
    messageId: crypto.randomUUID(),
    operationId: id,
    sequence: 1,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 300000,
  },
  enc: "A".repeat(87),
  ciphertext: "synthetic-encrypted-code",
});
let release: (() => void) | undefined;
const fixture = {
  calls: [] as { path: string; body: any }[],
  hold: "",
  fail: "",
  holding: false,
  release: () => release?.(),
  incoming: () =>
    JSON.stringify(
      envelope(
        status.checks.find((c) => c.role === "challenge")?.id ??
          crypto.randomUUID(),
        true,
      ),
    ),
  seed: (state: CheckRecord["state"], locked = false) => {
    const id = crypto.randomUUID();
    status.checks.push({
      id,
      role: "challenge",
      revision: 1,
      locked,
      state,
      peerId: peer,
      expiresAt: Date.now() + 300000,
      verifiedAt: null,
    });
    envelopes.set(id, envelope(id));
    return id;
  },
  disable: () => {
    status.enabled = false;
  },
};
(window as any).checkFixture = fixture;
const api = async (path: string, _method?: string, body?: any) => {
  fixture.calls.push({ path, body });
  if (path === "/v1/private-peers")
    return {
      available: true,
      canSetup: true,
      revision: 3,
      keyRevision: 2,
      needsFreshPairing: false,
      hasSelectedKey: true,
      peers: [
        {
          peerId: peer,
          keyEpoch: 1,
          fingerprint: "0123456789abcdef".repeat(4),
          revoked: false,
        },
      ],
    };
  if (path === "/v1/private-peer-checks") return structuredClone(status);
  const action = path.split("/").at(-1)!;
  let result: unknown;
  if (action === "begin" || action === "respond") {
    const id = crypto.randomUUID(),
      row: CheckRecord = {
        id,
        role: action === "begin" ? "challenge" : "response",
        revision: 1,
        locked: false,
        state: "pending",
        peerId: peer,
        expiresAt: Date.now() + 300000,
        verifiedAt: null,
      };
    status.checks.push(row);
    envelopes.set(id, envelope(id));
    result = row;
  } else {
    const row = status.checks.find(
      (c) => c.id === (body.id ?? body.envelope?.header.operationId),
    );
    if (!row) throw Error("DENIED");
    if (action === "envelope") result = envelopes.get(row.id);
    else {
      row.state =
        action === "stop"
          ? "stopped"
          : action === "resume"
            ? "pending"
            : "verified";
      row.revision++;
      if (action === "complete") row.verifiedAt = Date.now();
      result = row;
    }
  }
  if (fixture.hold === action)
    await new Promise<void>((r) => {
      release = r;
      fixture.holding = true;
    });
  if (fixture.fail === action) throw Error("LOST_ACK");
  return structuredClone(result);
};
const main = document.createElement("main");
main.className = "content";
document.body.replaceChildren(main);
createRoot(main).render(React.createElement(PrivateCheckPanel, { api }));
