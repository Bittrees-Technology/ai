import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { canonical } from "../modules/contracts/canonical-json.js";
import {
  CentralTransportPlan,
  type CentralNativeScope,
} from "../modules/workflows/central-transport-plan.js";
import { CentralNativeHTTPS } from "../modules/workflows/central-native-https.js";
function fixture() {
  const keys = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  let time = Date.now();
  const scope: CentralNativeScope = {
    epoch: randomUUID(),
    approvedAt: time - 1000,
    expiresAt: time + 60000,
    principal: "agent:" + randomUUID(),
    publicKey: keys.publicKey,
    credentialId: createHash("sha256").update(keys.publicKey).digest("hex"),
    delegationId: randomUUID(),
    tenant: "t",
    workspace: "w",
    workflowId: "workflow-fixture",
    connectionId: randomUUID(),
  };
  let current: CentralNativeScope | null = scope;
  const plan = new CentralTransportPlan(
    () => current,
    () => time,
  );
  const signed = (
    name = "workflow_claim",
    changes: Record<string, unknown> = {},
    output = "fixture output",
  ) => {
    const args: any = {
      connectionId: scope.connectionId,
      workflowId: scope.workflowId,
      operationId: randomUUID(),
    };
    if (name !== "workflow_claim")
      Object.assign(args, { jobId: randomUUID(), leaseId: randomUUID() });
    if (name === "workflow_complete")
      args.evidence = {
        model: "fixture",
        modelDigest: "fixture-digest",
        inputHash: "a".repeat(64),
        output,
      };
    const request = {
      version: 1,
      source: "mcp.bittrees.org",
      audience: "https://roles.bittrees.org/api/authority/mcp-decision",
      requestId: randomUUID(),
      operationId: args.operationId,
      parametersDigest: createHash("sha256")
        .update(canonical({ tool: name, arguments: args }))
        .digest("hex"),
      issuedAt: time,
      principal: scope.principal,
      credentialId: scope.credentialId,
      delegationId: scope.delegationId,
      tenant: scope.tenant,
      workspace: scope.workspace,
      project: "workflow",
      resource: "workflow:" + scope.workflowId,
      action: "workflow:" + name.slice(9),
      stage: "execute",
      ...changes,
    };
    return {
      rpc: {
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "tools/call",
        params: { name, arguments: args },
      },
      proof: {
        request,
        signature: sign(
          null,
          Buffer.from(
            "Bittrees MCP authority request v1\n" + canonical(request),
          ),
          keys.privateKey,
        ).toString("base64"),
      },
    };
  };
  return {
    scope,
    plan,
    signed,
    revoke: () => {
      current = null;
    },
    change: () => {
      current = { ...scope, delegationId: randomUUID() };
    },
    advance: (ms: number) => {
      time += ms;
    },
  };
}
test("native central plan binds each exact workflow action, operation, source and fresh device signature", () => {
  const f = fixture();
  for (const name of [
    "workflow_claim",
    "workflow_renew",
    "workflow_complete",
  ]) {
    const input = f.signed(name),
      p = f.plan.prepare(input);
    assert.equal(
      p.url,
      "https://mcp.bittrees.org/mcp?mode=selected&projects=workflow",
    );
    assert.equal(p.operationId, input.proof.request.operationId);
    assert.equal(p.maximumResponseBytes, 64000);
    assert.equal(p.timeoutMs, 20000);
  }
  for (const change of [
    { delegationId: randomUUID() },
    { tenant: "other" },
    { workspace: "other" },
    { resource: "workflow:other" },
    { action: "workflow:complete" },
    { operationId: randomUUID() },
    { issuedAt: Date.now() - 30000 },
    { issuedAt: Date.now() + 30000 },
  ])
    assert.throws(() => f.plan.prepare(f.signed("workflow_claim", change)));
  const tampered = f.signed();
  tampered.rpc.params.arguments.workflowId = "other";
  assert.throws(() => f.plan.prepare(tampered));
  const signature = f.signed();
  signature.proof.signature = Buffer.alloc(64).toString("base64");
  assert.throws(() => f.plan.prepare(signature));
});
test("native central plan rejects changed, revoked, expired and excessive reviews", () => {
  const changed = fixture();
  changed.change();
  assert.throws(() => changed.plan.prepare(changed.signed()));
  const revoked = fixture();
  revoked.revoke();
  assert.throws(() => revoked.plan.prepare(revoked.signed()));
  const expired = fixture();
  expired.advance(60000);
  assert.throws(() => expired.plan.prepare(expired.signed()));
  const long = fixture();
  assert.throws(
    () =>
      new CentralTransportPlan(() => ({
        ...long.scope,
        expiresAt: long.scope.approvedAt + 3600001,
      })),
  );
});
test("native central plan rejects unsupported tools and oversized JSON-escaped evidence", () => {
  const f = fixture();
  assert.throws(() =>
    f.plan.prepare(f.signed("source_mercado_freshness_review")),
  );
  const input = f.signed("workflow_complete", {}, "\0".repeat(16000));
  assert.throws(() => f.plan.prepare(input), /request too large/);
});
test("native HTTPS checks review and durable budget before DNS or credential access", async () => {
  const f = fixture();
  let dns = 0,
    tokens = 0;
  const denied = new CentralNativeHTTPS(
    f.plan,
    () => {
      throw Error("budget exhausted");
    },
    () => {
      tokens++;
      return "fixture-token-123456";
    },
    (async () => {
      dns++;
      return [];
    }) as any,
  );
  await assert.rejects(
    denied.dispatch(f.signed(), new AbortController().signal),
    /budget exhausted/,
  );
  assert.equal(dns, 0);
  assert.equal(tokens, 0);
  f.revoke();
  await assert.rejects(
    denied.dispatch(f.signed(), new AbortController().signal),
  );
  assert.equal(dns, 0);
});
test("native HTTPS rejects private DNS and revocation while resolving before transmitting", async () => {
  for (const revoke of [false, true]) {
    const f = fixture();
    let sends = 0,
      tokens = 0;
    const native = new CentralNativeHTTPS(
      f.plan,
      () => {},
      () => {
        tokens++;
        return "fixture-token-123456";
      },
      (async () => {
        if (revoke) f.revoke();
        return [{ address: "127.0.0.1", family: 4 }];
      }) as any,
      (() => {
        sends++;
        throw Error("must not send");
      }) as any,
    );
    await assert.rejects(
      native.dispatch(f.signed(), new AbortController().signal),
    );
    assert.equal(sends, 0);
    assert.equal(tokens, 0);
  }
});
test("native HTTPS pins public DNS and TLS to fixed MCP, with native-owned credentials", async () => {
  const f = fixture();
  let reserved = 0;
  const send: any = (url: URL, opts: any, callback: any) => {
    assert.equal(
      url.href,
      "https://mcp.bittrees.org/mcp?mode=selected&projects=workflow",
    );
    assert.equal(opts.servername, "mcp.bittrees.org");
    assert.equal(opts.rejectUnauthorized, true);
    assert.equal(opts.agent, false);
    assert.equal(opts.headers.Authorization, "Bearer fixture-token-123456");
    assert.equal(opts.headers.Cookie, undefined);
    opts.lookup("ignored", {}, (error: any, address: any, family: any) => {
      assert.equal(error, null);
      assert.equal(address, "8.8.8.8");
      assert.equal(family, 4);
    });
    const req: any = new EventEmitter();
    req.end = (body: string) => {
      assert.equal(JSON.parse(body).method, "tools/call");
      const res: any = new EventEmitter();
      res.statusCode = 200;
      res.headers = { "content-type": "application/json" };
      res.destroy = () => {};
      callback(res);
      res.emit("data", Buffer.from("{}"));
      res.emit("end");
    };
    return req;
  };
  const native = new CentralNativeHTTPS(
    f.plan,
    () => {
      reserved++;
    },
    () => "fixture-token-123456",
    (async () => [{ address: "8.8.8.8", family: 4 }]) as any,
    send,
  );
  assert.equal(
    Buffer.from(
      await native.dispatch(f.signed(), new AbortController().signal),
    ).toString(),
    "{}",
  );
  assert.equal(reserved, 1);
});
