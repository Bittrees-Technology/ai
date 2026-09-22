import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { RolesConnector } from "../modules/connectors/roles.js";
async function fixture(includePolicy = false) {
  let secret: Uint8Array | undefined,
    now = Date.now(),
    deny = false,
    disconnectFails = false;
  let waitRead: (() => Promise<void>) | undefined;
  const grant = {
    token: "f".repeat(64),
    grantId: randomUUID(),
    profileId: randomUUID(),
    actions: includePolicy
      ? ["read_own_access", "read_own_policy"]
      : ["read_own_access"],
    expiresAt: new Date(now + 86400000).toISOString(),
    policyRevision: includePolicy
      ? "roles-ai-own-access-v2"
      : "roles-ai-own-access-v1",
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
  const policyProjection: any = {
    contractVersion: "1.0.0",
    profileId: grant.profileId,
    mode: "own_policy_records",
    checkedAt: new Date(now).toISOString(),
    validUntil: new Date(now + 15000).toISOString(),
    policyStatus: "current",
    policyRevision: 1,
    policyExpiresAt: new Date(now + 60000).toISOString(),
    items: [
      {
        grantId: "own-grant",
        subject: { kind: "profile", reference: grant.profileId },
        roleId: "reader",
        scope: "research",
        domain: "research.bittrees.eth",
        authorityMode: "roles-authoritative",
        actions: ["read"],
        resources: ["own/*"],
        expiresAt: new Date(now + 60000).toISOString(),
        status: "recorded_current",
        authorityConfirmed: "recorded_in_current_policy",
        effectiveAccess: "not_verified",
        enforcementAcknowledged: "not_verified",
        executable: false,
        manageUrl: "https://roles.bittrees.org/profile",
      },
    ],
    coverage:
      "Stored policy grants for verified linked identities and this personal profile only. Agent/service grants, delegations and downstream enforcement are not included.",
    grantAuthority: false,
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
    const data = path.endsWith("/read-policy") ? policyProjection : projection;
    return Response.json(
      mutate({
        grantId: grant.grantId,
        expiresAt: grant.expiresAt,
        policyRevision: grant.policyRevision,
        projection: {
          ...data,
          projectionHash: createHash("sha256")
            .update(JSON.stringify(data))
            .digest("hex"),
        },
      }),
    );
  };
  const make = (owner = "local") =>
    new RolesConnector(owner, storage, transport, () => now);
  const connector = make(),
    start = await connector.begin({ includePolicy });
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
    policyProjection,
    storage,
    transport,
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
for (const includePolicy of [false, true])
  test(`Roles companion HTTP isolates ${includePolicy ? "policy and observation" : "wallet-only"} reads and credential controls from task authority`, async () => {
    const { createServer } = await import("node:http");
    const { localApi } = await import("../apps/companion/http.js");
    const { Store } = await import("../modules/storage/store.js");
    const { Vault } = await import("../modules/storage/vault.js");
    const { randomBytes } = await import("node:crypto");
    const f = await fixture(includePolicy),
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
        (
          await post("/v1/connections/roles/access", {
            profileId: randomUUID(),
          })
        ).status,
        400,
      );
      const read = await post("/v1/connections/roles/access");
      assert.equal(read.status, 200);
      assert.equal(read.headers.get("Cache-Control"), "no-store");
      assert.equal((await read.json()).projection.items[0].label, "Moderator");
      assert.equal(
        (
          await fetch(url + "/v1/connections/roles/policy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await post(
            "/v1/connections/roles/policy",
            {},
            { Origin: "https://evil.test" },
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await post("/v1/connections/roles/policy", {
            profileId: randomUUID(),
          })
        ).status,
        400,
      );
      const policy = await post("/v1/connections/roles/policy");
      assert.equal(policy.status, includePolicy ? 200 : 400);
      if (!includePolicy)
        assert.equal((await policy.json()).error, "SOURCE_DENIED");
      if (includePolicy) {
        assert.equal(policy.headers.get("Cache-Control"), "no-store");
        assert.equal(
          (await policy.json()).projection.items[0].grantId,
          "own-grant",
        );
        assert.ok(
          !(
            await (await fetch(url + "/v1/export", { headers })).text()
          ).includes("own-grant"),
        );
        const history = await fetch(url + "/v1/requests", { headers });
        assert.equal(history.status, 200);
        assert.ok(!(await history.text()).includes("own-grant"));
        const exported = await fetch(url + "/v1/export", { headers });
        assert.equal(exported.status, 200);
        assert.deepEqual((await exported.json()).tasks, []);
      }
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
            headers: {
              ...headers,
              "X-Confirm-Delete": "local-roles-credential",
            },
          })
        ).status,
        204,
      );
      assert.equal(f.calls.filter((p) => p.endsWith("/disconnect")).length, 0);
      assert.notEqual((await post("/v1/connections/roles/access")).status, 200);
      assert.notEqual((await post("/v1/connections/roles/policy")).status, 200);
      assert.equal(
        (await post("/v1/connections/roles/begin", { includePolicy: "yes" }))
          .status,
        400,
      );
      assert.equal(
        (
          await post("/v1/connections/roles/begin", {
            includePolicy,
            profileId: randomUUID(),
          })
        ).status,
        400,
      );
      const begin = await (
        await post("/v1/connections/roles/begin", { includePolicy })
      ).json();
      assert.equal(
        new URL(begin.consentUrl).searchParams.has("scope"),
        includePolicy,
      );
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
      assert.notEqual((await post("/v1/connections/roles/policy")).status, 200);
      f.failDisconnect(false);
      assert.equal(
        (await post("/v1/connections/roles/disconnect")).status,
        204,
      );
      assert.equal(cancelled, 0);
    } finally {
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
      store.close();
    }
  });

test("Policy scope requires local opt-in and permits source consent to decline it", async () => {
  const f = await fixture();
  await assert.rejects(f.connector.readPolicy(), /SOURCE_DENIED/);
  assert.equal(
    f.calls.some((p) => p.endsWith("/read-policy")),
    false,
  );
  await f.connector.forgetLocal();
  const opted = await f.connector.begin({ includePolicy: true });
  assert.equal(
    new URL(opted.consentUrl).searchParams.get("scope"),
    "own_policy",
  );
  await f.connector.finish(opted.id, "a".repeat(64)); // Source unchecked policy option.
  assert.deepEqual((await f.connector.status())!.actions, ["read_own_access"]);
  await f.connector.forgetLocal();
  const unrequested = await f.connector.begin();
  assert.equal(
    new URL(unrequested.consentUrl).searchParams.has("scope"),
    false,
  );
  f.grant.actions = ["read_own_access", "read_own_policy"];
  f.grant.policyRevision = "roles-ai-own-access-v2";
  await assert.rejects(
    f.connector.finish(unrequested.id, "a".repeat(64)),
    /INVALID_SOURCE/,
  );
  assert.equal(await f.connector.status(), null);
});
test("Policy credentials survive restart and preserve read-only status and lifecycle", async () => {
  const f = await fixture(true);
  assert.equal(
    (await f.make().readPolicy()).projection.items[0]!.status,
    "recorded_current",
  );
  assert.equal(
    (await f.connector.read()).policyRevision,
    "roles-ai-own-access-v2",
  );
  f.failDisconnect(true);
  await assert.rejects(f.connector.disconnect(), /SOURCE_UNAVAILABLE/);
  await assert.rejects(f.make().readPolicy(), /CONNECTION_BUSY/);
  f.failDisconnect(false);
  await f.make().disconnect();
  assert.equal(await f.connector.status(), null);
});
test("Policy validation rejects stale or contradictory records even with a matching hash", async () => {
  for (const change of [
    (p: any) => (p.profileId = randomUUID()),
    (p: any) => (p.checkedAt = new Date(0).toISOString()),
    (p: any) => (p.validUntil = p.checkedAt),
    (p: any) =>
      (p.validUntil = new Date(Date.parse(p.checkedAt) + 15001).toISOString()),
    (p: any) => (p.policyStatus = "absent"),
    (p: any) => (p.policyStatus = "expired"),
    (p: any) => (p.policyRevision = null),
    (p: any) => (p.items[0].subject.reference = randomUUID()),
    (p: any) =>
      (p.items[0].subject = {
        kind: "email",
        reference: "private@example.org",
      }),
    (p: any) => (p.items[0].executable = true),
    (p: any) => (p.items[0].effectiveAccess = "allowed"),
    (p: any) => (p.items[0].authorityConfirmed = "not_confirmed"),
    (p: any) => (p.items[0].authorityMode = "project-authoritative"),
    (p: any) => (p.items[0].expiresAt = new Date(0).toISOString()),
    (p: any) => (p.items[0].status = "expired"),
    (p: any) => (p.items[0].manageUrl = "https://evil.test"),
    (p: any) => p.items.push({ ...p.items[0] }),
    (p: any) => (p.items = Array(201).fill(p.items[0])),
    (p: any) => (p.identities = ["private@example.org"]),
  ]) {
    const f = await fixture(true);
    change(f.policyProjection);
    await assert.rejects(f.connector.readPolicy(), /INVALID_SOURCE/);
  }
  const f = await fixture(true);
  f.advance(15001);
  await assert.rejects(f.connector.readPolicy(), /INVALID_SOURCE/);
});
test("Policy reads reject mismatched envelopes and changed content hashes", async () => {
  for (const change of [
    (r: any) => (r.grantId = randomUUID()),
    (r: any) => (r.policyRevision = "roles-ai-own-access-v1"),
    (r: any) => (r.projection.items[0].resources = ["changed"]),
    (r: any) => (r.padding = "x".repeat(300001)),
  ]) {
    const f = await fixture(true);
    f.mutate((r) => {
      change(r);
      return r;
    });
    await assert.rejects(f.connector.readPolicy(), /INVALID_SOURCE/);
  }
});
test("Policy reads are fenced by local removal and source disconnect", async () => {
  for (const action of ["forgetLocal", "disconnect"] as const) {
    const f = await fixture(true);
    let release!: () => void, started!: () => void;
    const began = new Promise<void>((r) => (started = r));
    f.wait(async () => {
      started();
      await new Promise<void>((r) => (release = r));
    });
    const read = f.connector.readPolicy();
    await began;
    await f.connector[action]();
    release();
    await assert.rejects(read, /CONNECTION_EXPIRED/);
  }
});

test("Policy records preserve absent, expired, suspended, source-owned and wallet-required explanations", async () => {
  for (const status of [
    "absent",
    "expired",
    "suspended",
    "source_owned",
    "wallet_required",
  ]) {
    const f = await fixture(true),
      p = f.policyProjection,
      row = p.items[0];
    if (status === "absent")
      Object.assign(p, {
        policyStatus: "absent",
        policyRevision: null,
        policyExpiresAt: null,
        items: [],
      });
    else {
      row.status = status;
      row.authorityConfirmed = "not_confirmed";
      if (status === "expired") {
        p.policyStatus = "expired";
        p.policyExpiresAt = new Date(
          Date.parse(p.checkedAt) - 1000,
        ).toISOString();
        row.expiresAt = p.policyExpiresAt;
      }
      if (status === "source_owned")
        row.authorityMode = "project-authoritative";
      if (status === "wallet_required")
        row.subject = { kind: "email", reference: "a".repeat(64) };
    }
    const result = await f.connector.readPolicy();
    assert.equal(
      result.projection.items[0]?.status ?? result.projection.policyStatus,
      status,
    );
  }
});
test("Stored Roles credentials reject mismatched scopes and revisions", async () => {
  const f = await fixture(true);
  const saved = JSON.parse(
    Buffer.from((await f.storage.getSecret())!).toString(),
  );
  saved.grant.actions = ["read_own_access"];
  await f.storage.setSecret(Buffer.from(JSON.stringify(saved)));
  await assert.rejects(f.make().readPolicy(), /INVALID_CONNECTION/);
  const legacy = await fixture();
  legacy.mutate((r) => ({ ...r, policyRevision: "roles-ai-own-access-v2" }));
  await assert.rejects(legacy.connector.read(), /INVALID_SOURCE/);
});
