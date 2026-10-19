import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "../modules/storage/vault.js";
import {
  CentralTransportBudget,
  type CentralBudgetReview,
} from "../modules/workflows/central-transport-budget.js";
test("native central reservations survive restart, reject replays and retain uncertain-call cost", async () => {
  const dir = await mkdtemp(join(tmpdir(), "central-budget-")),
    path = join(dir, "budget.db"),
    vault = new Vault(randomBytes(32));
  const time = Date.now(),
    review: CentralBudgetReview = {
      epoch: randomUUID(),
      approvedAt: time - 1000,
      expiresAt: time + 60000,
      maximumAttempts: 108,
      evidenceId: "synthetic-price-ceiling",
      costBasis: "explicit-one-time-approval",
      maximumMicroUSD: 1000000,
      attemptCeilingMicroUSD: 600000,
    };
  let budget = new CentralTransportBudget(
    path,
    vault,
    () => review,
    () => {},
    () => time,
  );
  const input = {
    epoch: review.epoch,
    requestId: randomUUID(),
    operationId: randomUUID(),
  };
  try {
    budget.reserve(input);
    budget.close();
    budget = new CentralTransportBudget(
      path,
      vault,
      () => review,
      () => {},
      () => time,
    );
    assert.throws(() => budget.reserve(input), /already reserved/);
    assert.throws(
      () => budget.reserve({ ...input, requestId: randomUUID() }),
      /spending budget exhausted/,
    );
    budget.close();
    // Same epoch cannot reset its allowance by replacing the reviewed limit.
    budget = new CentralTransportBudget(
      path,
      vault,
      () => ({ ...review, attemptCeilingMicroUSD: 1 }),
      () => {},
      () => time,
    );
    assert.throws(
      () => budget.reserve({ ...input, requestId: randomUUID() }),
      /review changed/,
    );
  } finally {
    budget.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("free native requests are still bounded and a revoked review cannot reserve", async () => {
  const dir = await mkdtemp(join(tmpdir(), "central-free-budget-"));
  const time = Date.now();
  const review: CentralBudgetReview = {
    epoch: randomUUID(),
    approvedAt: time - 1000,
    expiresAt: time + 60000,
    maximumAttempts: 1,
    evidenceId: "synthetic-included-proof",
    costBasis: "verified-included-usage",
    maximumMicroUSD: 0,
    attemptCeilingMicroUSD: 0,
  };
  let current: CentralBudgetReview | null = review,
    guarded = false;
  const budget = new CentralTransportBudget(
    join(dir, "budget.db"),
    new Vault(randomBytes(32)),
    () => current,
    () => {
      if (guarded) throw Error("source review revoked");
    },
    () => time,
  );
  const input = {
    epoch: review.epoch,
    requestId: randomUUID(),
    operationId: randomUUID(),
  };
  try {
    assert.throws(
      () => budget.reserve({ ...input, epoch: randomUUID() }),
      /epoch/,
    );
    budget.reserve(input);
    assert.throws(
      () => budget.reserve({ ...input, requestId: randomUUID() }),
      /budget exhausted/,
    );
    guarded = true;
    assert.throws(
      () => budget.reserve({ ...input, requestId: randomUUID() }),
      /revoked/,
    );
    guarded = false;
    current = null;
    assert.throws(() => budget.reserve({ ...input, requestId: randomUUID() }));
  } finally {
    budget.close();
    await rm(dir, { recursive: true, force: true });
  }
});
