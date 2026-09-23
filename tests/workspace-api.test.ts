import test from "node:test";
import assert from "node:assert/strict";
import { workspaceApi } from "../apps/dashboard/workspace-api.js";
import { createLocalApi } from "../apps/dashboard/local-api.js";

test("workspace scope drops late success and denial after lock without retrying accepted writes", async () => {
  for (const denied of [false, true]) {
    let release!: () => void,
      requests = 0;
    const transport = createLocalApi((async () => {
      requests++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return denied
        ? Response.json({ error: "UNAUTHORIZED" }, { status: 401 })
        : Response.json({ text: "old workspace" });
    }) as typeof fetch);
    const scope = workspaceApi(transport);
    let shown = false;
    const read = scope
      .api("/v1/requests", "POST", { prompt: "synthetic" })
      .then(() => {
        shown = true;
      });
    const rejected = assert.rejects(read, /^Error: WORKSPACE_CHANGED$/);
    scope.invalidate();
    release();
    await rejected;
    assert.equal(shown, false);
    await assert.rejects(scope.api("/v1/requests"), /WORKSPACE_CHANGED/);
    assert.equal(requests, 1);
  }
});
test("workspace invalidation prevents a continuation from changing a default profile and leaves new pairing independent", async () => {
  const calls: string[] = [];
  let release!: () => void;
  const transport = createLocalApi((async (path) => {
    calls.push(String(path));
    if (path === "/v1/profiles")
      await new Promise<void>((r) => {
        release = r;
      });
    return Response.json({ id: "profile" });
  }) as typeof fetch);
  const old = workspaceApi(transport);
  const action = (async () => {
    const profile = await old.api("/v1/profiles", "POST", {
      model: "synthetic",
    });
    await old.api("/v1/profiles/default", "PUT", { profileId: profile.id });
  })();
  const rejected = assert.rejects(action, /WORKSPACE_CHANGED/);
  old.invalidate();
  const current = workspaceApi(transport);
  assert.deepEqual(await current.api("/v1/health"), { id: "profile" });
  release();
  await rejected;
  assert.deepEqual(calls, ["/v1/profiles", "/v1/health"]);
  await assert.rejects(old.api("/logout", "POST"), /WORKSPACE_CHANGED/);
  assert.deepEqual(await current.api("/v1/health"), { id: "profile" });
});
test("active workspace preserves errors, empty success, exact payload and idempotency", async () => {
  const calls: any[] = [];
  let response = new Response(null, { status: 204 });
  const scope = workspaceApi(
    createLocalApi((async (...args) => {
      calls.push(args);
      return response;
    }) as typeof fetch),
  );
  assert.equal(
    await scope.api(
      "/v1/requests",
      "POST",
      { prompt: "synthetic" },
      { "Idempotency-Key": "same-request" },
    ),
    null,
  );
  assert.equal(calls[0][1].headers["Idempotency-Key"], "same-request");
  assert.equal(calls[0][1].body, '{"prompt":"synthetic"}');
  response = Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  await assert.rejects(scope.api("/v1/health"), /^Error: UNAUTHORIZED$/);
  assert.equal(calls.length, 2);
});
