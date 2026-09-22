import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import {
  projectRemoteStatus,
  remoteControlSchema,
  remoteTemplateSchema,
  remoteReceiptSchema,
  statusBatchSchema,
  parseRemoteControl,
} from "../modules/remote/status.js";
const deviceId = randomUUID(),
  now = Date.now();
const command = {
  id: randomUUID(),
  deviceId,
  taskId: randomUUID(),
  command: "cancel",
  expectedRevision: 1,
  issuedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 60000).toISOString(),
};
test("Status projection from actual stored task contains only allowed metadata", () => {
  const store = new Store(":memory:", new Vault(randomBytes(32))),
    owner = { userId: "private-user", tenantId: "private-tenant" };
  try {
    const task = store.create(
      owner,
      {
        conversationId: "PRIVATE_CONVERSATION",
        kind: "draft",
        prompt: "PRIVATE_PROMPT_MAIL_SUBJECT",
        modelProfileId: "PRIVATE_MODEL",
        dependencies: [],
        priority: "normal",
        tags: ["PRIVATE_TAG"],
      },
      "key",
    );
    task.result = { text: "PRIVATE_RESULT" };
    const status = projectRemoteStatus(task, deviceId);
    assert.deepEqual(Object.keys(status), [
      "id",
      "deviceId",
      "status",
      "revision",
      "updatedAt",
    ]);
    assert.ok(!JSON.stringify(status).includes("PRIVATE"));
    assert.equal(
      statusBatchSchema.safeParse({ sequence: 1, items: [status] }).success,
      true,
    );
    assert.equal(
      statusBatchSchema.safeParse({ sequence: 1, items: [status, status] })
        .success,
      false,
    );
    for (const key of [
      "title",
      "prompt",
      "subject",
      "result",
      "memory",
      "error",
      "sourceRefs",
      "wallet",
    ])
      assert.equal(
        statusBatchSchema.safeParse({
          sequence: 1,
          items: [{ ...status, [key]: "PRIVATE" }],
        }).success,
        false,
      );
    assert.throws(() => projectRemoteStatus(task, "PRIVATE_DEVICE_NAME"));
  } finally {
    store.close();
  }
});
test("Status controls cannot submit free text, resume, content approvals or caller authority", () => {
  assert.equal(remoteControlSchema.safeParse(command).success, true);
  for (const extra of [
    { command: "resume" },
    { command: "send" },
    { command: "approve" },
    { prompt: "PRIVATE" },
    { owner: "other" },
    { tenantId: "other" },
    { taskId: "PRIVATE_TITLE" },
    { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
  ])
    assert.equal(
      remoteControlSchema.safeParse({ ...command, ...extra }).success,
      false,
    );
  assert.equal(
    remoteReceiptSchema.safeParse({
      id: command.id,
      deviceId,
      outcome: "denied",
      completedAt: new Date(now).toISOString(),
      error: "PRIVATE",
    }).success,
    false,
  );
  const template = {
    id: command.id,
    deviceId,
    templateId: randomUUID(),
    templateRevision: 1,
    issuedAt: command.issuedAt,
    expiresAt: command.expiresAt,
  };
  assert.equal(remoteTemplateSchema.safeParse(template).success, true);
  assert.equal(
    remoteTemplateSchema.safeParse({
      ...template,
      arguments: { prompt: "PRIVATE" },
    }).success,
    false,
  );
});
test("Expired, excessive and future command leases are rejected without authorizing execution", () => {
  assert.deepEqual(parseRemoteControl(command, now), command);
  for (const change of [
    { expiresAt: new Date(now).toISOString() },
    { expiresAt: new Date(now + 300001).toISOString() },
    { issuedAt: new Date(now + 31000).toISOString() },
  ])
    assert.throws(
      () => parseRemoteControl({ ...command, ...change }, now),
      /EXPIRED/,
    );
  assert.throws(() => parseRemoteControl(command, NaN), /EXPIRED/);
});
