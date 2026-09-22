import { test, expect, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../modules/storage/store.js";
import { Vault } from "../../modules/storage/vault.js";
import { PrivatePeerEnrollment } from "../../modules/remote/private-peers.js";
import { PrivateTaskReceiver } from "../../modules/remote/private-task-receiver.js";
import { inspectPrivateInvitation } from "../../modules/remote/private-peer-contracts.js";
import {
  sealPrivateEnvelope,
  privateEnvelopeSuite,
  type PrivateHeader,
} from "../../modules/remote/private-envelope.js";
import { LocalWorker } from "../../apps/companion/worker.js";
import type { PrivateTaskReceipt } from "../../modules/remote/private-task-contracts.js";
const pair = () =>
  crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
const owner = { userId: "browser-test", tenantId: "synthetic" };
const profile = {
  id: "local",
  runtime: "ollama",
  model: "synthetic",
  contextTokens: 4096,
  maxOutputTokens: 1024,
  temperature: 0.2,
} as const;
async function fixture(page: Page) {
  const external: string[] = [];
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== "http://127.0.0.1:44137") {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  await page.goto("/");
  await page.waitForFunction(() => !!window.privateProtocolTest);
  const browser = await page.evaluate(() => window.privateProtocolTest.init());
  expect(browser.secureContext).toBe(true);
  expect(browser.privateExtractable).toBe(false);
  expect(browser.privateExportDenied).toBe(true);
  const dir = mkdtempSync(join(tmpdir(), "browser-private-protocol-")),
    now = Date.now(),
    clock = () => now,
    vault = new Vault(randomBytes(32)),
    store = new Store(join(dir, "tasks.db"), vault, clock);
  store.addProfile(owner, profile);
  const binding = {
      ownerId: randomUUID(),
      deviceId: randomUUID(),
      credentialEpoch: 1,
      expiresAt: now + 3600000,
    },
    browserId = randomUUID(),
    key = await pair();
  const registry = new PrivatePeerEnrollment(
    store,
    vault,
    owner,
    () => binding,
    clock,
  );
  const invitation = {
    version: 1 as const,
    ownerId: binding.ownerId,
    recipientId: browserId,
    peerId: binding.deviceId,
    keyEpoch: 1,
    publicKey: Buffer.from(
      await crypto.subtle.exportKey("raw", key.publicKey),
    ).toString("base64url"),
    nonce: randomUUID(),
    issuedAt: now,
    expiresAt: now + 300000,
  };
  const nodeInspection = await inspectPrivateInvitation(invitation, now);
  const browserInspection = await page.evaluate(
    ({ invitation, now }) =>
      window.privateProtocolTest.inspect(invitation, now),
    { invitation, now },
  );
  expect(browserInspection.fingerprint).toBe(nodeInspection.fingerprint);
  expect(browserInspection.keyHash).toBe(nodeInspection.keyHash);
  const review = await registry.prepare({
    ...invitation,
    recipientId: binding.deviceId,
    peerId: browserId,
    publicKey: browser.publicKey,
    nonce: randomUUID(),
  });
  registry.approve({
    reviewId: review.reviewId,
    expectedRevision: review.expectedRevision,
    comparedFingerprint: review.fingerprint,
    confirmed: true,
  });
  const receiver = new PrivateTaskReceiver(
    store,
    vault,
    owner,
    () => binding,
    () => ({
      binding,
      peerId: browserId,
      recipientKeyEpoch: 1,
      permissionRevision: 1,
      modelProfileId: "local",
      tasksEnabled: true,
      recipientKey: key,
    }),
    clock,
  );
  const browserPublicKey = await crypto.subtle.importKey(
    "raw",
    Buffer.from(browser.publicKey, "base64url"),
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
  const header = (): PrivateHeader => ({
    version: 1,
    suite: privateEnvelopeSuite,
    ownerId: binding.ownerId,
    senderId: browserId,
    recipientId: binding.deviceId,
    senderKeyEpoch: 1,
    recipientKeyEpoch: 1,
    messageId: randomUUID(),
    operationId: randomUUID(),
    sequence: 1,
    issuedAt: now,
    expiresAt: now + 300000,
  });
  const seal = (h = header(), prompt = "Summarize this synthetic note.") =>
    page.evaluate(
      ({ h, prompt, now }) =>
        window.privateProtocolTest.seal(
          h,
          { version: 1, type: "task.submit", kind: "query", prompt },
          now,
        ),
      { h, prompt, now },
    );
  const response = (receipt: PrivateTaskReceipt, senderKey = key) => {
    const h = {
      ...receipt.header,
      senderId: binding.deviceId,
      recipientId: browserId,
      messageId: randomUUID(),
    };
    return sealPrivateEnvelope(
      h,
      new TextEncoder().encode(
        JSON.stringify({ version: 1, type: "task.accepted", receipt }),
      ),
      { senderKey, recipientPublicKey: browserPublicKey },
      clock,
    );
  };
  return {
    store,
    registry,
    binding,
    browserId,
    receiver,
    header,
    seal,
    response,
    now,
    external,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("Browser seals a private task that the real companion accepts and executes once", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const wire = await f.seal(),
      [first, retry] = await Promise.all([
        f.receiver.accept(wire),
        f.receiver.accept(structuredClone(wire)),
      ]);
    expect(retry).toEqual(first);
    expect(f.store.list(owner)).toHaveLength(1);
    let calls = 0;
    const worker = new LocalWorker(
      f.store,
      owner,
      {
        pin: async () => ({ profile, digest: "a".repeat(64) }),
        generate: async () => {
          calls++;
          return "synthetic browser result";
        },
      },
      (id) => f.store.profile(owner, id),
    );
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(false);
    expect(calls).toBe(1);
    expect(f.store.get(owner, first.taskId).status).toBe("completed");
    const response = await f.response(first),
      decoded = await page.evaluate(
        ({ response, now }) =>
          window.privateProtocolTest.open(response, response.header, now),
        { response, now: f.now },
      );
    expect(decoded.receipt).toEqual(first);
    expect(f.external).toEqual([]);
  } finally {
    f.close();
  }
});

test("Browser rejects altered, wrong-key, wrong-expectation, expired and plaintext receipt inputs", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const receipt = await f.receiver.accept(await f.seal()),
      response = await f.response(receipt),
      wrong = await f.response(receipt, await pair());
    const mutated = {
      ...response,
      ciphertext:
        (response.ciphertext[0] === "A" ? "B" : "A") +
        response.ciphertext.slice(1),
    };
    const cases = [
      { envelope: mutated, expected: response.header, now: f.now },
      { envelope: wrong, expected: wrong.header, now: f.now },
      {
        envelope: response,
        expected: { ...response.header, sequence: 2 },
        now: f.now,
      },
      {
        envelope: response,
        expected: response.header,
        now: response.header.expiresAt,
      },
      {
        envelope: { header: response.header, plaintext: { receipt } },
        expected: response.header,
        now: f.now,
      },
    ];
    for (const c of cases)
      expect(
        await page.evaluate(
          (c) =>
            window.privateProtocolTest.denied(c.envelope, c.expected, c.now),
          c,
        ),
      ).toBe(true);
    expect(f.external).toEqual([]);
  } finally {
    f.close();
  }
});

test("Browser-to-companion routing and peer revocation enforce current authority", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await expect(
      f.receiver.accept(await f.seal({ ...f.header(), ownerId: randomUUID() })),
    ).rejects.toThrow("DENIED");
    const pending = await f.seal();
    f.registry.revoke({
      peerId: f.browserId,
      expectedRevision: f.registry.list().revision,
      confirmed: true,
    });
    await expect(f.receiver.accept(pending)).rejects.toThrow("DENIED");
    expect(f.store.list(owner)).toHaveLength(0);
    expect(f.external).toEqual([]);
  } finally {
    f.close();
  }
});

test("Portable task contracts preserve Unicode and reject extra authority and oversized browser payloads", async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    const prompt = "Olá 🌳 — 東京\n".repeat(700),
      receipt = await f.receiver.accept(await f.seal(f.header(), prompt));
    expect(f.store.get(owner, receipt.taskId).input.prompt).toBe(prompt);
    const header = f.header();
    expect(
      await page.evaluate(
        async ({ header, now }) => {
          try {
            await window.privateProtocolTest.seal(
              header,
              {
                version: 1,
                type: "task.submit",
                kind: "query",
                prompt: "synthetic",
                sourceRefs: [],
              },
              now,
            );
            return false;
          } catch {
            return true;
          }
        },
        { header, now: f.now },
      ),
    ).toBe(true);
    await expect(f.seal(header, "\u0800".repeat(32000))).rejects.toThrow(
      "PRIVATE_ENVELOPE_INVALID",
    );
    expect(f.store.list(owner)).toHaveLength(1);
    expect(f.external).toEqual([]);
  } finally {
    f.close();
  }
});
