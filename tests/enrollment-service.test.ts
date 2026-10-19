import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { EnrollmentService } from "../modules/task-sync/enrollment-service.js";
import { EnrollmentClient } from "../modules/task-sync/enrollment-client.js";
test("native service opens no session before consent and revocation closes actual session", async () => {
  const scope = {
    principal: "agent:" + randomUUID(),
    publicKey: generateKeyPairSync("ed25519")
      .publicKey.export({ format: "pem", type: "spki" })
      .toString(),
    authorityId: randomUUID(),
    deviceId: randomUUID(),
    sourceWorkspace: randomUUID(),
    ownerWallet: "0x" + "a".repeat(40),
  };
  let created = 0,
    closed = 0,
    calls = 0;
  const service = new EnrollmentService(
    () => scope,
    () => true,
    () => {
      created++;
      return {
        execute: async () => {
          calls++;
          return { fixture: true };
        },
        close() {
          closed++;
        },
      };
    },
  );
  const endpoints = await service.listen();
  const client = new EnrollmentClient(endpoints.core.url, endpoints.core.token);
  const control = (body: unknown, token = endpoints.native.token) =>
    fetch(endpoints.native.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(created, 0);
    await assert.rejects(
      client.execute({ operation: "heartbeat" }, new AbortController().signal),
    );
    assert.equal(
      (await control({ action: "propose" }, endpoints.core.token)).status,
      403,
    );
    const proposal = (await (
      await control({ action: "propose" })
    ).json()) as any;
    assert.equal(created, 0);
    assert.equal(
      (await control({ action: "approve", digest: proposal.digest })).status,
      200,
    );
    assert.equal(created, 1);
    assert.deepEqual(
      await client.execute(
        { operation: "heartbeat" },
        new AbortController().signal,
      ),
      { fixture: true },
    );
    await control({ action: "revoke" });
    await assert.rejects(
      client.execute({ operation: "heartbeat" }, new AbortController().signal),
    );
    assert.equal(calls, 1);
  } finally {
    await service.close();
  }
  assert.equal(closed, 1);
});
