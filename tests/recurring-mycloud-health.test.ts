import assert from "node:assert/strict";
import test from "node:test";
import { myCloudHealthReceipt } from "../modules/workflows/recurring-mycloud-health.js";

const now = Date.parse("2026-10-18T16:00:00Z");
const readings = {
  var: { used_percent: 40 },
  data: { used_percent: 70 },
  smart_passed: true,
  temperature_c: 64,
  reallocated_sectors: 0,
  pending_sectors: 0,
  uncorrectable_sectors: 0,
  smb_active: true,
  logrotate_result: "success",
};
const raw = (changes = {}, issues = ["disk_temperature_high"]) =>
  JSON.stringify({
    checked_at: new Date(now).toISOString(),
    issues,
    readings: { ...readings, ...changes, password: "never-return-this" },
    error: "never-return-this",
  });
test("known64C and unchanged readings stay quiet; unreviewed text is redacted", () => {
  const first = myCloudHealthReceipt(raw(), undefined, now);
  assert.deepEqual(first.notifications, []);
  assert.deepEqual(
    myCloudHealthReceipt(raw(), first.observation, now).notifications,
    [],
  );
  assert.ok(!JSON.stringify(first).includes("never-return-this"));
});
test("65C crossing, subsequent worsening and recovery are deterministic", () => {
  const baseline = myCloudHealthReceipt(raw(), undefined, now).observation;
  const hot = myCloudHealthReceipt(raw({ temperature_c: 65 }), baseline, now);
  assert.ok(hot.notifications.includes("new:disk_temperature_65C_or_above"));
  assert.deepEqual(
    myCloudHealthReceipt(raw({ temperature_c: 65 }), hot.observation, now)
      .notifications,
    [],
  );
  assert.ok(
    myCloudHealthReceipt(
      raw({ temperature_c: 66 }),
      hot.observation,
      now,
    ).notifications.includes("worsened:temperature"),
  );
  assert.deepEqual(
    myCloudHealthReceipt(raw(), hot.observation, now).notifications,
    ["recovered:disk_temperature_65C_or_above"],
  );
});
test("all required disk, space and service thresholds are checked", () => {
  const result = myCloudHealthReceipt(
    raw({
      smart_passed: false,
      pending_sectors: 1,
      var: { used_percent: 80 },
      data: { used_percent: 90 },
      smb_active: false,
      logrotate_result: "failed",
    }),
    undefined,
    now,
  );
  assert.equal(result.notifications.length, 6);
  const worse = myCloudHealthReceipt(
    raw({
      smart_passed: false,
      pending_sectors: 2,
      var: { used_percent: 81 },
      data: { used_percent: 91 },
      smb_active: false,
      logrotate_result: "failed",
    }),
    result.observation,
    now,
  );
  assert.deepEqual(worse.notifications, [
    "worsened:dataUsedPercent",
    "worsened:pending",
    "worsened:varUsedPercent",
  ]);
});
test("connection failure is deduplicated and does not fabricate recovery", () => {
  const failing = myCloudHealthReceipt(
    raw({ smart_passed: false }),
    undefined,
    now,
  ).observation;
  const downRaw = raw({ error: "private ssh details" }, ["nas_unreachable"]);
  const down = myCloudHealthReceipt(downRaw, failing, now);
  assert.deepEqual(down.notifications, ["new:nas_unreachable"]);
  assert.deepEqual(
    myCloudHealthReceipt(downRaw, down.observation, now).notifications,
    [],
  );
  assert.deepEqual(
    myCloudHealthReceipt(raw(), down.observation, now).notifications,
    ["recovered:nas_unreachable", "recovered:smart_failure"],
  );
});
test("stale, incomplete, invalid and oversized evidence cannot claim success", () => {
  for (const value of [
    raw({ pending_sectors: undefined }),
    raw({ temperature_c: undefined }),
    raw({ var: { used_percent: 101 } }),
    "x".repeat(32769),
    raw().replace("2026-10-18T16:00:00.000Z", "2026-10-18T15:00:00.000Z"),
  ])
    assert.throws(() => myCloudHealthReceipt(value, undefined, now));
});
