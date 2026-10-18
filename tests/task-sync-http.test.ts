import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { localApi } from "../apps/companion/http.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { TaskSyncRunner } from "../modules/task-sync/runner.js";
import { digest } from "../modules/task-sync/proof-contract.js";

test("review accepts a realistic task batch without widening authentication or other body limits", async () => {
  const vault = new Vault(randomBytes(32)),
    store = new Store(":memory:", vault);
  const runner = new TaskSyncRunner(":memory:", vault),
    token = randomBytes(32).toString("hex");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  server.on(
    "request",
    localApi({
      store,
      token,
      port,
      owner: { userId: "a", tenantId: "t" },
      taskSync: runner,
    }),
  );
  const base = `http://127.0.0.1:${port}`,
    workspace = randomUUID(),
    project = randomUUID();
  const tasks = Array.from({ length: 66 }, (_, i) => {
    const content = {
      sourceId: `agent-readiness:agent:item-${i}`,
      projectId: "agent",
      title: `Review ${i}`,
      description: "Evidence ".repeat(120),
      status: "todo",
      priority: "P0",
      area: "docs",
      acceptanceCriteria: ["Evidence"],
      progressNote: "",
      sourceUrl: "https://agent.bittrees.org/readiness",
    };
    return {
      content,
      fingerprint: digest(content),
      destination: { projectId: project, workspaceId: workspace },
    };
  });
  const body = JSON.stringify({
    sourceWorkspace: workspace,
    revision: "a".repeat(64),
    tasks,
    mappings: [
      {
        sourceProjectId: "agent",
        siteUrl: null,
        crmProjectId: project,
        workspaceId: workspace,
      },
    ],
  });
  assert.ok(Buffer.byteLength(body) > 65536);
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  const post = (path: string, data = body, h: Record<string, string> = headers) =>
    fetch(base + path, { method: "POST", headers: h, body: data });
  try {
    assert.equal(
      (
        await post("/v1/workflows/task-sync/review", body, {
          "Content-Type": "application/json",
          Authorization: "",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await post("/v1/workflows/task-sync/review", body, {
          ...headers,
          Origin: "https://evil.test",
        })
      ).status,
      403,
    );
    const result = await post("/v1/workflows/task-sync/review");
    assert.equal(result.status, 200);
    const status = await result.json();
    assert.equal(status.reviewReady, true);
    assert.equal(status.enrolled, false);
    assert.equal(status.enabled, false);
    assert.equal(
      (await post("/v1/workflows/task-sync/activation-review")).status,
      413,
    );
    assert.equal(
      (
        await post(
          "/v1/workflows/task-sync/review",
          JSON.stringify({ padding: "x".repeat(2_000_000) }),
        )
      ).status,
      413,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runner.close();
    store.close();
  }
});
