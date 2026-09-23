import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BrowserDeviceClient } from "../modules/remote/browser-device-client.js";
import type {
  BrowserDeviceIdentity,
  VerifiedBrowserDeviceScope,
} from "../modules/remote/browser-device-contracts.js";
function fixture() {
  let now = 1800000000000,
    mono = 0;
  let context: { ownerId: string; scope: string } | null = {
    ownerId: randomUUID(),
    scope: "signed-session-1",
  };
  const binding = {
    ownerId: context.ownerId,
    deviceId: randomUUID(),
    credentialEpoch: 1,
    expiresAt: now + 7200000,
  };
  const identity: BrowserDeviceIdentity = {
    version: 1,
    binding,
    sessionExpiresAt: now + 3600000,
  };
  const calls: { path: string; body: any }[] = [];
  let answer: (path: string) => Promise<Response> = async () =>
    Response.json(identity);
  const transport: typeof fetch = async (url, init) => {
    assert.equal(init?.credentials, "same-origin");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.method, "POST");
    assert.ok(init?.signal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("cookie"), null);
    assert.equal(headers.get("X-Bittrees-Account"), binding.ownerId);
    assert.equal(headers.get("X-Bittrees-Request"), "1");
    assert.ok(
      String(url).startsWith("https://ai.bittrees.org/browser/registration/"),
    );
    const path = new URL(String(url)).pathname.split("/").at(-1)!;
    calls.push({ path, body: JSON.parse(String(init?.body)) });
    return answer(path);
  };
  const create = () =>
      new BrowserDeviceClient(
        () => context,
        transport,
        () => now,
        () => mono,
      ),
    client = create();
  return {
    client,
    create,
    binding,
    identity,
    calls,
    request: () => ({
      operationId: randomUUID(),
      expected: null,
      confirmed: true,
    }),
    answer(fn: typeof answer) {
      answer = fn;
    },
    time(n: number) {
      now += n;
    },
    mono(n: number) {
      mono += n;
    },
    context(c: typeof context) {
      context = c;
    },
  };
}
test("browser registration is explicit, confirms cookie identity, and supplies only a bounded fresh scope", async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.client.register(f.request()), f.identity);
  assert.deepEqual(
    f.calls.map((x) => x.path),
    ["create", "identity"],
  );
  let retained: VerifiedBrowserDeviceScope | undefined;
  const result = await f.client.withVerifiedDevice(f.binding, async (scope) => {
    retained = scope;
    assert.equal(scope.freshRegistration(f.binding), true);
    const copy = scope.current()!;
    copy.deviceId = randomUUID();
    assert.deepEqual(scope.current(), f.binding);
    return "bounded result";
  });
  assert.equal(result, "bounded result");
  assert.equal(retained!.current(), null);
  assert.equal(retained!.freshRegistration(f.binding), false);
  assert.deepEqual(
    f.calls.slice(2).map((x) => x.path),
    ["identity", "identity"],
  );
  await f.create().withVerifiedDevice(f.binding, async (scope) => {
    assert.equal(scope.freshRegistration(f.binding), false);
  });
  f.client.invalidate();
  await f.client.withVerifiedDevice(f.binding, async (scope) => {
    assert.equal(scope.freshRegistration(f.binding), false);
  });
});
test("missing or substituted registration cookie cannot create a fresh-registration claim", async () => {
  const f = fixture();
  f.answer(async (path) =>
    Response.json(
      path === "create"
        ? f.identity
        : { ...f.identity, binding: { ...f.binding, deviceId: randomUUID() } },
    ),
  );
  await assert.rejects(f.client.register(f.request()), /DENIED/);
  assert.equal(f.calls.filter((x) => x.path === "create").length, 1);
  f.answer(async () => Response.json(f.identity));
  await f.client.withVerifiedDevice(f.binding, async (scope) =>
    assert.equal(scope.freshRegistration(f.binding), false),
  );
});
test("verified browser scope rejects substituted fields, extra authority, malformed content and oversized response", async () => {
  for (const reply of [{ ...fixture().identity }, { version: 2 }]) {
    const f = fixture();
    f.answer(async () => Response.json(reply));
    await assert.rejects(
      f.client.withVerifiedDevice(f.binding, async () => assert.fail()),
      /INVALID_RESPONSE/,
    );
  }
  for (const field of ["deviceId", "credentialEpoch", "expiresAt"] as const) {
    const f = fixture();
    f.answer(async () =>
      Response.json({
        ...f.identity,
        binding: {
          ...f.binding,
          [field]:
            field === "deviceId"
              ? randomUUID()
              : (f.binding[field] as number) + 1,
        },
      }),
    );
    await assert.rejects(
      f.client.withVerifiedDevice(f.binding, async () => assert.fail()),
      /DENIED/,
    );
  }
  for (const mode of ["extra", "size", "mime", "json", "revoked"]) {
    const f = fixture();
    f.answer(async () =>
      mode === "extra"
        ? Response.json({ ...f.identity, permission: "all" })
        : mode === "size"
          ? Response.json("x".repeat(33000))
          : mode === "mime"
            ? new Response(JSON.stringify(f.identity), {
                headers: { "Content-Type": "text/plain" },
              })
            : mode === "json"
              ? new Response("{", {
                  headers: { "Content-Type": "application/json" },
                })
              : Response.json({ error: "DENIED" }, { status: 403 }),
    );
    await assert.rejects(
      f.client.withVerifiedDevice(f.binding, async () => assert.fail()),
      /DENIED|INVALID_RESPONSE/,
    );
  }
});
test("expired session/device and wall or monotonic timeout deny callbacks and invalidate retained scopes", async () => {
  for (const mode of ["session", "device", "wall", "mono", "rollback"]) {
    const f = fixture();
    let entered = false;
    f.answer(async () => {
      if (mode === "wall") f.time(30000);
      if (mode === "mono") f.mono(30000);
      if (mode === "rollback") f.time(-1);
      return Response.json(
        mode === "session"
          ? { ...f.identity, sessionExpiresAt: 1 }
          : mode === "device"
            ? { ...f.identity, binding: { ...f.binding, expiresAt: 1 } }
            : f.identity,
      );
    });
    await assert.rejects(
      f.client.withVerifiedDevice(f.binding, async () => {
        entered = true;
      }),
      /DENIED/,
    );
    assert.equal(entered, false);
  }
  const f = fixture();
  let retained: VerifiedBrowserDeviceScope | undefined;
  await assert.rejects(
    f.client.withVerifiedDevice(f.binding, async (scope) => {
      retained = scope;
      f.mono(30000);
      assert.equal(scope.current(), null);
    }),
    /DENIED/,
  );
  assert.equal(retained!.current(), null);
});
test("host invalidation, same-account session change and account switch suppress late identity responses", async () => {
  for (const change of ["invalidate", "session", "account", "logout"]) {
    const f = fixture();
    let release!: () => void, called!: () => void;
    const entered = new Promise<void>((r) => {
      called = r;
    });
    f.answer(async () => {
      called();
      await new Promise<void>((r) => {
        release = r;
      });
      return Response.json(f.identity);
    });
    const pending = assert.rejects(
      f.client.withVerifiedDevice(f.binding, async () =>
        assert.fail("late identity reached host"),
      ),
      /DENIED/,
    );
    await entered;
    if (change === "invalidate") f.client.invalidate();
    else
      f.context(
        change === "logout"
          ? null
          : {
              ownerId: change === "account" ? randomUUID() : f.binding.ownerId,
              scope: "new-session",
            },
      );
    release();
    await pending;
    assert.equal(f.calls.length, 1);
  }
});
test("post-operation revalidation denies revocation or a changed cookie and never repeats the action", async () => {
  for (const changed of [false, true]) {
    const f = fixture();
    let calls = 0,
      actions = 0,
      retained: VerifiedBrowserDeviceScope | undefined;
    f.answer(async () =>
      ++calls === 1
        ? Response.json(f.identity)
        : changed
          ? Response.json({
              ...f.identity,
              binding: { ...f.binding, deviceId: randomUUID() },
            })
          : Response.json({ error: "DENIED" }, { status: 403 }),
    );
    await assert.rejects(
      f.client.withVerifiedDevice(f.binding, async (scope) => {
        retained = scope;
        actions++;
        return "do not publish";
      }),
      /DENIED/,
    );
    assert.equal(actions, 1);
    assert.equal(retained!.current(), null);
    assert.equal(f.calls.length, 2);
  }
});
test("one client excludes overlapping operations and scopes expire after callback exceptions", async () => {
  const f = fixture();
  let release!: () => void, called!: () => void;
  const entered = new Promise<void>((r) => {
    called = r;
  });
  const pending = f.client.withVerifiedDevice(f.binding, async () => {
    called();
    await new Promise<void>((r) => {
      release = r;
    });
    return "ok";
  });
  await entered;
  await assert.rejects(f.client.register(f.request()), /BUSY/);
  assert.equal(f.calls.filter((x) => x.path === "create").length, 0);
  release();
  assert.equal(await pending, "ok");
  let scope: VerifiedBrowserDeviceScope | undefined;
  await assert.rejects(
    f.client.withVerifiedDevice(f.binding, async (s) => {
      scope = s;
      throw Error("callback failed");
    }),
    /callback failed/,
  );
  assert.equal(scope!.current(), null);
});
test("fresh observation expires independently and cannot be revived by clock rollback", async () => {
  const f = fixture();
  await f.client.register(f.request());
  f.time(120000);
  f.mono(120000);
  await f.client.withVerifiedDevice(f.binding, async (s) =>
    assert.equal(s.freshRegistration(f.binding), false),
  );
  const b = fixture();
  await b.client.register(b.request());
  b.time(-1);
  b.mono(-1);
  await b.client.withVerifiedDevice(b.binding, async (s) =>
    assert.equal(s.freshRegistration(b.binding), false),
  );
});
test("inspection/list/revocation reject cross-owner or substituted output and malformed requests send nothing", async () => {
  const f = fixture();
  f.answer(async (path) =>
    Response.json(
      path === "inspect"
        ? {
            version: 1,
            ownerId: f.binding.ownerId,
            sessionExpiresAt: f.identity.sessionExpiresAt,
            registration: null,
          }
        : path === "list"
          ? {
              version: 1,
              ownerId: f.binding.ownerId,
              items: [],
              nextCursor: null,
            }
          : { revoked: true, deviceId: f.binding.deviceId },
    ),
  );
  assert.equal((await f.client.inspect()).registration, null);
  assert.deepEqual((await f.client.list()).items, []);
  assert.equal(
    (
      await f.client.revoke({
        deviceId: f.binding.deviceId,
        credentialEpoch: 1,
        confirmed: true,
      })
    ).revoked,
    true,
  );
  const before = f.calls.length;
  for (const bad of [
    { expected: null },
    { ...f.request(), confirmed: false },
    { ...f.request(), ownerId: f.binding.ownerId },
  ])
    await assert.rejects(f.client.register(bad));
  await assert.rejects(
    f.client.revoke({
      deviceId: f.binding.deviceId,
      credentialEpoch: 1,
      confirmed: false,
    }),
  );
  assert.equal(f.calls.length, before);
  f.answer(async () =>
    Response.json({
      version: 1,
      ownerId: randomUUID(),
      items: [],
      nextCursor: null,
    }),
  );
  await assert.rejects(f.client.list(), /INVALID_RESPONSE/);
});

test("browser transport preserves bounded status codes and never exposes network or server error text", async () => {
  for (const [status, expected] of [
    [409, "CONFLICT"],
    [429, "CAPACITY"],
    [503, "UNAVAILABLE"],
    [403, "DENIED"],
  ] as const) {
    const f = fixture();
    f.answer(async () =>
      Response.json({ error: "PRIVATE_SERVER_DETAIL" }, { status }),
    );
    await assert.rejects(
      f.client.inspect(),
      new RegExp("^Error: " + expected + "$"),
    );
  }
  const f = fixture();
  f.answer(async () => {
    throw Error("PRIVATE_TRANSPORT_DETAIL");
  });
  await assert.rejects(f.client.inspect(), /^Error: UNAVAILABLE$/);
  f.answer(
    async () =>
      new Response(JSON.stringify(f.identity), {
        headers: { "content-type": "application/jsonp" },
      }),
  );
  await assert.rejects(
    f.client.withVerifiedDevice(f.binding, async () => assert.fail()),
    /DENIED/,
  );
});

test("caller edits to returned registration data cannot forge a fresh observation for another cookie identity", async () => {
  const f = fixture();
  const returned = await f.client.register(f.request());
  const otherBinding = { ...returned.binding, deviceId: randomUUID() };
  Object.assign(returned.binding, otherBinding);
  // A different valid same-owner cookie may be selected by another tab, but it
  // was not the registration this client explicitly observed being created.
  f.answer(async () => Response.json({ ...f.identity, binding: otherBinding }));
  await f.client.withVerifiedDevice(otherBinding, async (scope) => {
    assert.deepEqual(scope.current(), otherBinding);
    assert.equal(scope.freshRegistration(otherBinding), false);
  });
});

// Native browser fetch rejects an arbitrary class-instance receiver.
test("default transport keeps the browser fetch receiver", async () => {
  const ownerId = randomUUID();
  const previous = globalThis.fetch;
  globalThis.fetch = async function (this: unknown) {
    assert.equal(this, globalThis);
    return Response.json({
      version: 1,
      ownerId,
      sessionExpiresAt: Date.now() + 60000,
      registration: null,
    });
  };
  try {
    const client = new BrowserDeviceClient(() => ({
      ownerId,
      scope: "session",
    }));
    assert.equal((await client.inspect()).ownerId, ownerId);
  } finally {
    globalThis.fetch = previous;
  }
});
