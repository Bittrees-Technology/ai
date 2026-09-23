import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { MailSendController } from "../apps/dashboard/mail-send-state.js";
import { MailSendConnector } from "../modules/connectors/mail-send.js";
import { mailSendDigest } from "../modules/connectors/mail-send-contracts.js";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { localApi } from "../apps/companion/http.js";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  reviewId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const identity = {
  wallet: "0x" + "1".repeat(40),
  mailbox: "fixture@bittrees.org",
};
const envelope = {
  contractVersion: "mail-ai-send-v1",
  operationId: id,
  from: identity.mailbox,
  to: ["one@example.org"],
  cc: ["two@example.org"],
  bcc: ["hidden@example.org"],
  subject: "Exact <script> subject",
  text: "Exact body\n",
  attachments: [],
  reply: null,
};
const record = () => ({
  identity,
  envelope: structuredClone(envelope),
  reconciliationOnly: false,
  recordedAt: new Date().toISOString(),
  submittedAt: null,
  submittedGrantId: null,
  sourceSubmission: "unobserved",
  receipt: null,
  lastCheckedAt: null,
});

test("acknowledged deletion clears private record even if refreshing permission then fails", async () => {
  let deleted = false;
  const c = new MailSendController(async (path) => {
    if (path.includes("/history/")) return record();
    if (path.endsWith("/delete")) {
      deleted = true;
      return { removed: true };
    }
    throw Error("status unavailable");
  });
  await c.load(id);
  c.setDelete(true);
  await c.remove();
  assert.equal(deleted, true);
  assert.equal(c.record, null);
  assert.equal(c.history, null);
  assert.equal(c.status, null);
  assert.match(c.notice, /deleted/);
});
function fixture() {
  let now = Date.now(),
    r: any = record(),
    hold: string | null = null,
    resolve: (v: any) => void = () => {},
    reject: (e: unknown) => void = () => {};
  const calls: { path: string; body: any }[] = [];
  const review = () => ({
    id: reviewId,
    operationId: id,
    envelope: structuredClone(r.envelope),
    identity,
    digest: mailSendDigest(r.envelope),
    expiresAt: new Date(now + 120000).toISOString(),
  });
  const status = () => ({
    available: true,
    connection: {
      ...identity,
      operationId: id,
      grantId: "a".repeat(64),
      digest: mailSendDigest(r.envelope),
      recipientCount: 3,
      audience: "https://ai.bittrees.org",
      expiresAt: new Date(now + 900000).toISOString(),
      state: "stored",
      previouslySubmitted: false,
    },
  });
  const c = new MailSendController(
    async (path, _method, body) => {
      calls.push({ path, body });
      if (path.endsWith("/" + hold))
        return new Promise((a, b) => {
          resolve = a;
          reject = b;
        });
      if (path.endsWith("/review")) return review();
      if (path.endsWith("/confirm")) throw Error("MAIL_SEND_UNCONFIRMED");
      if (path.endsWith("/cancel")) return { cancelled: true };
      if (path.endsWith("/reconcile"))
        return {
          ...r,
          submittedAt: new Date().toISOString(),
          sourceSubmission: "reserved",
        };
      if (path.endsWith("/reconnect") || path.endsWith("/prepare"))
        return {
          operationId: id,
          expiresAt: new Date(now + 600000).toISOString(),
          reviewFile: {
            version: "bittrees-mail-review-v1",
            challenge: "opaque",
            envelope: r.envelope,
          },
        };
      if (path.endsWith("/history")) return { items: [] };
      if (path.includes("/history/")) return structuredClone(r);
      return status();
    },
    () => {},
    () => now,
  );
  return {
    c,
    calls,
    review,
    hold: (s: string) => (hold = s),
    release: (v: any) => resolve(v),
    reject: () => reject(Error("private detail")),
    time: (n: number) => (now += n),
    record: (v: any) => (r = v),
  };
}

test("exact local review is consumed once; uncertainty disables send and receipt checks never retry", async () => {
  const f = fixture(),
    c = f.c;
  await c.refresh();
  await c.load(id);
  await c.reviewSend();
  c.setConfirmed(true);
  await c.confirm();
  assert.match(c.error, /unconfirmed/);
  assert.equal(c.unconfirmed(), true);
  assert.equal(c.canSend(), false);
  assert.equal(c.review, null);
  await c.confirm();
  await c.reviewSend();
  await c.reconcile();
  assert.equal(f.calls.filter((v) => v.path.endsWith("/confirm")).length, 1);
  assert.equal(f.calls.filter((v) => v.path.endsWith("/review")).length, 1);
  assert.equal(f.calls.at(-1)?.path, "/v1/connections/mail-send/reconcile");
});

test("focus, expiry and changed content invalidate review; a late review is cancelled by its own ID", async () => {
  for (const mode of ["hide", "expiry", "edit"]) {
    const f = fixture(),
      c = f.c;
    await c.refresh();
    await c.load(id);
    await c.reviewSend();
    c.setConfirmed(true);
    if (mode === "hide") c.hide();
    if (mode === "expiry") {
      f.time(120001);
      c.expire();
    }
    if (mode === "edit") c.edit("subject", "changed");
    await c.confirm();
    assert.equal(
      f.calls.some((v) => v.path.endsWith("/confirm")),
      false,
    );
    assert.equal(c.review, null);
  }
  const f = fixture();
  await f.c.refresh();
  await f.c.load(id);
  f.hold("review");
  const p = f.c.reviewSend();
  f.c.hide();
  f.release(f.review());
  await p;
  assert.equal(f.c.review, null);
  assert.equal(f.c.record, null);
  assert.deepEqual(f.calls.at(-1)?.body, { id: reviewId });
});

test("late history, saved record and submit output do not restore private views after hiding", async () => {
  for (const action of ["history", id, "confirm"]) {
    const f = fixture(),
      c = f.c;
    await c.refresh();
    await c.load(id);
    if (action === "confirm") {
      await c.reviewSend();
      c.setConfirmed(true);
    }
    f.hold(action);
    const pending =
      action === "history"
        ? c.loadHistory()
        : action === id
          ? c.load(id)
          : c.confirm();
    c.hide();
    f.release(action === "history" ? { items: [record()] } : record());
    await pending;
    assert.equal(c.history, null);
    assert.equal(c.record, null);
    assert.equal(c.notice, "");
    assert.equal(c.busy, false);
  }
});

test("restored/source-reserved/expired/wrong-operation records cannot produce a final review", async () => {
  for (const mode of ["restored", "reserved", "receipt", "expired", "other"]) {
    const f = fixture();
    await f.c.refresh();
    const r = record();
    if (mode === "restored") r.reconciliationOnly = true;
    if (mode === "reserved") r.sourceSubmission = "reserved";
    if (mode === "receipt") (r as any).receipt = { state: "uncertain" };
    if (mode === "other") r.envelope.operationId = randomUUID();
    f.record(r);
    await f.c.load(r.envelope.operationId);
    if (mode === "expired") f.time(900001);
    await f.c.reviewSend();
    assert.equal(f.c.canSend(), false);
    assert.equal(
      f.calls.some((v) => v.path.endsWith("/review")),
      false,
    );
  }
});

test("approval can finish after focus loss without restoring private file; expiry and lost results cannot reuse codes", async () => {
  const f = fixture(),
    c = f.c;
  await c.reconnect(id);
  c.setCode("a".repeat(64));
  c.hide();
  assert.equal(c.file, null);
  assert.equal(c.code, "");
  assert.equal(c.pending?.operationId, id);
  c.setCode("b".repeat(64));
  await c.finish();
  assert.equal(c.pending, null);
  assert.equal(c.code, "");
  assert.deepEqual(f.calls.find((v) => v.path.endsWith("/finish"))?.body, {
    operationId: id,
    code: "b".repeat(64),
  });
  await c.finish();
  assert.equal(f.calls.filter((v) => v.path.endsWith("/finish")).length, 1);
  await c.reconnect(id);
  c.setCode("c".repeat(64));
  f.time(600001);
  c.expire();
  await c.finish();
  assert.equal(f.calls.filter((v) => v.path.endsWith("/finish")).length, 1);
});

test("oversized attachments and late file reads preserve current draft and never prepare a send", async () => {
  const f = fixture();
  f.c.edit("text", "keep");
  await f.c.files([new File([new Uint8Array(1048577)], "oversized.bin")]);
  assert.match(f.c.error, /one MiB/);
  assert.equal(f.c.draft.text, "keep");
  assert.deepEqual(f.c.draft.attachments, []);
  let release: (v: ArrayBuffer) => void = () => {};
  const pending = f.c.files([
    {
      name: "slow.bin",
      size: 1,
      arrayBuffer: () => new Promise<ArrayBuffer>((r) => (release = r)),
    } as File,
  ]);
  f.c.hide();
  release(new Uint8Array([7]).buffer);
  await pending;
  assert.deepEqual(f.c.draft.attachments, []);
  assert.equal(f.calls.length, 0);
});

test("shipped controller and authenticated HTTP use the real durable connector through compose, approval, confirm, history and deletion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mail-ui-http-")),
    owner = { userId: "synthetic", tenantId: "personal" },
    store = new Store(join(dir, "tasks.db"), new Vault(randomBytes(32))),
    server = createServer();
  let bytes: Uint8Array | undefined,
    submits = 0;
  const secret = {
    getSecret: async () => bytes,
    setSecret: async (v: Uint8Array) => {
      bytes = v;
    },
    deleteCredential: async () => {
      bytes = undefined;
      return true;
    },
  };
  const connector = new MailSendConnector(
    JSON.stringify(owner),
    secret,
    store.mailSends.forOwner(owner),
    async (url, init) => {
      const r = store.mailSends.list(owner)[0]!,
        digest = mailSendDigest(r.envelope),
        recipientCount =
          r.envelope.to.length + r.envelope.cc.length + r.envelope.bcc.length,
        path = String(url);
      if (path.endsWith("/exchange"))
        return Response.json({
          token: "a".repeat(64),
          grantId: "b".repeat(64),
          ...r.identity,
          audience: "https://ai.bittrees.org",
          operationId: r.envelope.operationId,
          digest,
          recipientCount,
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          previouslySubmitted: false,
        });
      if (path.endsWith("/submit")) {
        submits++;
        assert.ok(r.submittedAt);
        assert.deepEqual(JSON.parse(String(init?.body)).envelope, r.envelope);
      }
      return Response.json({
        operationId: r.envelope.operationId,
        digest,
        sourceSubmission: "reserved",
        receipt: {
          contractVersion: "mail-ai-send-v1",
          operationId: r.envelope.operationId,
          digest,
          state: "partially_accepted",
          recordedAt: 1000,
          completedAt: 1001,
          recipientCount,
          accepted: [0, 2],
          refused: [1],
          historical: true,
          delivery: "unverified",
          sentCopy: "saved",
        },
      });
    },
  );
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port,
      token = "local-token-".repeat(4);
    server.on(
      "request",
      localApi({ store, owner, token, port, mailSend: connector }),
    );
    const c = new MailSendController(async (path, method = "GET", body) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error);
      return data;
    });
    await c.refresh();
    c.edit("wallet", identity.wallet);
    c.edit("from", identity.mailbox);
    c.edit("to", "one@example.org");
    c.edit("cc", "two@example.org");
    c.edit("bcc", "hidden@example.org");
    c.edit("subject", "Exact subject");
    c.edit("text", "Exact body\n");
    await c.files([new File([new Uint8Array([0, 1, 255])], "exact.bin")]);
    await c.prepare();
    assert.equal(c.error, "");
    assert.equal(c.file?.envelope.bcc[0], "hidden@example.org");
    assert.equal(c.file?.envelope.attachments[0]?.content, "AAH/");
    const operationId = c.pending!.operationId;
    c.hide();
    c.setCode("c".repeat(64));
    await c.finish();
    assert.equal(c.error, "");
    await c.load(operationId);
    await c.reviewSend();
    assert.ok(c.review);
    c.setConfirmed(true);
    await c.confirm();
    assert.equal(c.error, "");
    assert.equal(submits, 1);
    assert.equal(c.record?.receipt?.state, "partially_accepted");
    await c.reconcile();
    assert.equal(submits, 1);
    await c.loadHistory();
    assert.equal(c.history?.items.length, 1);
    await c.load(operationId);
    await c.remove();
    assert.equal(store.mailSends.list(owner).length, 1);
    c.setDelete(true);
    await c.remove();
    assert.equal(c.error, "");
    assert.equal(store.mailSends.list(owner).length, 0);
    assert.equal(bytes, undefined);
    c.dispose();
  } finally {
    connector.invalidateReview();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
