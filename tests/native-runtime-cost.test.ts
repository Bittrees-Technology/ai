import test from "node:test";
import assert from "node:assert/strict";
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
