import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Vault } from "../modules/storage/vault.js";
import {
  NativeRuntimeCostBudget,
  nativeRuntimeCostApproval,
} from "../modules/task-sync/native-runtime-cost.js";

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "native-cost-")));
  const vault = new Vault(randomBytes(32));
  let now = Date.now(),
    allowed = true;
  const review = {
    approvalId: randomUUID(),
    reference: "synthetic-owner-approval-only",
    pricingReference: "synthetic-aggregate-downstream-ceilings",
    authorizedAt: now - 1000,
    authorizationExpiresAt: now + 60000,
    providers: ["neon", "vercel"],
    approvedAt: now - 1000,
    expiresAt: now + 60000,
    maximumMicroUSD: 1000000,
    maximumAttempts: 240,
    ceilings: {
      enrollment: 200000,
      central: 300000,
      assignment: 400000,
      attestation: 100000,
    },
  };
  const budget = (r = review) =>
    new NativeRuntimeCostBudget(
      directory,
      vault,
      r,
      () => {
        if (!allowed) throw Error("Fixture revoked");
      },
      () => now,
    );
  return {
    directory,
    review,
    budget,
    clock: (n: number) => {
      now = n;
    },
    revoke: () => {
      allowed = false;
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("all helpers and restarts share one aggregate; uncertain attempts are never refunded", () => {
  const f = fixture();
  try {
    f.budget().reserve("enrollment");
    f.budget().reserve("central");
    f.budget().reserve("assignment");
    assert.throws(
      () =>
        f.budget({ ...f.review, approvalId: randomUUID() }).reserve("central"),
      /cannot be replaced/,
    );
    // New object represents restart/another helper, not another allowance.
    f.budget().reserve("attestation");
    assert.throws(
      () => f.budget().reserve("attestation"),
      /spending budget exhausted/,
    );
    assert.throws(
      () => f.budget().reserve("enrollment"),
      /spending budget exhausted/,
    );
    const db = new Database(join(f.directory, "native-runtime-cost.db"), {
      readonly: true,
    });
    try {
      assert.equal(
        (
          db.prepare("SELECT COUNT(*) AS n FROM approvals").get() as {
            n: number;
          }
        ).n,
        1,
      );
    } finally {
      db.close();
    }
    assert.equal(
      readFileSync(join(f.directory, "native-runtime-cost.db")).includes(
        Buffer.from(f.review.reference),
      ),
      false,
    );
  } finally {
    f.cleanup();
  }
});

test("same owner approval cannot be repriced or renewed under another helper/epoch", () => {
  const f = fixture();
  try {
    f.budget().reserve("assignment");
    const changed = {
      ...f.review,
      ceilings: { ...f.review.ceilings, assignment: 1 },
    };
    assert.throws(
      () => f.budget(changed).reserve("assignment"),
      /cannot be replaced/,
    );
    assert.throws(
      () =>
        f
          .budget({
            ...f.review,
            expiresAt: f.review.expiresAt + 1,
            authorizationExpiresAt: f.review.authorizationExpiresAt + 1,
          })
          .reserve("central"),
      /cannot be replaced/,
    );
    // Rejected replacement leaves original charge, not a fresh ledger.
    f.budget().reserve("assignment");
    assert.throws(
      () => f.budget().reserve("central"),
      /spending budget exhausted/,
    );
  } finally {
    f.cleanup();
  }
});

test("an explicitly larger funding review retains the shared cap across helper restarts", () => {
  const f = fixture();
  try {
    const review = {
      ...f.review,
      authorizationExpiresAt: f.review.approvedAt + 14400000,
      expiresAt: f.review.approvedAt + 14400000,
      maximumMicroUSD: 10000000,
      ceilings: {
        enrollment: 1000000,
        central: 1000000,
        assignment: 1000000,
        attestation: 1000000,
      },
    };
    assert.equal(nativeRuntimeCostApproval.safeParse(review).success, true);
    const channels = [
      "enrollment",
      "central",
      "assignment",
      "attestation",
    ] as const;
    for (let i = 0; i < 10; i++) f.budget(review).reserve(channels[i % 4]!);
    assert.throws(
      () => f.budget(review).reserve("enrollment"),
      /spending budget exhausted/,
    );
    assert.throws(
      () =>
        f.budget({ ...review, maximumMicroUSD: 9000000 }).reserve("central"),
      /cannot be replaced/,
    );
    f.clock(review.expiresAt);
    assert.throws(() => f.budget(review), /expired/);
  } finally {
    f.cleanup();
  }
});

test("count, revocation, expiry and clock continuity deny without restoring reservations", () => {
  const f = fixture();
  try {
    const review = { ...f.review, maximumAttempts: 1 };
    f.budget(review).reserve("attestation");
    assert.throws(
      () => f.budget(review).reserve("central"),
      /request budget exhausted/,
    );
    f.revoke();
    assert.throws(() => f.budget(review), /revoked/);
  } finally {
    f.cleanup();
  }
  const g = fixture();
  try {
    g.budget().reserve("central");
    g.clock(g.review.approvedAt);
    assert.throws(() => g.budget().reserve("central"), /clock continuity/);
    g.clock(g.review.approvedAt + 1000);
    assert.throws(() => g.budget().reserve("central"), /clock continuity/);
    g.clock(g.review.expiresAt);
    assert.throws(() => g.budget(), /expired/);
  } finally {
    g.cleanup();
  }
});

test("invalid scope, oversized allowance, corrupt or substituted ledger fails closed", () => {
  const f = fixture();
  try {
    assert.equal(
      nativeRuntimeCostApproval.safeParse({
        ...f.review,
        maximumMicroUSD: 10000001,
      }).success,
      false,
    );
    assert.equal(
      nativeRuntimeCostApproval.safeParse({
        ...f.review,
        authorizationExpiresAt: f.review.approvedAt + 86400000,
        expiresAt: f.review.approvedAt + 14400001,
      }).success,
      false,
    );
    assert.equal(
      nativeRuntimeCostApproval.safeParse({
        ...f.review,
        providers: ["other", "vercel"],
      }).success,
      false,
    );
    f.budget().reserve("enrollment");
    const db = new Database(join(f.directory, "native-runtime-cost.db"));
    db.prepare("UPDATE approvals SET record=?").run(Buffer.from("corrupt"));
    db.close();
    assert.throws(() => f.budget().reserve("central"));
  } finally {
    f.cleanup();
  }
  const g = fixture();
  try {
    symlinkSync(
      join(g.directory, "elsewhere"),
      join(g.directory, "native-runtime-cost.db"),
    );
    assert.throws(() => g.budget().reserve("central"), /Protected/);
  } finally {
    g.cleanup();
  }
});

test("a verified shared resource is reserved once, across helpers, restart and lost replies", () => {
  const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "shared-native-cost-")),
    ),
    key = randomBytes(32),
    vault = new Vault(key);
  let now = Date.now();
  const review = {
    approvalId: randomUUID(),
    reference: "synthetic-owner-shared-window",
    pricingReference: "synthetic-reviewed-whole-endpoint-upper-bound",
    providers: ["neon", "vercel"],
    authorizedAt: now - 1000,
    authorizationExpiresAt: now + 14400000,
    approvedAt: now - 1000,
    expiresAt: now + 60000,
    maximumMicroUSD: 9600000,
    maximumAttempts: 240,
    sharedResourceReservation: {
      provider: "neon",
      resourceId: "neon:fixture-project/fixture-endpoint",
      reference: "synthetic-endpoint-covers-all-five-services",
      maximumMicroUSD: 3650000,
      coversFrom: now - 1000,
      coversUntil: now + 60000 + 900000,
    },
    ceilings: {
      enrollment: 17000,
      central: 27000,
      assignment: 32000,
      attestation: 17000,
    },
  };
  const budget = (r: unknown = review) =>
    new NativeRuntimeCostBudget(
      directory,
      new Vault(key),
      r,
      () => {},
      () => now,
    );
  const read = () => {
    const db = new Database(join(directory, "native-runtime-cost.db"), {
      readonly: true,
    });
    try {
      const row = db.prepare("SELECT id,record FROM approvals").get() as {
        id: string;
        record: Buffer;
      };
      return vault.open<{
        attempts: number;
        reservedMicroUSD: number;
        sharedReservedMicroUSD: number;
        held: string | null;
      }>(row.record, "native-runtime-cost:" + row.id);
    } finally {
      db.close();
    }
  };
  try {
    assert.equal(nativeRuntimeCostApproval.safeParse(review).success, true);
    // Separate real processes reopen the same encrypted aggregate. A late
    // helper still reserves the entire original resource window, not a new or
    // prorated window. All keys/requests here are synthetic and local-only.
    now = review.approvedAt + 30000;
    const child = (channel: string, count: number) =>
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `
      import {NativeRuntimeCostBudget} from ${JSON.stringify(new URL("../modules/task-sync/native-runtime-cost.ts", import.meta.url).href)};
      import {Vault} from ${JSON.stringify(new URL("../modules/storage/vault.ts", import.meta.url).href)};
      const p=process.env,b=new NativeRuntimeCostBudget(p.FIXTURE_DIRECTORY,new Vault(Buffer.from(p.FIXTURE_STORAGE_KEY,'hex')),JSON.parse(p.FIXTURE_REVIEW),()=>{},()=>Number(p.FIXTURE_NOW));
      for(let n=0;n<Number(p.FIXTURE_COUNT);n++)b.reserve(p.FIXTURE_CHANNEL);
    `,
        ],
        {
          cwd: new URL("..", import.meta.url),
          env: {
            PATH: process.env.PATH,
            TMPDIR: tmpdir(),
            FIXTURE_DIRECTORY: directory,
            FIXTURE_STORAGE_KEY: key.toString("hex"),
            FIXTURE_REVIEW: JSON.stringify(review),
            FIXTURE_NOW: String(now),
            FIXTURE_CHANNEL: channel,
            FIXTURE_COUNT: String(count),
          },
          timeout: 10000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    assert.equal(child("assignment", 68).toString(), "");
    assert.equal(child("attestation", 34).toString(), "");
    for (let n = 0; n < 8; n++) budget().reserve("enrollment");
    const shared = read();
    assert.equal(shared.attempts, 110);
    assert.equal(shared.reservedMicroUSD, 6540000);
    assert.equal(shared.sharedReservedMicroUSD, 3650000);
    assert.equal(shared.held, null);
    budget().reserve("central");
    assert.equal(read().reservedMicroUSD, 6567000);
    assert.throws(
      () =>
        budget({
          ...review,
          sharedResourceReservation: {
            ...review.sharedResourceReservation,
            maximumMicroUSD: 1,
          },
        }).reserve("assignment"),
      /cannot be replaced/,
    );
    const { sharedResourceReservation: _shared, ...withoutShared } = review;
    assert.throws(
      () => budget(withoutShared).reserve("assignment"),
      /cannot be replaced/,
    );
    assert.throws(
      () =>
        budget({
          ...review,
          sharedResourceReservation: {
            ...review.sharedResourceReservation,
            resourceId: "neon:another-endpoint",
          },
        }).reserve("assignment"),
      /cannot be replaced/,
    );
    const before = read();
    now = review.expiresAt;
    assert.throws(() => budget().reserve("enrollment"), /expired/);
    assert.deepEqual(read(), before);
    // Priced downstream/idle tail is NOT authority for a new post-expiry wire.
    now = review.expiresAt + 1;
    assert.throws(() => budget().reserve("assignment"), /expired/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shared resource coverage cannot omit the funding window or exceed aggregate authority", () => {
  const f = fixture();
  try {
    const shared = {
      provider: "neon",
      resourceId: "neon:fixture-endpoint",
      reference: "independent synthetic resource evidence",
      maximumMicroUSD: 600000,
      coversFrom: f.review.approvedAt,
      coversUntil: f.review.expiresAt + 900000,
    };
    assert.equal(
      nativeRuntimeCostApproval.safeParse({
        ...f.review,
        sharedResourceReservation: shared,
      }).success,
      true,
    );
    for (const patch of [
      { coversFrom: shared.coversFrom + 1 },
      { coversUntil: f.review.expiresAt - 1 },
      { coversUntil: f.review.expiresAt + 900001 },
      { maximumMicroUSD: 600001 },
      { maximumMicroUSD: 0 },
      { provider: "vercel" },
      { resourceId: "bad resource" },
    ])
      assert.equal(
        nativeRuntimeCostApproval.safeParse({
          ...f.review,
          sharedResourceReservation: { ...shared, ...patch },
        }).success,
        false,
      );
    // An already used legacy allowance cannot gain a different price review.
    f.budget().reserve("enrollment");
    assert.throws(
      () =>
        f
          .budget({
            ...f.review,
            sharedResourceReservation: shared,
          } as typeof f.review)
          .reserve("enrollment"),
      /cannot be replaced/,
    );
  } finally {
    f.cleanup();
  }
});
