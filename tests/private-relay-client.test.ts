import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  PrivateRelayClient,
  PrivateRelayOwnerClient,
  type PrivateRelayClientContext,
} from "../modules/remote/private-relay-client.js";
import { privateRelayEnvelopeHash } from "../modules/remote/private-relay-contracts.js";
import {
  sealPrivateEnvelope,
  privateEnvelopeSuite,
} from "../modules/remote/private-envelope.js";
const time = 1900000000000;
const page = { after: null, limit: 20 };
async function fixture(kind: "browser" | "mac" = "browser") {
  const owner = randomUUID(),
    sender = randomUUID(),
    recipient = randomUUID();
  const key = () =>
      crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
        "deriveBits",
      ]),
    a = await key(),
    b = await key();
  const envelope = await sealPrivateEnvelope(
    {
      version: 1,
      suite: privateEnvelopeSuite,
      ownerId: owner,
      senderId: sender,
      recipientId: recipient,
      senderKeyEpoch: 1,
      recipientKeyEpoch: 1,
      messageId: randomUUID(),
      operationId: randomUUID(),
      sequence: 1,
      issuedAt: time,
      expiresAt: time + 60000,
    },
    new Uint8Array(65536).fill(77),
    { senderKey: a, recipientPublicKey: b.publicKey },
    () => time,
  );
  const receipt = {
    version: 1 as const,
    messageId: envelope.header.messageId,
    envelopeHash: await privateRelayEnvelopeHash(envelope),
    revision: 1,
    storedAt: time,
    state: "stored" as const,
  };
  const identity = {
    version: 1 as const,
    scope: "private:relay" as const,
    ownerId: owner,
    endpointId: sender,
    endpointKind: kind,
    credentialEpoch: 1,
    permissionId: randomUUID(),
    expiresAt: time + 120000,
  };
  const context: PrivateRelayClientContext =
    kind === "browser"
      ? { kind, scope: "session-A", identity }
      : { kind, scope: "device-A", identity, credential: "S".repeat(43) };
  return { envelope, receipt, context };
}
test("relay transport binds exact ciphertext receipts and browser/native credential modes", async () => {
  for (const kind of ["browser", "mac"] as const) {
    const f = await fixture(kind);
    let calls = 0;
    const client = new PrivateRelayClient(
      () => f.context,
      async (url, init) => {
        calls++;
        assert.equal(
          url,
          "https://ai.bittrees.org/" +
            (kind === "browser" ? "browser" : "device") +
            "/relay/messages/submit",
        );
        assert.equal(init?.method, "POST");
        assert.equal(init?.redirect, "error");
        assert.equal(init?.cache, "no-store");
        assert.equal(
          init?.credentials,
          kind === "browser" ? "same-origin" : "omit",
        );
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("cookie"), null);
        assert.equal(
          headers.get("x-bittrees-relay-permission"),
          f.context.identity.permissionId,
        );
        assert.equal(
          headers.get("authorization"),
          kind === "mac" ? "Bearer " + "S".repeat(43) : null,
        );
        assert.equal(
          headers.get("x-bittrees-account"),
          kind === "browser" ? f.context.identity.ownerId : null,
        );
        assert.deepEqual(JSON.parse(String(init?.body)), {
          version: 1,
          envelope: f.envelope,
        });
        return Response.json({ receipt: f.receipt, duplicate: false });
      },
      () => time,
      () => 0,
    );
    assert.equal(
      (await client.submit({ version: 1, envelope: f.envelope })).duplicate,
      false,
    );
    assert.equal(calls, 1);
    await assert.rejects(
      client.submit({ version: 1, envelope: f.envelope, extra: true }),
      /INVALID_INPUT/,
    );
    assert.equal(calls, 1);
  }
});
test("relay transport rejects receipt substitution and impossible mutation outcomes", async () => {
  const f = await fixture();
  let response: unknown;
  const client = new PrivateRelayClient(
    () => f.context,
    async () => Response.json(response),
    () => time,
    () => 0,
  );
  for (const changed of [
    { messageId: randomUUID() },
    { envelopeHash: "0".repeat(64) },
    { revision: 2 },
    { storedAt: time + 1 },
  ]) {
    response = { receipt: { ...f.receipt, ...changed }, duplicate: false };
    await assert.rejects(
      client.submit({ version: 1, envelope: f.envelope }),
      /INVALID_RESPONSE/,
    );
  }
  const ack = {
    messageId: f.receipt.messageId,
    envelopeHash: f.receipt.envelopeHash,
    expectedRevision: 1,
    confirmed: true,
  };
  response = {
    receipt: { ...f.receipt, state: "received", revision: 2 },
    duplicate: false,
  };
  assert.equal((await client.acknowledge(ack)).receipt.state, "received");
  response = {
    receipt: { ...f.receipt, state: "deleted", revision: 3 },
    duplicate: true,
  };
  assert.equal((await client.acknowledge(ack)).duplicate, true);
  response = {
    receipt: { ...f.receipt, state: "deleted", revision: 3 },
    duplicate: false,
  };
  await assert.rejects(client.acknowledge(ack), /INVALID_RESPONSE/);
  await assert.rejects(
    client.delete({
      messageId: f.receipt.messageId,
      expectedRevision: 1,
      confirmed: true,
    }),
    /INVALID_RESPONSE/,
  );
  response = {
    receipt: { ...f.receipt, state: "deleted", revision: 2 },
    duplicate: true,
  };
  assert.equal(
    (
      await client.delete({
        messageId: f.receipt.messageId,
        expectedRevision: 1,
        confirmed: true,
      })
    ).duplicate,
    true,
  );
});
test("relay polling verifies route, hash, expiry, ordering and exact cursors without acknowledgement", async () => {
  const f = await fixture("mac");
  f.context.identity.endpointId = f.envelope.header.recipientId;
  const valid = {
    items: [{ receipt: f.receipt, envelope: f.envelope }],
    nextCursor: null,
  };
  let response: unknown = valid,
    calls = 0;
  const client = new PrivateRelayClient(
    () => f.context,
    async (url) => {
      calls++;
      assert.match(String(url), /messages\/poll$/);
      return Response.json(response);
    },
    () => time,
    () => 0,
  );
  assert.equal((await client.poll(page)).items.length, 1);
  assert.equal(calls, 1);
  for (const edit of [
    (r: any) => {
      r.items[0].envelope.header.ownerId = randomUUID();
    },
    (r: any) => {
      r.items[0].envelope.header.recipientId = randomUUID();
    },
    (r: any) => {
      r.items[0].envelope.ciphertext =
        "A" + r.items[0].envelope.ciphertext.slice(1);
      r.items[0].receipt.envelopeHash = "0".repeat(64);
    },
    (r: any) => {
      r.items[0].envelope.header.expiresAt = time;
    },
    (r: any) => {
      r.items.push(structuredClone(r.items[0]));
    },
    (r: any) => {
      r.nextCursor = { storedAt: time, messageId: randomUUID() };
    },
    (r: any) => {
      r.items[0].receipt.state = "received";
      r.items[0].receipt.revision = 2;
    },
  ]) {
    const r = structuredClone(valid);
    edit(r);
    response = r;
    await assert.rejects(client.poll(page), /INVALID_RESPONSE/);
  }
  response = valid;
  await assert.rejects(
    client.poll({
      after: { storedAt: time, messageId: f.receipt.messageId },
      limit: 20,
    }),
    /INVALID_RESPONSE/,
  );
});
test("relay cancels an unresolved fetch and rejects concurrent or late results", async () => {
  const f = await fixture();
  let resolve!: (r: Response) => void;
  let cancelled = false;
  const client = new PrivateRelayClient(
    () => f.context,
    () =>
      new Promise((r) => {
        resolve = r;
      }),
    () => time,
    () => 0,
  );
  const pending = client.inspect({ messageId: f.receipt.messageId });
  await assert.rejects(
    client.inspect({ messageId: f.receipt.messageId }),
    /BUSY/,
  );
  client.invalidate();
  await assert.rejects(pending, /DENIED|UNAVAILABLE/);
  resolve(
    new Response(
      new ReadableStream(
        {
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { "content-type": "application/json" } },
    ),
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(cancelled, true);
});
test("relay discards results after scope, credential, clock or grant changes", async () => {
  for (const change of [
    "scope",
    "credential",
    "rollback",
    "monotonic",
    "expired",
  ]) {
    const f = await fixture("mac");
    let now = time,
      mono = 0;
    const client = new PrivateRelayClient(
      () => f.context,
      async () => {
        if (change === "scope") f.context.scope = "changed";
        if (change === "credential" && f.context.kind === "mac")
          f.context.credential = "T".repeat(43);
        if (change === "rollback") now = time - 1;
        if (change === "monotonic") mono = 30001;
        if (change === "expired") now = f.context.identity.expiresAt;
        return Response.json(f.receipt);
      },
      () => now,
      () => mono,
    );
    await assert.rejects(
      client.inspect({ messageId: f.receipt.messageId }),
      /DENIED/,
    );
  }
});
test("relay bounds streamed responses, cancels hung reads and rejects invalid framing", async () => {
  const f = await fixture();
  let make = () => Response.json(f.receipt);
  const client = new PrivateRelayClient(
    () => f.context,
    async () => make(),
    () => time,
    () => 0,
  );
  for (const response of [
    () => new Response("{}", { headers: { "content-type": "text/plain" } }),
    () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": "9999999",
        },
      }),
    () =>
      new Response(new Uint8Array([255]), {
        headers: { "content-type": "application/json" },
      }),
    () =>
      new Response("x".repeat(32769), {
        headers: { "content-type": "application/json" },
      }),
    () => {
      const r = Response.json(f.receipt);
      Object.defineProperty(r, "url", { value: "https://other.invalid/" });
      return r;
    },
    () => {
      const r = Response.json(f.receipt);
      Object.defineProperty(r, "redirected", { value: true });
      return r;
    },
  ]) {
    make = response;
    await assert.rejects(
      client.inspect({ messageId: f.receipt.messageId }),
      /INVALID_RESPONSE/,
    );
  }
  let reading!: (value?: unknown) => void;
  const entered = new Promise((r) => {
    reading = r;
  });
  let cancelled = false;
  make = () =>
    new Response(
      new ReadableStream(
        {
          pull() {
            reading();
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { "content-type": "application/json" } },
    );
  const pending = client.inspect({ messageId: f.receipt.messageId });
  await entered;
  client.invalidate();
  await assert.rejects(pending, /DENIED|UNAVAILABLE/);
  assert.equal(cancelled, true);
});
test("relay errors expose stable codes without remote bodies or transport secrets", async () => {
  const f = await fixture();
  let status = 403;
  const client = new PrivateRelayClient(
    () => f.context,
    async () => Response.json({ error: "SECRET_BODY" }, { status }),
    () => time,
    () => 0,
  );
  for (const [code, expected] of [
    [403, "DENIED"],
    [409, "CONFLICT"],
    [429, "CAPACITY"],
    [500, "UNAVAILABLE"],
  ] as const) {
    status = code;
    await assert.rejects(
      client.inspect({ messageId: f.receipt.messageId }),
      new RegExp("^Error: " + expected + "$"),
    );
  }
  const failed = new PrivateRelayClient(
    () => f.context,
    async () => {
      throw Error("SECRET_TRANSPORT");
    },
    () => time,
    () => 0,
  );
  await assert.rejects(
    failed.inspect({ messageId: f.receipt.messageId }),
    /^Error: UNAVAILABLE$/,
  );
});
test("owner export preserves expired ciphertext without endpoint authority and validates history", async () => {
  const f = await fixture(),
    c = { ownerId: f.context.identity.ownerId, scope: "signed-in" };
  const valid = {
    version: 1,
    restoreAuthority: false,
    items: [
      {
        receipt: f.receipt,
        senderId: f.envelope.header.senderId,
        recipientId: f.envelope.header.recipientId,
        envelope: f.envelope,
      },
    ],
    nextCursor: null,
  };
  let response: unknown = valid;
  const client = new PrivateRelayOwnerClient(
    () => c,
    async (url, init) => {
      assert.equal(init?.credentials, "same-origin");
      assert.equal(new Headers(init?.headers).get("authorization"), null);
      assert.match(String(url), /history\/(export|delete)$/);
      return Response.json(response);
    },
    () => time + 86400000,
    () => 0,
  );
  assert.equal((await client.export(page)).items.length, 1);
  response = { ...valid, restoreAuthority: true };
  await assert.rejects(client.export(page), /INVALID_RESPONSE/);
  response = {
    ...valid,
    items: [{ ...valid.items[0], recipientId: randomUUID() }],
  };
  await assert.rejects(client.export(page), /INVALID_RESPONSE/);
  response = {
    receipt: { ...f.receipt, state: "deleted", revision: 2 },
    duplicate: false,
  };
  assert.equal(
    (
      await client.delete({
        messageId: f.receipt.messageId,
        expectedRevision: 1,
        confirmed: true,
      })
    ).receipt.state,
    "deleted",
  );
});

test("relay submit awaits asynchronous source checks before upload and before exposing a response", async () => {
  const f = await fixture();
  for (const failAt of [1, 2, 3, 0]) {
    let calls = 0,
      guards = 0;
    const client = new PrivateRelayClient(
      () => f.context,
      async () => {
        calls++;
        assert.equal(guards, 2);
        return Response.json({ receipt: f.receipt, duplicate: false });
      },
      () => time,
      () => 0,
    );
    const result = client.submit(
      { version: 1, envelope: f.envelope },
      async () => {
        guards++;
        await Promise.resolve();
        if (guards === failAt) throw Error("DENIED");
      },
    );
    if (failAt) await assert.rejects(result, /DENIED/);
    else await result;
    assert.equal(calls, failAt === 1 || failAt === 2 ? 0 : 1);
    assert.equal(guards, failAt || 3);
  }
});
