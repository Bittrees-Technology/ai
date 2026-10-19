import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Vault } from "../modules/storage/vault.js";
import { existingEnrollmentCredential } from "../modules/task-sync/enrollment-credential.js";
test("existing credential uses coordinator precedence and fails closed without fallback", async () => {
  const dir = await mkdtemp(tmpdir() + "/enrollment-credential-");
  const personal = new Vault(randomBytes(32)),
    coordinator = new Vault(randomBytes(32));
  const a = "a".repeat(64),
    b = "b".repeat(64);
  try {
    await assert.rejects(existingEnrollmentCredential(dir, personal));
    await writeFile(
      dir + "/workflow-device.enc",
      personal.seal({ controlToken: a }, "workflow-device"),
    );
    assert.equal(await existingEnrollmentCredential(dir, personal), a);
    await mkdir(dir + "/marketplace");
    await writeFile(
      dir + "/marketplace/connection.enc",
      coordinator.seal({ controlToken: b }, "marketplace-connection"),
    );
    await assert.rejects(
      existingEnrollmentCredential(dir, personal),
      /vault required/,
    );
    assert.equal(
      await existingEnrollmentCredential(dir, personal, coordinator),
      b,
    );
    await assert.rejects(existingEnrollmentCredential(dir, personal, personal));
    await writeFile(dir + "/marketplace/connection.enc", Buffer.alloc(65537));
    await assert.rejects(
      existingEnrollmentCredential(dir, personal, coordinator),
    );
    await rm(dir + "/marketplace/connection.enc");
    await symlink(
      dir + "/workflow-device.enc",
      dir + "/marketplace/connection.enc",
    );
    await assert.rejects(
      existingEnrollmentCredential(dir, personal, coordinator),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
