import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { AutoNoteConnector } from "../modules/connectors/autonote.js";
import { AutoNoteApprovalConnector } from "../modules/connectors/autonote-approval.js";
import { localApi } from "../apps/companion/http.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
function slot() {
  let value: Uint8Array | undefined;
  return {
    getSecret: async () => value,
    setSecret: async (v: Uint8Array) => {
      value = v;
    },
    deleteCredential: async () => {
      value = undefined;
      return true;
    },
  };
}
test("authenticated approval setup binds a separate secret to its parent and removes it independently", async () => {
  const parent = {
    token: "a".repeat(64),
    grantId: randomUUID(),
    subjectId: randomUUID(),
    workspaceId: randomUUID(),
    meetingId: randomUUID(),
    actions: ["read_transcript"],
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    policyRevision: "autonote-ai-transcript-v1",
  };
  const approval = {
    token: "b".repeat(64),
    approvalId: randomUUID(),
    grantId: parent.grantId,
    meetingId: parent.meetingId,
    actions: ["approve_meeting_notes"],
    expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
  };
  const readSlot = slot(),
    approvalSlot = slot();
  let exchanges = 0;
  const source = new AutoNoteConnector("owner", readSlot, async (url) => {
    if (String(url).endsWith("/exchange")) return Response.json(parent);
    assert.ok(String(url).endsWith("/review-status"));
    return Response.json({
      grantId: parent.grantId,
      meetingId: parent.meetingId,
      enabled: true,
      expiresAt: parent.expiresAt,
    });
  });
  const initial = await source.begin();
  await source.finish(initial.id, "c".repeat(64));
  const connector = new AutoNoteApprovalConnector(
    "owner",
    approvalSlot,
    source,
    async (url, init) => {
      exchanges++;
      assert.equal(
        String(url),
        "https://autonote.bittrees.org/api/integrations/ai/approval-exchange",
      );
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      assert.equal(init?.redirect, "error");
      return Response.json(approval);
    },
  );
  const store = new Store(":memory:", new Vault(randomBytes(32))),
    server = createServer(),
    token = randomBytes(32).toString("hex");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  server.on(
    "request",
    localApi({
      store,
      token,
      port,
      owner: { userId: "owner", tenantId: "personal" },
      autonote: source,
      autonoteApproval: connector,
    }),
  );
  const base = `http://127.0.0.1:${port}/v1/connections/autonote-approval`;
  const call = (path = "", method = "GET", body?: unknown, extra = {}) =>
    fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    assert.equal((await fetch(base)).status, 401);
    assert.equal(
      (
        await call(
          "/begin",
          "POST",
          {},
          { Origin: "https://untrusted.example" },
        )
      ).status,
      403,
    );
    const start = await (await call("/begin", "POST", {})).json();
    assert.equal(
      new URL(start.consentUrl).searchParams.get("approval_grant"),
      parent.grantId,
    );
    assert.equal((await call("/cancel", "POST", {})).status, 200);
    assert.equal(
      (await call("/finish", "POST", { id: start.id, code: "c".repeat(64) }))
        .ok,
      false,
    );
    assert.equal(exchanges, 0);
    const retry = await (await call("/begin", "POST", {})).json();
    const done = await call("/finish", "POST", {
      id: retry.id,
      code: "c".repeat(64),
    });
    assert.equal(done.status, 200);
    assert.equal((await done.text()).includes(approval.token), false);
    assert.equal(exchanges, 1);
    assert.ok(await approvalSlot.getSecret());
    assert.equal((await connector.status())?.state, "stored");
    await assert.rejects(
      new AutoNoteApprovalConnector("different", approvalSlot, source).status(),
    );
    await source.forgetLocal();
    assert.equal((await connector.status())?.state, "unavailable");
    assert.equal((await call("/local", "DELETE")).status, 400);
    assert.equal(
      (
        await call("/local", "DELETE", undefined, {
          "X-Confirm-Delete": "local-autonote-approval-credential",
        })
      ).status,
      204,
    );
    assert.equal(await approvalSlot.getSecret(), undefined);
    assert.equal(await connector.status(), null);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
