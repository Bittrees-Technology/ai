import test from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { RuntimeHandoff } from "../modules/task-sync/handoff.js";
import {
  runtimeHandoffMessage,
  runtimeEnrollmentMessage,
} from "../modules/task-sync/runtime-contract.js";
import { digest } from "../modules/task-sync/proof-contract.js";
function fixture() {
  const keys = generateKeyPairSync("ed25519"),
    publicKey = keys.publicKey
      .export({ format: "pem", type: "spki" })
      .toString(),
    d = {
      principal: "agent:" + randomUUID(),
      publicKey,
      credentialId: createHash("sha256").update(publicKey).digest("hex"),
    };
  let now = Date.now(),
    saved: any = null,
    calls = 0,
    mode = "valid",
    signed = 0;
  const id = randomUUID(),
    profileId = randomUUID(),
    pollSecret = "a".repeat(64);
  const input = {
    kind: "enroll",
    authorityId: randomUUID(),
    deviceId: randomUUID(),
    sourceWorkspace: randomUUID(),
    ownerWallet: "0x" + "b".repeat(40),
  };
  const request = (async (url: any, init: any) => {
    calls++;
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.headers.Cookie, undefined);
    assert.equal(init.redirect, "error");
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/start")) {
      assert.ok(
        verify(
          null,
          Buffer.from(runtimeHandoffMessage(body.request)),
          keys.publicKey,
          Buffer.from(body.signature, "base64"),
        ),
      );
      return Response.json({
        id,
        pollSecret,
        reviewUrl: "https://roles.bittrees.org/profile?runtimeRequest=" + id,
        expiresAt: new Date(now + 300000).toISOString(),
      });
    }
    assert.equal(body.pollSecret, pollSecret);
    if (String(url).endsWith("/poll")) {
      const { kind, ownerWallet, ...r } = saved.candidate;
      return Response.json({
        status: "approved",
        request: {
          ...r,
          profileId,
          issuedAt: mode === "stale" ? now - 16000 : now,
          deviceId: mode === "changed" ? randomUUID() : r.deviceId,
        },
      });
    }
    assert.ok(
      verify(
        null,
        Buffer.from(runtimeEnrollmentMessage(body.proof.request)),
        keys.publicKey,
        Buffer.from(body.proof.signature, "base64"),
      ),
    );
    const binding = {
      version: 1,
      ownerProfileId: profileId,
      ownerWallet: input.ownerWallet,
      authorityId: input.authorityId,
      deviceId: input.deviceId,
      principal: d.principal,
      credentialId: d.credentialId,
      sourceWorkspace: input.sourceWorkspace,
      tenant: "roles:" + profileId,
      workspace: "crm:" + input.sourceWorkspace,
    };
    return Response.json({
      status: "complete",
      result: {
        ...d,
        binding,
        runtimeBindingDigest: digest(binding),
        permissionsGranted: false,
      },
    });
  }) as typeof fetch;
  const h = new RuntimeHandoff(
    () => saved,
    (s) => (saved = s),
    () => d,
    (m) => {
      signed++;
      return sign(null, Buffer.from(m), keys.privateKey).toString("base64");
    },
    async () => ({ testAttestation: true }),
    request,
    () => now,
  );
  return {
    h,
    input,
    setMode: (v: string) => (mode = v),
    calls: () => calls,
    signed: () => signed,
    advance: () => (now += 300001),
  };
}
test("owner handoff signs only the reviewed device and keeps poll secret out of status", async () => {
  const f = fixture();
  await f.h.start(f.input);
  assert.ok(!JSON.stringify(f.h.status()).includes("a".repeat(64)));
  await f.h.tick();
  assert.equal(f.h.status()?.status, "complete");
  assert.equal(f.h.result().permissionsGranted, false);
  assert.equal(f.calls(), 3);
  await f.h.tick();
  assert.equal(f.calls(), 3);
});
for (const mode of ["changed", "stale"])
  test("handoff refuses " + mode + " challenge without signing", async () => {
    const f = fixture();
    await f.h.start(f.input);
    f.setMode(mode);
    await f.h.tick();
    assert.equal(f.signed(), 1);
    assert.equal(f.calls(), 2);
    assert.equal(f.h.result(), null);
  });
test("handoff stops polling after five minute expiry", async () => {
  const f = fixture();
  await f.h.start(f.input);
  f.advance();
  await f.h.tick();
  assert.equal(f.h.status()?.status, "expired");
  assert.equal(f.calls(), 1);
});
