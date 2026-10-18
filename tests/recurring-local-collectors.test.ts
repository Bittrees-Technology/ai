import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectLocalStorage,
  readLocalHomeMonitor,
} from "../modules/workflows/recurring-local-collectors.js";
const now = () => 1792337000000,
  signal = () => new AbortController().signal;
const value = () => ({
  updated: now() / 1000,
  monitor: { stale: false, age_seconds: 5 },
  hosts: Object.fromEntries(
    ["pi-firewall", "acer-isolated"].map((host) => [
      host,
      {
        time: now() / 1000,
        reachable: true,
        addresses: {
          current: [
            {
              interface: "eth0",
              address: "192.168.1.2",
              prefix: 24,
              mac: "PRIVATE-UNNEEDED-MAC",
            },
          ],
          events: [
            {
              time: now() / 1000 - 5,
              kind: "changed",
              before: "SECRET-NOT-NEEDED",
              after: "SECRET-NOT-NEEDED",
            },
          ],
        },
        credentials: { token: "NEVER-PROJECT-THIS" },
        services: { private: "NEVER-PROJECT-THIS" },
      },
    ]),
  ),
});
test("storage reads only the exact Data volume and reports low-space without deletion", async () => {
  const receipt = await inspectLocalStorage(
    signal(),
    async (path, options) => {
      assert.equal(path, "/System/Volumes/Data");
      assert.deepEqual(options, { bigint: true });
      return {
        bavail: 14n * 1024n ** 3n,
        bsize: 1n,
        blocks: 460n * 1024n ** 3n,
      };
    },
    now,
  );
  assert.equal((receipt.evidence as any).belowReserve, true);
  assert.equal((receipt.evidence as any).cleanupPerformed, false);
});
test("storage supports healthy, invalid and aborted observations", async () => {
  const receipt = await inspectLocalStorage(
    signal(),
    async () => ({ bavail: 21n, bsize: 1024n ** 3n, blocks: 460n }),
    now,
  );
  assert.equal((receipt.evidence as any).belowReserve, false);
  await assert.rejects(
    inspectLocalStorage(
      signal(),
      async () => ({ bavail: -1n, bsize: 1n, blocks: 1n }),
      now,
    ),
  );
  const abort = new AbortController();
  abort.abort();
  let calls = 0;
  await assert.rejects(
    inspectLocalStorage(
      abort.signal,
      async () => {
        calls++;
        throw Error();
      },
      now,
    ),
  );
  assert.equal(calls, 0);
});
test("home collector uses only a fixed loopback GET and projects no secrets", async () => {
  const receipt = await readLocalHomeMonitor(
    signal(),
    (async (url, options) => {
      assert.equal(url, "http://127.0.0.1:8766/api/status");
      assert.equal(options?.method, "GET");
      assert.equal(options?.redirect, "error");
      return Response.json(value());
    }) as typeof fetch,
    now,
  );
  assert.equal(receipt.state, "confirmed");
  const text = JSON.stringify(receipt);
  for (const secret of [
    "NEVER-PROJECT-THIS",
    "SECRET-NOT-NEEDED",
    "PRIVATE-UNNEEDED-MAC",
  ])
    assert.equal(text.includes(secret), false);
});
test("home freshness fails closed and fingerprints remain stable across polling timestamps", async () => {
  const data = value();
  const request = (async () => Response.json(data)) as typeof fetch;
  const first = await readLocalHomeMonitor(signal(), request, now);
  data.updated += 1;
  const second = await readLocalHomeMonitor(
    signal(),
    request,
    () => now() + 1000,
  );
  assert.equal(first.fingerprint, second.fingerprint);
  data.updated -= 200;
  assert.equal(
    (await readLocalHomeMonitor(signal(), request, now)).state,
    "held",
  );
});
test("home missing hosts, invalid IPs, redirects and oversized output cannot be accepted", async () => {
  const data = value();
  data.hosts["pi-firewall"]!.addresses.current[0]!.address =
    "untrusted.example";
  await assert.rejects(
    readLocalHomeMonitor(
      signal(),
      (async () => Response.json(data)) as typeof fetch,
      now,
    ),
  );
  await assert.rejects(
    readLocalHomeMonitor(
      signal(),
      (async () => new Response("redirect", { status: 302 })) as typeof fetch,
      now,
    ),
  );
  await assert.rejects(
    readLocalHomeMonitor(
      signal(),
      (async () => new Response("x".repeat(512 * 1024 + 1))) as typeof fetch,
      now,
    ),
  );
});
