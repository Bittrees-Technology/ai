import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { RolesConnector } from "../modules/connectors/roles.js";
async function fixture() {
  let secret: Uint8Array | undefined,
    now = Date.now(),
    deny = false,
    disconnectFails = false;
  let waitRead: (() => Promise<void>) | undefined;
  const grant = {
    token: "f".repeat(64),
    grantId: randomUUID(),
    profileId: randomUUID(),
    actions: ["read_own_access"],
    expiresAt: new Date(now + 86400000).toISOString(),
    policyRevision: "roles-ai-own-access-v1",
  };
  const projection: any = {
    contractVersion: "1.0.0",
    profileId: grant.profileId,
    mode: "own_access_observations",
    items: [
      {
        kind: "role",
        label: "Moderator",
        source: "gov.bittrees.org",
        beneficiary: "0x" + "1".repeat(40),
        scope: null,
        observedAt: new Date(now).toISOString(),
        reportedEffect: null,
        reportedStatus: null,
        expiresAt: null,
        policyVersion: null,
        observation: "current",
        authorityConfirmed: "not_verified",
        effectiveAccess: "not_verified",
        enforcementAcknowledged: "not_verified",
        executable: false,
        manageUrl: "https://roles.bittrees.org/profile",
      },
    ],
    grantAuthority: false,
    coverage:
      "Verified linked wallet observations only; email-based matching and live authority decisions are not included.",
    manageUrl: "https://roles.bittrees.org/profile",
  };
  const storage = {
    getSecret: async () => secret,
    setSecret: async (v: Uint8Array) => {
      secret = v;
    },
    deleteCredential: async () => {
      secret = undefined;
      return true;
    },
  };
  const calls: string[] = [];
  let mutate: (v: any) => any = (v) => v;
  const transport: typeof fetch = async (url, init) => {
    const path = String(url);
    assert.ok(
      path.startsWith("https://roles.bittrees.org/api/integrations/ai/"),
    );
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    calls.push(path);
    if (path.endsWith("/exchange")) {
      assert.match(
        JSON.parse(String(init?.body)).verifier,
        /^[A-Za-z0-9_-]{43}$/,
      );
      return Response.json(grant);
    }
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer " + grant.token,
    );
    assert.deepEqual(JSON.parse(String(init?.body)), {});
    if (path.endsWith("/disconnect")) {
      if (disconnectFails) throw Error("PRIVATE_ERROR " + grant.token);
      return Response.json({ ok: true });
    }
    await waitRead?.();
    if (deny) return new Response("PRIVATE_SOURCE_ERROR", { status: 403 });
    return Response.json(
      mutate({
        grantId: grant.grantId,
        expiresAt: grant.expiresAt,
        policyRevision: grant.policyRevision,
        projection: {
          ...projection,
          projectionHash: createHash("sha256")
            .update(JSON.stringify(projection))
            .digest("hex"),
        },
      }),
    );
  };
  const make = (owner = "local") =>
    new RolesConnector(owner, storage, transport, () => now);
  const connector = make(),
    start = await connector.begin();
  assert.ok(
    start.consentUrl.startsWith(
      "https://roles.bittrees.org/connect/ai?challenge=",
    ),
  );
  await connector.finish(start.id, "a".repeat(64));
  return {
    connector,
    make,
    grant,
    projection,
    calls,
    deny: () => {
      deny = true;
    },
    advance: (ms: number) => {
      now += ms;
    },
    failDisconnect: (v: boolean) => {
      disconnectFails = v;
    },
    wait: (fn: () => Promise<void>) => {
      waitRead = fn;
    },
    mutate: (fn: (v: any) => any) => {
      mutate = fn;
    },
  };
}
test("Roles broker separates its credential and verifies the own-profile observation contract", async () => {
  const f = await fixture();
  assert.equal((await f.connector.status())!.profileId, f.grant.profileId);
  assert.ok(
    !JSON.stringify(await f.connector.status()).includes(f.grant.token),
  );
  const result = await f.connector.read();
  assert.equal(result.projection.items[0]!.executable, false);
  assert.equal(result.projection.items[0]!.authorityConfirmed, "not_verified");
  await assert.rejects(f.make("other").read(), /INVALID_CONNECTION/);
  f.deny();
  await assert.rejects(
    f.connector.read(),
    (e) =>
      String(e).includes("SOURCE_DENIED") && !String(e).includes("PRIVATE"),
  );
});
test("Roles responses reject identity substitution, authority claims, private fields and changed hashes", async () => {
  for (const change of [
    (r: any) => {
      r.grantId = randomUUID();
    },
    (r: any) => {
      r.projection.profileId = randomUUID();
    },
    (r: any) => {
      r.projection.identities = ["private@example.org"];
    },
    (r: any) => {
      r.projection.items[0].executable = true;
    },
    (r: any) => {
      r.projection.items[0].authorityConfirmed = "confirmed";
    },
    (r: any) => {
      r.projection.items[0].label = "Changed";
    },
    (r: any) => {
      r.projection.manageUrl = "https://evil.test";
    },
    (r: any) => {
      r.expiresAt = new Date(Date.now() + 999999999).toISOString();
    },
  ]) {
    const f = await fixture();
    f.mutate((r) => {
      change(r);
      return r;
    });
    await assert.rejects(f.connector.read(), /INVALID_SOURCE/);
  }
});
test("Roles validates freshness and expiry independently of a matching source hash", async () => {
  for (const change of [
    (f: any) => {
      f.projection.items[0].observedAt = new Date(0).toISOString();
    },
    (f: any) => {
      f.projection.items[0].expiresAt = new Date(0).toISOString();
    },
    (f: any) => {
      f.projection.items[0].observation = "expired";
    },
    (f: any) => {
      f.projection.items[0].reportedEffect = "allow";
    },
  ]) {
    const f = await fixture();
    change(f);
    await assert.rejects(f.connector.read(), /INVALID_SOURCE/);
  }
  const f = await fixture();
  f.advance(86400001);
  await assert.rejects(f.connector.read(), /CONNECTION_EXPIRED/);
});
test("Uncertain Roles disconnect persists across restart and requires explicit source retry", async () => {
  const f = await fixture();
  f.failDisconnect(true);
  await assert.rejects(f.connector.disconnect(), /SOURCE_UNAVAILABLE/);
  const restarted = f.make();
  assert.equal((await restarted.status())!.state, "disconnect_pending");
  await assert.rejects(restarted.read(), /CONNECTION_BUSY/);
  f.failDisconnect(false);
  await restarted.disconnect();
  assert.equal(await restarted.status(), null);
  assert.equal(f.calls.filter((p) => p.endsWith("/disconnect")).length, 2);
});
test("Local Roles removal and source disconnect fence in-flight reads", async () => {
  for (const action of ["forgetLocal", "disconnect"] as const) {
    const f = await fixture();
    let release!: () => void, started!: () => void;
    const began = new Promise<void>((r) => {
      started = r;
    });
    f.wait(async () => {
      started();
      await new Promise<void>((r) => {
        release = r;
      });
    });
    const result = f.connector.read();
    await began;
    await f.connector[action]();
    release();
    await assert.rejects(result, /CONNECTION_EXPIRED/);
    assert.equal(await f.connector.status(), null);
  }
});
test("Roles rejects oversized responses and excessive own-access rows", async () => {
  for (const mutate of [
    (v: any) => ({ ...v, padding: "x".repeat(300001) }),
    (v: any) => ({
      ...v,
      projection: {
        ...v.projection,
        items: Array(201).fill(v.projection.items[0]),
      },
    }),
  ]) {
    const f = await fixture();
    f.mutate(mutate);
    await assert.rejects(f.connector.read(), /INVALID_SOURCE/);
  }
});
test("Roles companion HTTP isolates own-access loading and credential controls from task authority", async () => {
  const { createServer } = await import("node:http");
  const { localApi } = await import("../apps/companion/http.js");
  const { Store } = await import("../modules/storage/store.js");
  const { Vault } = await import("../modules/storage/vault.js");
  const { randomBytes } = await import("node:crypto");
  const f = await fixture(),
    store = new Store(":memory:", new Vault(randomBytes(32))),
    server = createServer(),
    token = "a".repeat(64);
  let cancelled = 0;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  server.on(
    "request",
    localApi({
      store,
      owner: { userId: "local", tenantId: "personal" },
      port,
      token,
      roles: f.connector,
      cancelSourceRun: () => {
        cancelled++;
      },
    }),
  );
  const url = "http://127.0.0.1:" + port,
    headers = {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    };
  const post = (
    path: string,
    body: unknown = {},
    extra: Record<string, string> = {},
  ) =>
    fetch(url + path, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await fetch(url + "/v1/connections/roles")).status, 401);
    assert.equal(
      (
        await post(
          "/v1/connections/roles/access",
          {},
          { Origin: "https://evil.test" },
        )
      ).status,
      403,
    );
    const status = await (
      await fetch(url + "/v1/connections/roles", { headers })
    ).json();
    assert.equal(status.available, true);
    assert.ok(!JSON.stringify(status).includes(f.grant.token));
    assert.equal(
      (await post("/v1/connections/roles/access", { profileId: randomUUID() }))
        .status,
      400,
    );
    const read = await post("/v1/connections/roles/access");
    assert.equal(read.status, 200);
    assert.equal(read.headers.get("Cache-Control"), "no-store");
    assert.equal((await read.json()).projection.items[0].label, "Moderator");
    assert.ok(
      !(await (await fetch(url + "/v1/export", { headers })).text()).includes(
        "Moderator",
      ),
    );
    assert.equal(
      (
        await fetch(url + "/v1/connections/roles/local", {
          method: "DELETE",
          headers,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(url + "/v1/connections/roles/local", {
          method: "DELETE",
          headers: { ...headers, "X-Confirm-Delete": "local-roles-credential" },
        })
      ).status,
      204,
    );
    assert.equal(f.calls.filter((p) => p.endsWith("/disconnect")).length, 0);
    assert.notEqual((await post("/v1/connections/roles/access")).status, 200);
    const begin = await (await post("/v1/connections/roles/begin")).json();
    assert.equal(
      (
        await post("/v1/connections/roles/finish", {
          id: begin.id,
          code: "b".repeat(64),
          profileId: randomUUID(),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post("/v1/connections/roles/finish", {
          id: begin.id,
          code: "b".repeat(64),
        })
      ).status,
      200,
    );
    f.failDisconnect(true);
    assert.notEqual(
      (await post("/v1/connections/roles/disconnect")).status,
      204,
    );
    const pending = await (
      await fetch(url + "/v1/connections/roles", { headers })
    ).json();
    assert.equal(pending.connection.state, "disconnect_pending");
    assert.notEqual((await post("/v1/connections/roles/access")).status, 200);
    f.failDisconnect(false);
    assert.equal((await post("/v1/connections/roles/disconnect")).status, 204);
    assert.equal(cancelled, 0);
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    store.close();
  }
});
