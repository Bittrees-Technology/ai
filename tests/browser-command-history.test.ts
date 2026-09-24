import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  commandHistorySchema,
  commandObservationSchema,
} from "../modules/remote/browser-command-history.js";
const now = Date.now();
const command = {
  id: randomUUID(),
  deviceId: randomUUID(),
  taskId: randomUUID(),
  command: "pause",
  expectedRevision: 1,
  issuedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 300000).toISOString(),
};
const receipt = {
  id: command.id,
  deviceId: command.deviceId,
  outcome: "applied",
  completedAt: new Date(now + 1).toISOString(),
};
const observation = { command, state: "acknowledged", receipt };
const journal = {
  version: 1,
  ownerId: randomUUID(),
  revision: 1,
  entries: [
    { command, savedAt: now, observation: { at: now + 1, value: observation } },
  ],
};
test("command receipt journal rejects mixed targets and false acknowledged states", () => {
  assert.equal(commandObservationSchema.safeParse(observation).success, true);
  for (const invalid of [
    { ...observation, receipt: null },
    { ...observation, state: "pending" },
    { ...observation, receipt: { ...receipt, id: randomUUID() } },
    { ...observation, receipt: { ...receipt, deviceId: randomUUID() } },
    { ...observation, receipt: { ...receipt, completedAt: command.expiresAt } },
    {
      ...observation,
      receipt: { ...receipt, completedAt: new Date(now - 1).toISOString() },
    },
  ])
    assert.equal(commandObservationSchema.safeParse(invalid).success, false);
});
test("retained command metadata cannot contain credentials, task text or new command authority", () => {
  for (const extra of [
    { token: "private" },
    { prompt: "private" },
    { authority: { userId: "other" } },
  ])
    assert.equal(
      commandHistorySchema.safeParse({
        ...journal,
        entries: [{ ...journal.entries[0], command: { ...command, ...extra } }],
      }).success,
      false,
    );
  for (const action of ["resume", "run", "publish"])
    assert.equal(
      commandObservationSchema.safeParse({
        ...observation,
        command: { ...command, command: action },
      }).success,
      false,
    );
  assert.equal(
    commandHistorySchema.safeParse({ ...journal, credentials: "private" })
      .success,
    false,
  );
});
test("retained observations cannot substitute another reviewed intent or extend its deadline", () => {
  assert.equal(commandHistorySchema.safeParse(journal).success, true);
  for (const patch of [
    { id: randomUUID() },
    { taskId: randomUUID() },
    { deviceId: randomUUID() },
    { command: "cancel" },
    { expectedRevision: 2 },
    {
      issuedAt: new Date(now + 1).toISOString(),
      expiresAt: new Date(now + 300001).toISOString(),
    },
  ]) {
    const changed = {
      ...observation,
      command: { ...command, ...patch },
      receipt: null,
      state: "pending",
    };
    assert.equal(
      commandHistorySchema.safeParse({
        ...journal,
        entries: [
          {
            ...journal.entries[0],
            observation: { at: now + 2, value: changed },
          },
        ],
      }).success,
      false,
    );
  }
});
test("bounded history rejects duplicate identities, obsolete versions and observations predating storage", () => {
  assert.equal(
    commandHistorySchema.safeParse({
      ...journal,
      entries: [...journal.entries, ...journal.entries],
    }).success,
    false,
  );
  assert.equal(
    commandHistorySchema.safeParse({ ...journal, version: 2 }).success,
    false,
  );
  assert.equal(
    commandHistorySchema.safeParse({
      ...journal,
      entries: [
        {
          ...journal.entries[0],
          observation: { at: now - 1, value: observation },
        },
      ],
    }).success,
    false,
  );
  const entries = Array.from({ length: 101 }, () => ({
    command: { ...command, id: randomUUID() },
    savedAt: now,
    observation: null,
  }));
  assert.equal(
    commandHistorySchema.safeParse({ ...journal, entries }).success,
    false,
  );
});
