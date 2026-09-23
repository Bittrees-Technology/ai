import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import {
  defaultProfileFields,
  readProfileFields,
  profileLabel,
} from "../apps/dashboard/model-profile-settings.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { Ollama } from "../modules/models/ollama.js";
import { LocalWorker } from "../apps/companion/worker.js";
import { localApi } from "../apps/companion/http.js";

test("profile fields preserve defaults and reject incomplete, unbounded and unusable budgets", () => {
  assert.deepEqual(readProfileFields(defaultProfileFields).value, {
    contextTokens: 4096,
    maxOutputTokens: 512,
    temperature: 0.2,
  });
  for (const patch of [
    { context: "" },
    { output: " " },
    { context: "4096.5" },
    { output: "8193" },
    { temperature: "Infinity" },
    { temperature: "-0.1" },
    { temperature: "2.1" },
    { context: "131073" },
    { context: "768" },
  ]) {
    assert.equal(
      readProfileFields({ ...defaultProfileFields, ...patch }).value,
      null,
    );
  }
  assert.deepEqual(
    readProfileFields({ context: "769", output: "512", temperature: "0" })
      .value,
    { contextTokens: 769, maxOutputTokens: 512, temperature: 0 },
  );
  assert.deepEqual(
    readProfileFields({ context: "131072", output: "8192", temperature: "2" })
      .value,
    { contextTokens: 131072, maxOutputTokens: 8192, temperature: 2 },
  );
});
test("same-model profile choices disclose differing settings and retain an ID fallback for older projections", () => {
  const first = {
    id: "first",
    model: "synthetic",
    contextTokens: 4096,
    maxOutputTokens: 512,
    temperature: 0.2,
  };
  const other = { ...first, id: "second", temperature: 0.35 };
  assert.notEqual(profileLabel(first), profileLabel(other));
  assert.match(
    profileLabel(first),
    /4,096 context.*512 reply limit.*0.2 variation/,
  );
  assert.equal(
    profileLabel({ model: "synthetic", id: "legacy" }),
    "synthetic · legacy",
  );
});
test("custom profile settings pass authenticated API and actual adapter to the worker without rewriting older task selections or history", async () => {
  const options: unknown[] = [];
  const runtimeServer = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/tags")
      res.end(
        JSON.stringify({
          models: [
            { name: "synthetic:local", digest: "a".repeat(64), size: 100 },
          ],
        }),
      );
    else if (req.url === "/api/show")
      res.end(JSON.stringify({ capabilities: ["completion"] }));
    else if (req.url === "/api/generate") {
      assert.equal(body.keep_alive, 0);
      assert.equal(body.stream, false);
      assert.equal("tools" in body, false);
      options.push(body.options);
      res.end(JSON.stringify({ response: "Synthetic draft", done: true }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) =>
    runtimeServer.listen(0, "127.0.0.1", resolve),
  );
  const runtime = new Ollama(
    `http://127.0.0.1:${(runtimeServer.address() as AddressInfo).port}`,
  );
  const store = new Store(":memory:", new Vault(randomBytes(32))),
    owner = { userId: "synthetic", tenantId: "personal" };
  const server = createServer(),
    token = randomBytes(32).toString("hex");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  server.on("request", localApi({ store, owner, token, port, runtime }));
  const call = (
    path: string,
    method = "GET",
    body?: unknown,
    authenticated = true,
  ) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(authenticated ? { Authorization: "Bearer " + token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const baseline = {
    id: "baseline",
    runtime: "ollama",
    model: "synthetic:local",
    ...readProfileFields(defaultProfileFields).value!,
  };
  const custom = {
    ...baseline,
    id: "custom",
    ...readProfileFields({
      context: "8192",
      output: "1024",
      temperature: "0.35",
    }).value!,
  };
  try {
    assert.equal(
      (await call("/v1/profiles", "POST", custom, false)).status,
      401,
    );
    assert.equal((await call("/v1/profiles", "POST", baseline)).status, 201);
    assert.equal(
      (await call("/v1/profiles/default", "PUT", { profileId: baseline.id }))
        .status,
      204,
    );
    const oldTask = store.create(
      owner,
      {
        conversationId: "old",
        kind: "query",
        prompt: "Synthetic old request",
        modelProfileId: store.defaultProfile(owner)!.id,
      },
      "old",
    );
    assert.equal((await call("/v1/profiles", "POST", custom)).status, 201);
    assert.equal(
      (await call("/v1/profiles/default", "PUT", { profileId: custom.id }))
        .status,
      204,
    );
    assert.equal(
      (
        await call("/v1/profiles", "POST", {
          ...custom,
          id: "invalid",
          contextTokens: 1024,
        })
      ).status,
      400,
    );
    assert.equal(
      (await call("/v1/profiles", "POST", { ...baseline, temperature: 1 }))
        .status,
      409,
    );
    assert.equal(
      store.get(owner, oldTask.id).input.modelProfileId,
      baseline.id,
    );
    const newTask = store.create(
      owner,
      {
        conversationId: "new",
        kind: "query",
        prompt: "Synthetic new request",
        modelProfileId: store.defaultProfile(owner)!.id,
      },
      "new",
    );
    const worker = new LocalWorker(store, owner, runtime, (id) =>
      store.profile(owner, id),
    );
    assert.equal(await worker.runOnce(), true);
    assert.equal(await worker.runOnce(), true);
    assert.deepEqual(options, [
      { num_ctx: 4096, num_predict: 512, temperature: 0.2 },
      { num_ctx: 8192, num_predict: 1024, temperature: 0.35 },
    ]);
    store.setDefaultProfile(owner, baseline.id);
    for (const [task, profile] of [
      [oldTask, baseline],
      [newTask, custom],
    ] as const) {
      assert.equal(store.get(owner, task.id).status, "completed");
      const response = await call(`/v1/requests/${task.id}/runs`);
      assert.equal(response.status, 200);
      const history = (await response.json()) as any;
      assert.deepEqual(history.items[0].model.profile, profile);
    }
    assert.equal(
      ((await (await call("/v1/profiles")).json()) as any).items.length,
      2,
    );
  } finally {
    server.closeAllConnections();
    runtimeServer.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => runtimeServer.close(() => resolve())),
    ]);
    store.close();
  }
});
