/** Local-only review validation: isolated stores, no credentials, no timers, no enrollment. */
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { localApi } from "../apps/companion/http.js";
import { TaskSyncRunner } from "../modules/task-sync/runner.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import assert from "node:assert/strict";
const path = process.argv[2];
if (!path || process.argv.length !== 3)
  throw Error("Provide one local reviewed plan file");
const payload = await readFile(path, "utf8");
if (Buffer.byteLength(payload) > 2_000_000)
  throw Error("Review exceeds bounded size");
const plan = JSON.parse(payload);
const directory = await mkdtemp(join(tmpdir(), "bittrees-offline-review-"));
const vault = new Vault(randomBytes(32)),
  token = randomBytes(32).toString("hex");
let outboundAttempts = 0;
const denyOutbound: typeof fetch = async () => {
  outboundAttempts++;
  throw Error("Offline review has no source transport");
};
const runner = new TaskSyncRunner(
  join(directory, "review.sqlite"),
  vault,
  undefined,
  denyOutbound,
);
const store = new Store(":memory:", vault),
  app = express(),
  server = createServer(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
const route = "/v1/workflows/task-sync";
// Expose only local review/status. No owner handoff, models, source or update routes.
app.use((req, res, next) => {
  if (
    (req.method === "GET" && req.path === route) ||
    (req.method === "POST" && req.path === route + "/review")
  )
    return next();
  res.status(403).json({ error: "LOCAL_REVIEW_ONLY" });
});
app.use(
  localApi({
    store,
    taskSync: runner,
    token,
    port,
    owner: { userId: "offline-review", tenantId: "local-validation" },
  }),
);
try {
  const base = `http://127.0.0.1:${port}`,
    headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  const response = await fetch(base + route + "/review", {
    method: "POST",
    headers,
    body: payload,
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.reviewReady, true);
  assert.equal(result.enrolled, false);
  assert.equal(result.enabled, false);
  for (const action of ["enroll", "activate", "resume"])
    assert.equal(
      (
        await fetch(base + route + "/" + action, {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      403,
    );
  assert.equal(outboundAttempts, 0);
  console.log(
    JSON.stringify({
      mode: "isolated-local-review",
      tasks: plan.tasks.length,
      mappings: plan.mappings.length,
      reviewReady: true,
      enrolled: false,
      activated: false,
      sourceRequests: outboundAttempts,
      productionDataUsed: false,
      productionAppChanged: false,
    }),
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await runner.close();
  store.close();
  await rm(directory, { recursive: true, force: true });
}
