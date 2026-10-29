import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createHash, randomUUID, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  InitialPairingHTTPS,
  checkInitialPairingHTTPSInput,
} from "../modules/task-sync/initial-pairing-https.js";
import {
  INITIAL_PAIRING_START,
  initialPairingMessage,
} from "../modules/task-sync/initial-pairing.js";
function fixture() {
  const key = generateKeyPairSync("ed25519"),
    publicKey = key.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    now = Date.now();
  const request = {
    version: 1,
    audience: INITIAL_PAIRING_START,
    purpose: "metadata-only-owner-pairing",
    target: "Bittrees local AI on this Mac",
    operationId: randomUUID(),
    requestId: randomUUID(),
    principal: "agent:" + randomUUID(),
    publicKey,
    keyFingerprint: createHash("sha256").update(publicKey).digest("hex"),
    issuedAt: now,
    expiresAt: now + 60000,
  };
  return {
    url: INITIAL_PAIRING_START,
    method: "POST" as const,
    body: {
      request,
      signature: sign(
        null,
        Buffer.from(initialPairingMessage(request)),
        key.privateKey,
      ).toString("base64"),
    },
  };
}
test("initial pairing transport rejects arbitrary URLs, headers, credentials and nonpairing operations", () => {
  const p = fixture();
  checkInitialPairingHTTPSInput(p, null);
  for (const url of [
    p.url + "?x=1",
    p.url.replace("https:", "http:"),
    p.url.replace(".org/", ".org:444/"),
    "https://127.0.0.1/api/mcp/pairing/start",
    p.url + "/../start",
  ])
    assert.throws(() => checkInitialPairingHTTPSInput({ ...p, url }, null));
  for (const extra of [
    { headers: { Authorization: "Bearer synthetic" } },
    { credential: "synthetic" },
    { redirect: "follow" },
    { operation: "enroll" },
  ])
    assert.throws(() =>
      checkInitialPairingHTTPSInput({ ...p, ...extra }, null),
    );
});
test("unapproved source purpose denies before any DNS or socket", async () => {
  let resolves = 0;
  const client = new InitialPairingHTTPS(
    () => {
      throw Error("source purpose unavailable");
    },
    () => null,
    (async () => {
      resolves++;
      return [];
    }) as any,
  );
  await assert.rejects(
    client.dispatch(fixture(), new AbortController().signal),
    /purpose/,
  );
  assert.equal(resolves, 0);
});
test("private/mixed/IPv6 DNS answers cannot reach the socket", async () => {
  for (const ips of [
    ["127.0.0.1"],
    ["10.0.0.1"],
    ["169.254.169.254"],
    ["8.8.8.8", "192.168.1.1"],
    ["::1"],
    ["192.88.99.1"],
  ]) {
    let sends = 0;
    const client = new InitialPairingHTTPS(
      () => {},
      () => null,
      (async () => ips.map((address) => ({ address, family: 4 }))) as any,
      (() => {
        sends++;
        throw Error("must not send");
      }) as any,
    );
    await assert.rejects(
      client.dispatch(fixture(), new AbortController().signal),
      /DNS address/,
    );
    assert.equal(sends, 0);
  }
});
test("native revocation while DNS resolves denies request before socket", async () => {
  let active = true,
    sends = 0;
  const client = new InitialPairingHTTPS(
    () => {
      if (!active) throw Error("revoked");
    },
    () => null,
    (async () => {
      active = false;
      return [{ address: "8.8.8.8", family: 4 }];
    }) as any,
    (() => {
      sends++;
      throw Error("must not send");
    }) as any,
  );
  await assert.rejects(
    client.dispatch(fixture(), new AbortController().signal),
    /revoked/,
  );
  assert.equal(sends, 0);
});
test("TLS uses the fixed hostname/pinned IP and no credentials; redirects/encoding/oversize/malformed replies deny", async () => {
  for (const mode of [
    "ok",
    "redirect",
    "gzip",
    "oversize",
    "abort",
    "malformed",
  ]) {
    let sent = 0;
    const client = new InitialPairingHTTPS(
      () => {},
      () => null,
      (async () => [{ address: "8.8.8.8", family: 4 }]) as any,
      ((url: any, options: any, cb: any) => {
        sent++;
        assert.equal(url.href, INITIAL_PAIRING_START);
        assert.equal(options.servername, "roles.bittrees.org");
        assert.equal(options.rejectUnauthorized, true);
        assert.equal(options.agent, false);
        assert.equal(options.headers.Authorization, undefined);
        assert.equal(options.headers.Cookie, undefined);
        assert.equal(options.headers.Origin, undefined);
        options.lookup(
          url.hostname,
          { all: true },
          (err: any, addresses: any) => {
            assert.equal(err, null);
            assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]);
          },
        );
        const req = new EventEmitter() as any;
        req.end = () =>
          setImmediate(() => {
            const res = new PassThrough() as any;
            res.statusCode = mode === "redirect" ? 302 : 200;
            res.headers = {
              "content-type": "application/json",
              ...(mode === "gzip" ? { "content-encoding": "gzip" } : {}),
            };
            cb(res);
            if (mode === "abort") {
              res.emit("aborted");
              res.destroy();
            } else
              res.end(
                mode === "oversize"
                  ? Buffer.alloc(16385)
                  : mode === "malformed"
                    ? "not json"
                    : "{}",
              );
          });
        return req;
      }) as any,
    );
    if (mode === "ok")
      assert.deepEqual(
        await client.dispatch(fixture(), new AbortController().signal),
        {},
      );
    else
      await assert.rejects(
        client.dispatch(fixture(), new AbortController().signal),
      );
    assert.equal(sent, 1);
  }
});
