import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { RemoteClient } from "../modules/remote/client.js";
import { localApi } from "../apps/companion/http.js";

test("Local remote controls require consent, select owner tasks and protect in-flight deletion and retry", async () => {
  const owner = { userId: "local-owner", tenantId: "personal" };
  const store = new Store(":memory:", new Vault(randomBytes(32)));
  const input = {
    conversationId: "PRIVATE_CONVERSATION",
    kind: "draft",
    prompt: "PRIVATE_PROMPT",
    modelProfileId: "PRIVATE_MODEL",
    dependencies: [],
    priority: "normal",
    tags: [],
  };
  const own = store.create(owner, input, randomUUID()),
    other = store.create(
      { userId: "other", tenantId: "personal" },
      input,
      randomUUID(),
    );
  const grant = {
    deviceId: randomUUID(),
    ownerId: randomUUID(),
    epoch: 1,
    credential: randomBytes(32).toString("base64url"),
    expiresAt: Date.now() + 3600000,
    scope: "status:publish",
  };
  let saved: Uint8Array | undefined = Buffer.from(
    JSON.stringify({
      localOwner: JSON.stringify(owner),
      grant,
      sequence: 1,
      mode: "active",
    }),
  );
  const secret = {
    getSecret: async () => saved,
    setSecret: async (v: Uint8Array) => {
      saved = Uint8Array.from(v);
    },
    deleteCredential: async () => {
      saved = undefined;
      return true;
    },
  };
  let release: () => void = () => {},
    started: () => void = () => {};
  const startedPromise = new Promise<void>((r) => {
    started = r;
  });
  const releasePromise = new Promise<void>((r) => {
    release = r;
  });
  const sent: unknown[] = [];
  let loseResponse = false;
  const transport: typeof fetch = async (_url, init) => {
    const batch = JSON.parse(String(init?.body));
    sent.push(batch);
    if (sent.length === 1) {
      started();
      await releasePromise;
    }
    if (loseResponse) throw Error("lost response");
    return Response.json({ sequence: batch.sequence, duplicate: false });
  };
  const remote = new RemoteClient(JSON.stringify(owner), secret, transport);
  const token = randomBytes(32).toString("hex"),
    server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port,
    url = `http://127.0.0.1:${port}`;
  server.on("request", localApi({ store, owner, token, port, remote }));
  const headers = {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  };
  const post = (path: string, body: unknown) =>
    fetch(url + path, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(url + "/v1/remote")).status, 401);
    assert.equal(
      (
        await fetch(url + "/v1/remote", {
          headers: { ...headers, Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    const status = await (await fetch(url + "/v1/remote", { headers })).json();
    assert.equal(status.automaticSharing, false);
    assert.equal(JSON.stringify(status).includes(grant.credential), false);
    const selection = {
      confirmed: true,
      tasks: [{ id: own.id, revision: own.revision }],
    };
    for (const action of ["enable", "disable", "check"]) {
      assert.equal(
        (await post(`/v1/remote/controls/${action}`, { confirmed: false }))
          .status,
        400,
      );
      assert.equal(
        (
          await post(`/v1/remote/controls/${action}`, {
            confirmed: true,
            ownerId: "forged",
          })
        ).status,
        400,
      );
    }
    assert.equal(
      (await post("/v1/remote/publish", { ...selection, confirmed: false }))
        .status,
      400,
    );
    assert.equal(
      (await post("/v1/remote/publish", { ...selection, ownerId: "other" }))
        .status,
      400,
    );
    assert.equal(
      (
        await post("/v1/remote/publish", {
          confirmed: true,
          tasks: [{ id: other.id, revision: other.revision }],
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await post("/v1/remote/publish", {
          confirmed: true,
          tasks: [{ id: own.id, revision: own.revision + 1 }],
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await post("/v1/remote/publish", {
          confirmed: true,
          tasks: [{ ...selection.tasks[0], prompt: "caller text" }],
        })
      ).status,
      400,
    );
    assert.equal(sent.length, 0);
    const publication = post("/v1/remote/publish", selection);
    await startedPromise;
    const deletionHeaders = {
      ...headers,
      "X-Confirm-Delete": "all-local-task-data",
    };
    assert.equal(
      (
        await fetch(url + "/v1/data", {
          method: "DELETE",
          headers: deletionHeaders,
        })
      ).status,
      409,
    );
    release();
    assert.equal((await publication).status, 200);
    assert.equal(JSON.stringify(sent).includes("PRIVATE"), false);
    loseResponse = true;
    assert.equal((await post("/v1/remote/publish", selection)).status, 400);
    assert.equal(
      (
        await fetch(url + "/v1/data", {
          method: "DELETE",
          headers: deletionHeaders,
        })
      ).status,
      204,
    );
    const calls = sent.length;
    assert.equal(
      (await post("/v1/remote/retry", { confirmed: true })).status,
      400,
    );
    assert.equal(JSON.parse(Buffer.from(saved!).toString()).pending, undefined);
    assert.equal((await remote.status())!.state, "pairing_required");
    assert.equal(sent.length, calls);
    assert.equal(
      (await fetch(url + "/v1/remote/local", { method: "DELETE", headers }))
        .status,
      400,
    );
    const forgotten = await fetch(url + "/v1/remote/local", {
      method: "DELETE",
      headers: {
        ...headers,
        "X-Confirm-Delete": "local-remote-connection-only",
      },
    });
    assert.equal(forgotten.status, 200);
    assert.equal((await forgotten.json()).remoteRevocationConfirmed, false);
    assert.equal(saved, undefined);
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});

test("Remote local endpoints are unavailable when no client is configured", async () => {
  const store = new Store(":memory:", new Vault(randomBytes(32))),
    token = randomBytes(32).toString("hex"),
    server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  server.on(
    "request",
    localApi({ store, owner: { userId: "a", tenantId: "b" }, port, token }),
  );
  try {
    const headers = {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    };
    assert.deepEqual(
      await (
        await fetch(`http://127.0.0.1:${port}/v1/remote`, { headers })
      ).json(),
      { available: false, connection: null, automaticSharing: false },
    );
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${port}/v1/remote/begin`, {
          method: "POST",
          headers,
          body: JSON.stringify({ confirmed: true }),
        })
      ).status,
      404,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});
