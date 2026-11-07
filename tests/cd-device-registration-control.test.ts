import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Vault } from "../modules/storage/vault.js";
import { CDRolesPrepareTransport } from "../modules/research/cd-roles-prepare-transport.js";
import { launchCDDeviceRegistrationReview } from "../modules/research/cd-device-registration-control.js";

test("native CD UI control obtains canonical owner through fixed transport and keeps proof private", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "cd-native-control."));
  const path = join(root, "cryptodirectory-device.db");
  const vault = new Vault(randomBytes(32));
  const keys = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const principal = "agent:" + randomUUID(),
    profile = randomUUID();
  const credentialId = createHash("sha256")
    .update(keys.publicKey)
    .digest("hex");
  const at = Date.now();
  const selection = {
    principal,
    credentialId,
    label: "Separate native CD fixture",
  };
  let cookie = "a".repeat(64),
    leaseOnly = false,
    revoked = false,
    wrongOwner = false,
    redirect = false;
  const paths: string[] = [];
  const view = () => ({
    profileId: profile,
    personPrincipal: "person:" + profile,
    principals: [
      { id: "person:" + profile, kind: "person", revoked_at: null },
      { id: principal, kind: "agent", revoked_at: revoked ? "revoked" : null },
    ],
    credentials: [
      {
        id: credentialId,
        principal,
        audience: "https://mcp.bittrees.org",
        revoked_at: null,
        expires_at: null,
      },
    ],
    runtimes: leaseOnly ? [{ credential_id: credentialId }] : [],
  });
  const prepared = () => ({
    request: {
      version: 1,
      audience: "https://roles.bittrees.org/api/profile/mcp/devices/register",
      purpose: "crypto-directory:read-access",
      requestId: randomUUID(),
      deviceId: randomUUID(),
      ownerProfile: wrongOwner ? randomUUID() : profile,
      principal,
      credentialId,
      label: selection.label,
      sessionBinding: "b".repeat(64),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60000,
    },
    challenge: "sealed-fixture",
    registered: false,
    permissionsGranted: false,
  });
  const send = ((url: URL, options: any, callback: Function) => {
    assert.equal(url.origin, "https://roles.bittrees.org");
    assert.ok(
      ["/api/profile/mcp", "/api/profile/mcp/devices/prepare"].includes(
        url.pathname,
      ),
    );
    assert.equal(options.headers.Cookie, "__Host-roles=" + cookie);
    assert.equal(options.headers.Origin, "https://roles.bittrees.org");
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.agent, false);
    paths.push(url.pathname);
    const req = new EventEmitter() as any;
    req.end = (body: string | undefined) => {
      if (url.pathname.endsWith("/prepare"))
        assert.deepEqual(JSON.parse(body!), selection);
      else assert.equal(body, undefined);
      queueMicrotask(() => {
        const response = new PassThrough() as any;
        response.statusCode = redirect ? 302 : 200;
        response.headers = { "content-type": "application/json" };
        callback(response);
        response.end(
          JSON.stringify(
            url.pathname.endsWith("/prepare") ? prepared() : view(),
          ),
        );
      });
    };
    return req;
  }) as any;
  const transport = new CDRolesPrepareTransport({
    enabled: true,
    selection,
    session: () => ({
      cookieValue: cookie,
      authenticatedAt: at,
      expiresAt: at + 600000,
    }),
    admitted: () => true,
    resolve: (async () => [{ address: "8.8.8.8", family: 4 }]) as any,
    send,
  });
  const disabledTransport = new CDRolesPrepareTransport({
    selection,
    session: () => {
      throw Error("Disabled session must not be read");
    },
    admitted: () => true,
  });
  await assert.rejects(
    disabledTransport.prepare(new AbortController().signal),
    /disabled/,
  );
  const missingSession = new CDRolesPrepareTransport({
    enabled: true,
    selection,
    session: () => null,
    admitted: () => true,
    resolve: (() => {
      throw Error("No DNS without canonical native session");
    }) as any,
  });
  await assert.rejects(
    missingSession.prepare(new AbortController().signal),
    /session unavailable/,
  );
  const db = new Database(path);
  db.exec(
    "CREATE TABLE cd_device_identity(id INTEGER PRIMARY KEY,value BLOB NOT NULL)",
  );
  db.prepare("INSERT INTO cd_device_identity VALUES(1,?)").run(
    vault.seal(
      {
        purpose: "crypto-directory:read-access",
        credentialKind: "non-lease",
        principal,
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
      },
      "crypto-directory-device:identity",
    ),
  );
  db.close();
  chmodSync(path, 0o600);
  const disabled = await launchCDDeviceRegistrationReview({
    path,
    vault,
    transport,
  });
  assert.equal(disabled, null);
  assert.equal(paths.length, 0);
  const service = await launchCDDeviceRegistrationReview({
    enabled: true,
    path,
    vault,
    transport,
  });
  assert.ok(service);
  const url = service.environment.BITTREES_CD_DEVICE_CONTROL_URL;
  const token = service.environment.BITTREES_CD_DEVICE_CONTROL_TOKEN;
  const call = async (body: unknown, extra: Record<string, string> = {}) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...extra,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    assert.equal(
      (await call({ action: "propose" }, { Origin: "http://example.test" }))
        .status,
      403,
    );
    assert.equal(paths.length, 0);
    assert.notEqual(
      (
        await call({
          action: "propose",
          ownerProfile: profile,
          cookieValue: cookie,
        })
      ).status,
      200,
    );
    assert.equal(paths.length, 0);
    const review = await call({ action: "propose" });
    assert.equal(review.status, 200);
    assert.deepEqual(paths, [
      "/api/profile/mcp",
      "/api/profile/mcp/devices/prepare",
    ]);
    assert.equal(review.body.ownerProfile, profile);
    assert.equal(review.body.credentialId, credentialId);
    assert.equal("challenge" in review.body, false);
    const choice = {
      action: "approve",
      id: review.body.id,
      requestDigest: review.body.requestDigest,
      packetDigest: review.body.packetDigest,
      confirmed: true,
    };
    const approved = await call(choice);
    assert.equal(approved.status, 200);
    assert.deepEqual(approved.body, {
      signed: true,
      registered: false,
      permissionsGranted: false,
    });
    assert.equal(paths.at(-1), "/api/profile/mcp");
    assert.ok(service.takeProof()?.signature);
    assert.equal(service.takeProof(), undefined);
    assert.notEqual((await call(choice)).status, 200);

    const next = await call({ action: "propose" });
    assert.equal(next.status, 200);
    cookie = "c".repeat(64);
    assert.notEqual(
      (
        await call({
          ...choice,
          id: next.body.id,
          requestDigest: next.body.requestDigest,
          packetDigest: next.body.packetDigest,
        })
      ).status,
      200,
    );
    assert.equal(service.takeProof(), undefined);

    leaseOnly = true;
    assert.notEqual((await call({ action: "propose" })).status, 200);
    leaseOnly = false;
    wrongOwner = true;
    assert.notEqual((await call({ action: "propose" })).status, 200);
    wrongOwner = false;
    redirect = true;
    assert.notEqual((await call({ action: "propose" })).status, 200);
    redirect = false;
    const last = await call({ action: "propose" });
    assert.equal(last.status, 200);
    revoked = true;
    assert.notEqual(
      (
        await call({
          ...choice,
          id: last.body.id,
          requestDigest: last.body.requestDigest,
          packetDigest: last.body.packetDigest,
        })
      ).status,
      200,
    );
    assert.equal(service.takeProof(), undefined);
    assert.equal(
      paths.some((path) => path.endsWith("/register")),
      false,
    );
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
