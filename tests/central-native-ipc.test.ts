import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { CentralNativeBroker } from "../modules/workflows/central-native-broker.js";
import {
  CentralNativeClient,
  nativeCentralClient,
} from "../modules/workflows/central-native-client.js";
const raw = () => {
  const args = {
    connectionId: randomUUID(),
    workflowId: "fixture",
    operationId: randomUUID(),
  };
  return {
    rpc: {
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/call",
      params: { name: "workflow_claim", arguments: args },
    },
    proof: {
      request: {
        version: 1,
        source: "mcp.bittrees.org",
        audience: "https://roles.bittrees.org/api/authority/mcp-decision",
        requestId: randomUUID(),
        operationId: args.operationId,
        parametersDigest: "a".repeat(64),
        issuedAt: Date.now(),
        principal: "agent:" + randomUUID(),
        credentialId: "b".repeat(64),
        delegationId: randomUUID(),
        tenant: "t",
        workspace: "w",
        project: "workflow",
        resource: "workflow:fixture",
        action: "workflow:claim",
        stage: "execute",
      },
      signature: Buffer.alloc(64).toString("base64"),
    },
  };
};
// IPC fixture only: signature/authority validation is tested in native transport.
test("central native IPC carries exact signed input while keeping source credentials native", async () => {
  const token = randomBytes(32).toString("hex"),
    input = raw();
  let calls = 0;
  const transport = {
    dispatch: async (value: unknown) => {
      calls++;
      assert.deepEqual(value, input);
      return Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: input.rpc.id,
          result: { structuredContent: { job: null } },
        }),
      );
    },
  };
  const broker = new CentralNativeBroker(token, () => transport);
  try {
    const url = await broker.listen(),
      client = new CentralNativeClient(url, token);
    const response = await client.request(
      "https://mcp.bittrees.org/mcp?mode=selected&projects=workflow",
      {
        method: "POST",
        redirect: "error",
        signal: new AbortController().signal,
        headers: {
          authorization: "Bearer model-side-token-is-not-forwarded",
          "content-type": "application/json",
          "x-bittrees-agent-proof": Buffer.from(
            JSON.stringify(input.proof),
          ).toString("base64url"),
        },
        body: JSON.stringify(input.rpc),
      },
    );
    assert.equal((await response.json()).result.structuredContent.job, null);
    assert.equal(calls, 1);
    for (const extra of [
      { origin: "https://example.org" },
      { cookie: "session=fixture" },
      { host: "example.org" },
      { authorization: "Bearer incorrect" },
    ]) {
      const status = await new Promise<number | undefined>(
        (resolve, reject) => {
          const req = httpRequest(
            url,
            {
              method: "POST",
              headers: {
                authorization: "Bearer " + token,
                "content-type": "application/json",
                ...extra,
              },
            },
            (res) => {
              resolve(res.statusCode);
              res.resume();
            },
          );
          req.on("error", reject);
          req.end(JSON.stringify(input));
        },
      );
      assert.equal(status, 403, Object.keys(extra).join(","));
    }
    assert.equal(calls, 1);
    await assert.rejects(
      client.request("https://other.example/mcp", { method: "POST" }),
    );
    assert.equal(nativeCentralClient({}), undefined);
    assert.throws(() =>
      nativeCentralClient({ BITTREES_CENTRAL_HELPER_URL: url }),
    );
  } finally {
    await broker.close();
  }
});
test("central native IPC admits only one action and denies a changed owner", async () => {
  const token = randomBytes(32).toString("hex"),
    input = raw();
  let release!: () => void, entered!: () => void;
  const begun = new Promise<void>((r) => {
      entered = r;
    }),
    wait = new Promise<void>((r) => {
      release = r;
    });
  const transport = {
    dispatch: async () => {
      entered();
      await wait;
      return Buffer.from("{}");
    },
  };
  let current: typeof transport | null = transport;
  const broker = new CentralNativeBroker(token, () => current);
  try {
    const url = await broker.listen(),
      client = new CentralNativeClient(url, token);
    const first = client.execute(input, new AbortController().signal);
    await begun;
    await assert.rejects(client.execute(raw(), new AbortController().signal));
    current = null;
    release();
    await assert.rejects(first);
  } finally {
    release();
    await broker.close();
  }
});
test("central native IPC refuses remote capability URLs without network fallback", () => {
  const token = randomBytes(32).toString("hex");
  for (const url of [
    "https://127.0.0.1:99/central-workflow",
    "http://localhost:99/central-workflow",
    "http://192.168.1.1:99/central-workflow",
    "http://127.0.0.1:99/central-workflow?remote=1",
  ])
    assert.throws(() => new CentralNativeClient(url, token));
});
