import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { deviceStatus } from "../apps/companion/device.js";
import { localApi } from "../apps/companion/http.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
test("device reports bounded operational fields and unknown disk capacity without exposing host identity", async () => {
  const value = await deviceStatus(tmpdir());
  assert.ok(value.memory.totalBytes > 0);
  assert.ok(value.diskFreeBytes !== null && value.diskFreeBytes >= 0);
  assert.equal(
    value.limits.importMemoryBytes,
    Math.floor(value.memory.totalBytes * 0.6),
  );
  assert.equal(value.cloudFallback, false);
  assert.equal(value.remoteAccess, false);
  assert.deepEqual(
    Object.keys(value).sort(),
    [
      "sampledAt",
      "platform",
      "architecture",
      "logicalProcessors",
      "memory",
      "diskFreeBytes",
      "uptimeSeconds",
      "limits",
      "remoteAccess",
      "cloudFallback",
    ].sort(),
  );
  assert.equal(JSON.stringify(value).includes(tmpdir()), false);
  assert.equal(
    (await deviceStatus("/nonexistent-bittrees-device-fixture")).diskFreeBytes,
    null,
  );
});
test("device operational status stays behind local authentication and origin checks", async () => {
  const store = new Store(":memory:", new Vault(randomBytes(32))),
    server = createServer(),
    token = randomBytes(32).toString("hex");
  let reads = 0;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  server.on(
    "request",
    localApi({
      store,
      owner: { userId: "a", tenantId: "b" },
      port,
      token,
      deviceStatus: async () => {
        reads++;
        return deviceStatus(tmpdir());
      },
    }),
  );
  const url = `http://127.0.0.1:${port}/v1/device`;
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal(
      (
        await fetch(url, {
          headers: {
            Authorization: "Bearer " + token,
            Origin: "https://other.invalid",
          },
        })
      ).status,
      403,
    );
    assert.equal(reads, 0);
    const response = await fetch(url, {
      headers: { Authorization: "Bearer " + token },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(
      ((await response.json()) as any).limits.parallelGenerations,
      1,
    );
    assert.equal(reads, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});
