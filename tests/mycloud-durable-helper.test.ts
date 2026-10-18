import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  myCloudHelper,
  helperMyCloudCheck,
} from "../modules/workflows/mycloud-helper.js";
import { MyCloudOperationJournal } from "../modules/workflows/mycloud-operation-journal.js";
import { MyCloudSource } from "../modules/workflows/recurring-mycloud-source.js";
import { localRecurringHost } from "../modules/workflows/recurring-host.js";
import type { RecurringDefinition } from "../modules/workflows/recurring.js";
import { Vault } from "../modules/storage/vault.js";
const token = "a".repeat(64),
  revision = "b".repeat(64);
async function fixture(
  path: string,
  check: (signal: AbortSignal) => Promise<string>,
  authorize: () => Promise<string | null> = async () => revision,
  now = Date.now,
) {
  const helper = myCloudHelper({
    token,
    journalPath: path,
    authorize,
    check,
    now,
  });
  await new Promise<void>((resolve) =>
    helper.server.listen(0, "127.0.0.1", resolve),
  );
  const address = helper.server.address();
  if (!address || typeof address === "string") throw Error("No helper address");
  const url = "http://127.0.0.1:" + address.port;
  return {
    ...helper,
    url,
    post: (body: unknown, suppliedToken = token) =>
      fetch(url + "/health", {
        method: "POST",
        headers: {
          authorization: "Bearer " + suppliedToken,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
  };
}
test("stable core IDs return cached response once, then hold after helper restart without re-execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "mycloud-protocol-")),
    path = join(root, "journal.db"),
    id = "c".repeat(64);
  let calls = 0;
  try {
    let f = await fixture(path, async () => {
      calls++;
      return "private-health";
    });
    try {
      const first = await f.post({ operationId: id });
      assert.equal(first.status, 200);
      const receipt = await first.json();
      const repeat = await f.post({ operationId: id });
      assert.equal(repeat.status, 200);
      assert.deepEqual(await repeat.json(), receipt);
      assert.equal(calls, 1);
      assert.equal(
        (await f.post({ operationId: randomUUID(), command: "arbitrary" }))
          .status,
        400,
      );
      assert.equal(
        (await f.post({ operationId: randomUUID() }, "bad")).status,
        403,
      );
    } finally {
      await f.close();
    }
    f = await fixture(
      path,
      async () => {
        calls++;
        return "must-not-run";
      },
      async () => revision,
      () => Date.now() + 120000,
    );
    try {
      assert.equal((await f.post({ operationId: id })).status, 409);
      assert.equal(calls, 1);
    } finally {
      await f.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("uncertain outcome and rate gates survive restart without new source requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "mycloud-protocol-")),
    path = join(root, "journal.db"),
    id = "verify:" + randomUUID();
  let calls = 0;
  try {
    let f = await fixture(path, async () => {
      calls++;
      throw Error("private stderr");
    });
    try {
      const response = await f.post({ operationId: id });
      assert.equal(response.status, 503);
      assert.ok(!(await response.text()).includes("private"));
    } finally {
      await f.close();
    }
    f = await fixture(path, async () => {
      calls++;
      return "must-not-run";
    });
    try {
      assert.equal((await f.post({ operationId: id })).status, 409);
      assert.equal((await f.post({ operationId: randomUUID() })).status, 429);
      assert.equal(calls, 1);
    } finally {
      await f.close();
    }
    const journal = new MyCloudOperationJournal(path);
    try {
      assert.equal(journal.get(id)?.state, "uncertain");
    } finally {
      journal.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("changing the exact current approval revision invalidates an in-flight result and cached replay", async () => {
  let current = revision;
  const f = await fixture(
    ":memory:",
    async () => {
      current = "d".repeat(64);
      return "data";
    },
    async () => current,
  );
  const id = randomUUID();
  try {
    assert.equal((await f.post({ operationId: id })).status, 503);
    assert.equal((await f.post({ operationId: id })).status, 409);
  } finally {
    await f.close();
  }
  let authorized = true;
  const cached = await fixture(
    ":memory:",
    async () => "data",
    async () => (authorized ? revision : null),
  );
  try {
    assert.equal((await cached.post({ operationId: id })).status, 200);
    authorized = false;
    assert.equal((await cached.post({ operationId: id })).status, 403);
  } finally {
    await cached.close();
  }
});
test("MyCloud accepted encrypted receipt retains exact core operation ID through client and helper", async () => {
  const raw = JSON.stringify({
    checked_at: new Date().toISOString(),
    issues: [],
    readings: {
      var: { used_percent: 40 },
      data: { used_percent: 17 },
      smart_passed: true,
      temperature_c: 58,
      reallocated_sectors: 0,
      pending_sectors: 0,
      uncorrectable_sectors: 0,
      smb_active: true,
      logrotate_result: "success",
    },
  });
  const root = mkdtempSync(join(tmpdir(), "mycloud-protocol-")),
    path = join(root, "journal.db"),
    id = "e".repeat(64);
  const f = await fixture(path, async () => raw);
  const source = new MyCloudSource(":memory:", new Vault(randomBytes(32)), {
    authorized: () => true,
    check: (signal, operationId) =>
      helperMyCloudCheck(f.url, token, signal, operationId),
  });
  try {
    const receipt = await source.read(new AbortController().signal, id);
    assert.equal((receipt.evidence as any).operationId, id);
    assert.equal(
      (
        (
          source.status().lastAccepted?.receipt as
            { evidence: { operationId: string } } | undefined
        )?.evidence as any
      ).operationId,
      id,
    );
    assert.equal(source.outbox().length, 0);
    const journal = new MyCloudOperationJournal(path);
    try {
      assert.ok(journal.matchesCached(id, revision, raw));
    } finally {
      journal.close();
    }
    await assert.rejects(
      helperMyCloudCheck(
        "https://example.invalid",
        token,
        new AbortController().signal,
        id,
      ),
      /endpoint/,
    );
  } finally {
    source.close();
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("native recurring host forwards stable operation ID to the reviewed collector", async () => {
  const d: RecurringDefinition = {
    id: "mycloud-health-checks",
    name: "MyCloud",
    instructions: "Read health",
    executionBrief: "Read health",
    rrule: "FREQ=HOURLY;INTERVAL=1",
    timezone: "Europe/Lisbon",
    anchor: 1,
    sourceFingerprint: "a".repeat(64),
    originalState: "active",
    modelProfileId: randomUUID(),
    collect: {
      id: "local.mycloud.health",
      capability: "local.mycloud.health",
      arguments: { sourceAutomationId: "mycloud-health-checks" },
    },
    actions: [],
    mode: "monitor",
    additionalSpendingUSD: 0,
  };
  let captured = "";
  const host = localRecurringHost({
    automationRoot: "/unused",
    runtime: {} as never,
    profile: () => ({}),
    turn: async (_signal, work) => work(),
    admission: () => true,
    cutoverReady: () => false,
    recordDecision: () => {},
    collectors: new Map([
      [
        "local.mycloud.health",
        {
          capability: "local.mycloud.health",
          read: async (_signal, id) => {
            captured = id;
            return {
              state: "confirmed",
              observedAt: Date.now(),
              fingerprint: "b".repeat(64),
              evidence: {},
            };
          },
        },
      ],
    ]),
  });
  const id = "f".repeat(64);
  await host.execute(d, d.collect, id, new AbortController().signal);
  assert.equal(captured, id);
});
