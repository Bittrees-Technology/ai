import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { EnrollmentConsent } from "../modules/task-sync/enrollment-consent.js";
import { EnrollmentControl } from "../modules/task-sync/enrollment-control.js";
const native = "a".repeat(64),
  core = "b".repeat(64);
test("native control excludes core/browser capabilities and requires exact displayed approval", async () => {
  const scope = {
    principal: "agent:" + randomUUID(),
    publicKey: generateKeyPairSync("ed25519")
      .publicKey.export({ format: "pem", type: "spki" })
      .toString(),
    authorityId: randomUUID(),
    deviceId: randomUUID(),
    sourceWorkspace: randomUUID(),
    ownerWallet: "0x" + "c".repeat(40),
  };
  let revoked = 0;
  const consent = new EnrollmentConsent(
    () => scope,
    () => true,
    () => {
      revoked++;
    },
  );
  assert.throws(() => new EnrollmentControl(core, core, consent));
  const control = new EnrollmentControl(native, core, consent);
  const url = await control.listen();
  const send = (
    body: unknown,
    token = native,
    headers: Record<string, string> = {},
  ) =>
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await send({ action: "propose" }, core)).status, 403);
    assert.equal(
      (
        await send({ action: "propose" }, native, {
          Origin: "https://ai.bittrees.org",
        })
      ).status,
      403,
    );
    assert.equal(
      (await send({ action: "propose", ownerWallet: scope.ownerWallet }))
        .status,
      400,
    );
    assert.equal((await send({ operation: "heartbeat" })).status, 400);
    const proposal = (await (await send({ action: "propose" })).json()) as any;
    assert.equal(consent.current(), null);
    assert.equal(
      (await send({ action: "approve", digest: "0".repeat(64) })).status,
      400,
    );
    const result = await (
      await send({ action: "approve", digest: proposal.digest })
    ).json();
    assert.deepEqual(result, { approved: true });
    assert.equal(consent.current()?.deviceId, scope.deviceId);
    assert.equal(
      (await send({ action: "approve", digest: proposal.digest })).status,
      400,
    );
    assert.deepEqual(await (await send({ action: "revoke" })).json(), {
      revoked: true,
    });
    assert.equal(consent.current(), null);
    assert.equal(revoked, 1);
  } finally {
    await control.close();
  }
  await assert.rejects(control.listen());
});
