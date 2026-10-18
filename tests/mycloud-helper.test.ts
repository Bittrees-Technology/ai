import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  myCloudHelper,
  helperMyCloudCheck,
} from "../modules/workflows/mycloud-helper.js";
async function fixture(
  check: (s: AbortSignal) => Promise<string>,
  authorize = async () => true,
) {
  const token = "a".repeat(64);
  const helper = myCloudHelper({ token, check, authorize });
  await new Promise<void>((r) => helper.server.listen(0, "127.0.0.1", r));
  const a = helper.server.address() as { port: number };
  return {
    ...helper,
    token,
    url: `http://127.0.0.1:${a.port}`,
    post: (body: unknown, credential = token) =>
      fetch(`http://127.0.0.1:${a.port}/health`, {
        method: "POST",
        headers: {
          authorization: "Bearer " + credential,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
  };
}
test("only fixed authenticated typed health operation executes, no command/destination/args allowed", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return '{"health":"ok"}';
  });
  try {
    assert.equal(
      (await f.post({ operationId: randomUUID() }, "bad")).status,
      403,
    );
    for (const extra of [
      { command: "id" },
      { destination: "other" },
      { args: [] },
    ])
      assert.equal(
        (await f.post({ operationId: randomUUID(), ...extra })).status,
        400,
      );
    assert.equal(calls, 0);
    const id = randomUUID();
    const first = await (await f.post({ operationId: id })).json();
    assert.equal(first.operationId, id);
    assert.deepEqual(await (await f.post({ operationId: id })).json(), first);
    assert.equal(calls, 1);
    assert.equal((await f.post({ operationId: randomUUID() })).status, 429);
  } finally {
    await f.close();
  }
});
test("source revocation denies new and completed receipt delivery", async () => {
  let authorized = false,
    calls = 0;
  const f = await fixture(
    async () => {
      calls++;
      authorized = false;
      return "{}";
    },
    async () => authorized,
  );
  try {
    assert.equal((await f.post({ operationId: randomUUID() })).status, 403);
    authorized = true;
    assert.equal((await f.post({ operationId: randomUUID() })).status, 503);
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});
test("helper client rejects remote endpoints before any request; local exact receipt returns", async () => {
  await assert.rejects(
    helperMyCloudCheck(
      "http://example.com:80",
      "a".repeat(64),
      new AbortController().signal,
    ),
  );
  const f = await fixture(async () => "{}");
  try {
    assert.equal(
      await helperMyCloudCheck(f.url, f.token, new AbortController().signal),
      "{}",
    );
  } finally {
    await f.close();
  }
});
test("browser-origin and arbitrary paths cannot invoke helper", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return "{}";
  });
  try {
    for (const path of ["/health", "/proxy"]) {
      const r = await fetch(f.url + path, {
        method: "POST",
        headers: {
          authorization: "Bearer " + f.token,
          origin: "http://127.0.0.1:43127",
        },
        body: JSON.stringify({ operationId: randomUUID() }),
      });
      assert.equal(r.status, 403);
    }
    assert.equal(calls, 0);
  } finally {
    await f.close();
  }
});
test("helper callback is one-bit, current-authority checked and cannot authenticate general APIs", async () => {
  const { localApi } = await import("../apps/companion/http.js");
  const { Store } = await import("../modules/storage/store.js");
  const { Vault } = await import("../modules/storage/vault.js");
  const { MyCloudSource } =
    await import("../modules/workflows/recurring-mycloud-source.js");
  const { createServer } = await import("node:http");
  const { randomBytes } = await import("node:crypto");
  const vault = new Vault(randomBytes(32)),
    store = new Store(":memory:", vault);
  let allowed = false;
  const source = new MyCloudSource(":memory:", vault, {
    authorized: () => allowed,
  });
  const token = "b".repeat(64),
    helperToken = "c".repeat(64);
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  server.on(
    "request",
    localApi({
      store,
      owner: { userId: "local", tenantId: "local" },
      port,
      token,
      myCloudSource: source,
      myCloudHelperToken: helperToken,
    }),
  );
  const url = `http://127.0.0.1:${port}`;
  try {
    const headers = { authorization: "Bearer " + helperToken };
    assert.equal(
      (await fetch(url + "/internal/mycloud-approval", { headers })).status,
      403,
    );
    allowed = true;
    assert.equal(
      await (
        await fetch(url + "/internal/mycloud-approval", { headers })
      ).text(),
      "approved",
    );
    assert.equal(
      (await fetch(url + "/v1/workflows/mycloud-health", { headers })).status,
      401,
    );
    assert.equal(
      (
        await fetch(url + "/internal/mycloud-approval", {
          headers: { ...headers, origin: url },
        })
      ).status,
      403,
    );
    allowed = false;
    assert.equal(
      (await fetch(url + "/internal/mycloud-approval", { headers })).status,
      403,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    source.close();
    store.close();
  }
});
