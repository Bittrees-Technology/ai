import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { RemoteTemplateStore } from "../modules/remote/templates.js";
import { RemoteDeviceStore } from "../modules/remote/devices.js";
import { cleanupRemote } from "../modules/remote/maintenance.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function checkRemoteTemplates(pool: Pool) {
  assert.throws(
    () => new RemoteTemplateStore(pool, 86400000, Date.now, {} as any),
    /INVALID_INPUT/,
  );
  let now = Date.now(),
    tick = 0;
  const clock = () => {
    const value = now;
    now += tick;
    return value;
  };
  const ownerId = randomUUID(),
    otherOwner = randomUUID(),
    deviceId = randomUUID();
  const statusSecret = randomBytes(32).toString("base64url"),
    controlSecret = randomBytes(32).toString("base64url");
  await pool.query(
    "INSERT INTO remote_devices(id,owner_id,epoch,expires_at,credential_hash,control_credential_hash,control_id,controls_enabled) VALUES($1,$2,1,$3,$4,$5,$6,true)",
    [
      deviceId,
      ownerId,
      now + 2 * 86400000,
      digest(statusSecret),
      digest(controlSecret),
      randomUUID(),
    ],
  );
  const statusIdentity = { ownerId, deviceId, epoch: 1 },
    queue = new RemoteTemplateStore(pool, 86400000, clock);
  const credential = randomBytes(32).toString("base64url"),
    permissionId = randomUUID();
  const localOwner = { userId: "test-local", tenantId: "personal" },
    local = new Store(":memory:", new Vault(randomBytes(32)), () => now);
  local.addProfile(localOwner, {
    id: "p",
    runtime: "ollama",
    model: "local",
    contextTokens: 4096,
    maxOutputTokens: 1024,
    temperature: 0.2,
  });
  const template = local.saveTemplate(localOwner, {
    id: randomUUID(),
    expectedRevision: 0,
    confirmed: true,
    definition: {
      name: "PRIVATE_TITLE",
      prompt: "PRIVATE_PROMPT",
      kind: "query",
      modelProfileId: "p",
    },
  });
  const identity = {
    scope: "templates:run" as const,
    remoteOwnerId: ownerId,
    deviceId,
    epoch: 1,
    permissionId,
  };
  const approval = {
    identity,
    templateId: template.id,
    templateRevision: 1,
    maxRuns: 3,
    expiresAt: now + 600000,
    confirmed: true,
  };
  local.remoteTemplates.approve(localOwner, approval);
  const publication = {
    permissionId,
    templateId: template.id,
    templateRevision: 1,
    approvedAt: now,
    expiresAt: approval.expiresAt,
    maxRuns: 3,
    credentialHash: digest(credential),
    confirmed: true,
  };
  const request = () => ({
    permissionId,
    confirmed: true,
    command: {
      id: randomUUID(),
      deviceId,
      templateId: template.id,
      templateRevision: 1,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60000).toISOString(),
    },
  });
  try {
    await assert.rejects(
      queue.publish({ ...statusIdentity, ownerId: otherOwner }, publication),
      /DENIED/,
    );
    await assert.rejects(
      queue.publish(statusIdentity, { ...publication, prompt: "PRIVATE" }),
      /INVALID_INPUT/,
    );
    const published = await Promise.all([
      queue.publish(statusIdentity, publication),
      queue.publish(statusIdentity, publication),
    ]);
    assert.equal(published.filter((x) => x.duplicate).length, 1);
    assert.equal(JSON.stringify(published).includes("credentialHash"), false);
    assert.equal(JSON.stringify(published).includes("PRIVATE"), false);
    await assert.rejects(
      queue.publish(statusIdentity, { ...publication, maxRuns: 4 }),
      /CONFLICT/,
    );
    assert.deepEqual(await queue.authenticate(credential), identity);
    await assert.rejects(queue.authenticate(statusSecret), /DENIED/);
    await assert.rejects(queue.authenticate(controlSecret), /DENIED/);
    const devices = new RemoteDeviceStore(pool, 86400000, () => now);
    await assert.rejects(devices.authenticate(credential), /DENIED/);
    await assert.rejects(devices.authenticateControls(credential), /DENIED/);
    await assert.rejects(
      queue.poll({ ...identity, scope: "controls:pause-cancel" }),
      /INVALID_INPUT/,
    );
    await assert.rejects(queue.list(otherOwner, deviceId), /DENIED/);
    assert.deepEqual(
      (await queue.list(ownerId, deviceId)).items.map((x) => x.permissionId),
      [permissionId],
    );
    const input = request();
    await assert.rejects(queue.submit(otherOwner, input), /DENIED/);
    await assert.rejects(
      queue.submit(ownerId, {
        ...input,
        command: { ...input.command, prompt: "override" },
      }),
      /INVALID_INPUT/,
    );
    await assert.rejects(
      queue.submit(ownerId, {
        ...input,
        command: { ...input.command, templateRevision: 2 },
      }),
      /CONFLICT/,
    );
    const submissions = await Promise.all([
      queue.submit(ownerId, input),
      queue.submit(ownerId, input),
    ]);
    assert.equal(submissions.filter((x) => x.duplicate).length, 1);
    assert.equal(
      (await queue.publish(statusIdentity, publication)).template.submittedRuns,
      1,
    );
    await assert.rejects(
      queue.submit(ownerId, {
        ...input,
        command: {
          ...input.command,
          expiresAt: new Date(now + 30000).toISOString(),
        },
      }),
      /CONFLICT/,
    );
    const batch = await queue.poll(await queue.authenticate(credential));
    assert.deepEqual(batch.commands, [input.command]);
    const result = local.remoteTemplates.execute(
      localOwner,
      batch.identity,
      batch.commands[0],
    );
    assert.equal(result.receipt.outcome, "queued");
    assert.equal(
      local.get(localOwner, result.receipt.taskId!).input.prompt,
      "PRIVATE_PROMPT",
    );
    assert.equal(
      (await queue.acknowledge(identity, result.receipt)).duplicate,
      false,
    );
    assert.equal(
      (
        await new RemoteTemplateStore(pool, 86400000, () => now).acknowledge(
          identity,
          result.receipt,
        )
      ).duplicate,
      true,
    );
    await assert.rejects(
      queue.acknowledge(identity, { ...result.receipt, taskId: randomUUID() }),
      /CONFLICT/,
    );
    assert.deepEqual(
      await queue.inspect(ownerId, permissionId, input.command.id),
      { state: "received", receipt: result.receipt },
    );
    assert.deepEqual((await queue.poll(identity)).commands, []);
    const remaining = await Promise.allSettled([
      queue.submit(ownerId, request()),
      queue.submit(ownerId, request()),
      queue.submit(ownerId, request()),
    ]);
    assert.equal(remaining.filter((x) => x.status === "fulfilled").length, 2);
    assert.equal(
      (await queue.publish(statusIdentity, publication)).template.submittedRuns,
      3,
    );
    assert.equal((await queue.poll(identity)).commands.length, 2);
    const rows = (
      await pool.query(
        "SELECT * FROM remote_templates WHERE permission_id=$1",
        [permissionId],
      )
    ).rows;
    assert.equal(JSON.stringify(rows).includes(credential), false);
    assert.equal(JSON.stringify(rows).includes("PRIVATE"), false);
    const replacementSecret = randomBytes(32).toString("base64url");
    const replacement = {
      ...publication,
      permissionId: randomUUID(),
      credentialHash: digest(replacementSecret),
    };
    await queue.publish(statusIdentity, replacement);
    await assert.rejects(queue.poll(identity), /DENIED/);
    await assert.rejects(queue.authenticate(credential), /DENIED/);
    await assert.rejects(queue.publish(statusIdentity, publication), /DENIED/);
    const pending = (
      remaining.find(
        (x) => x.status === "fulfilled",
      ) as PromiseFulfilledResult<any>
    ).value.command;
    assert.deepEqual(await queue.inspect(ownerId, permissionId, pending.id), {
      state: "cancelled",
    });
    const newIdentity = await queue.authenticate(replacementSecret);
    await pool.query("UPDATE remote_devices SET epoch=2 WHERE id=$1", [
      deviceId,
    ]);
    await assert.rejects(queue.poll(newIdentity), /DENIED/);
    await assert.rejects(queue.authenticate(replacementSecret), /DENIED/);
    assert.deepEqual((await queue.list(ownerId, deviceId)).items, []);
  } finally {
    local.close();
  }

  // Catalogue pages expose only bounded metadata and recheck the device every time.
  const pageDevice = randomUUID();
  await pool.query(
    "INSERT INTO remote_devices(id,owner_id,epoch,expires_at) VALUES($1,$2,1,$3)",
    [pageDevice, ownerId, now + 86400000],
  );
  const pageAuth = { ownerId, deviceId: pageDevice, epoch: 1 };
  for (let n = 0; n < 101; n++)
    await queue.publish(pageAuth, {
      ...publication,
      permissionId: randomUUID(),
      templateId: randomUUID(),
      credentialHash: digest(randomBytes(32).toString("base64url")),
      approvedAt: now,
      expiresAt: now + 600000,
    });
  const page1 = await queue.list(ownerId, pageDevice);
  const page2 = await queue.list(ownerId, pageDevice, page1.nextCursor!);
  assert.equal(page1.items.length, 100);
  assert.equal(page2.items.length, 1);
  assert.equal(
    new Set([...page1.items, ...page2.items].map((x) => x.permissionId)).size,
    101,
  );
  assert.equal(page2.nextCursor, null);
  const pagePermission = page1.items[0]!.permissionId;
  await assert.rejects(queue.revoke(otherOwner, pagePermission), /DENIED/);
  await queue.revoke(ownerId, pagePermission);
  await assert.rejects(
    queue.poll({
      scope: "templates:run",
      remoteOwnerId: ownerId,
      deviceId: pageDevice,
      epoch: 1,
      permissionId: pagePermission,
    }),
    /DENIED/,
  );

  await assert.rejects(
    queue.list(otherOwner, pageDevice, page1.nextCursor!),
    /DENIED/,
  );
  await pool.query("UPDATE remote_devices SET revoked_at=$2 WHERE id=$1", [
    pageDevice,
    now,
  ]);
  await assert.rejects(
    queue.list(ownerId, pageDevice, page1.nextCursor!),
    /DENIED/,
  );

  // A separate device exercises both stored and live limits under concurrent requests.
  const limitedDevice = randomUUID();
  await pool.query(
    "INSERT INTO remote_devices(id,owner_id,epoch,expires_at) VALUES($1,$2,1,$3)",
    [limitedDevice, ownerId, now + 2 * 86400000],
  );
  const limitedAuth = { ownerId, deviceId: limitedDevice, epoch: 1 };
  const limited = new RemoteTemplateStore(pool, 86400000, clock, {
    permissionsPerDevice: 2,
    commandsPerDevice: 2,
    pendingPerDevice: 1,
  });
  const makePublication = () => ({
    ...publication,
    permissionId: randomUUID(),
    templateId: randomUUID(),
    credentialHash: digest(randomBytes(32).toString("base64url")),
    approvedAt: now,
    expiresAt: now + 600000,
    maxRuns: 20,
  });
  const first = makePublication(),
    second = makePublication();
  await limited.publish(limitedAuth, first);
  await limited.publish(limitedAuth, second);
  await assert.rejects(
    limited.publish(limitedAuth, makePublication()),
    /CAPACITY/,
  );
  const makeRequest = (p = first) => ({
    permissionId: p.permissionId,
    confirmed: true,
    command: {
      id: randomUUID(),
      deviceId: limitedDevice,
      templateId: p.templateId,
      templateRevision: 1,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60000).toISOString(),
    },
  });
  const races = await Promise.allSettled([
    limited.submit(ownerId, makeRequest()),
    limited.submit(ownerId, makeRequest(second)),
  ]);
  assert.equal(races.filter((x) => x.status === "fulfilled").length, 1);
  now += 60001;
  const historyCount = Number(
    (
      await pool.query(
        "SELECT count(*) FROM remote_template_commands c JOIN remote_templates t ON t.permission_id=c.permission_id WHERE t.device_id=$1",
        [limitedDevice],
      )
    ).rows[0].count,
  );
  await cleanupRemote(pool, 1, now);
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT count(*) FROM remote_template_commands c JOIN remote_templates t ON t.permission_id=c.permission_id WHERE t.device_id=$1",
          [limitedDevice],
        )
      ).rows[0].count,
    ),
    historyCount,
  );
  await limited.submit(ownerId, makeRequest());
  now += 60001;
  await assert.rejects(limited.submit(ownerId, makeRequest()), /CAPACITY/);
  const before = (
    await pool.query(
      "SELECT submitted_runs FROM remote_templates WHERE permission_id=$1",
      [first.permissionId],
    )
  ).rows[0].submitted_runs;
  const unconstrained = new RemoteTemplateStore(pool, 86400000, clock);
  const fault = makeRequest();
  tick = 20000;
  await assert.rejects(unconstrained.submit(ownerId, fault), /DENIED/);
  tick = 0;
  assert.equal(
    (
      await pool.query("SELECT id FROM remote_template_commands WHERE id=$1", [
        fault.command.id,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT submitted_runs FROM remote_templates WHERE permission_id=$1",
        [first.permissionId],
      )
    ).rows[0].submitted_runs,
    before,
  );
  // Cleanup never cascades unbounded child history; each pass deletes <= its explicit limit.
  now += 2 * 86400000;
  const cut = now;
  for (let n = 0; n < 120; n++) {
    const result = await cleanupRemote(pool, 1, cut);
    assert.ok(Object.values(result.counts).every((count) => count <= 1));
  }
  assert.equal(
    (
      await pool.query("SELECT * FROM remote_templates WHERE device_id=$1", [
        limitedDevice,
      ])
    ).rowCount,
    0,
  );
  await assert.rejects(limited.submit(ownerId, fault), /DENIED/);
  console.log(
    "Template relay scope isolation, exact retry, native SQLite execution, bounded concurrent admission, permission replacement/rotation, rollback and bounded cleanup passed.",
  );
}
