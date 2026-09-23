import test from "node:test";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { localApi } from "../apps/companion/http.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../modules/storage/store.js";
import { Vault } from "../modules/storage/vault.js";
import { encryptedBackup, restoreBackup } from "../modules/storage/backup.js";
import { MailSendConnector } from "../modules/connectors/mail-send.js";
import {
  mailSendDigest,
  mailSendReceiptSchema,
  mailSendEnvelopeSchema,
  mailSendVersion,
} from "../modules/connectors/mail-send-contracts.js";
const owner = { userId: "synthetic-owner", tenantId: "personal" },
  other = { userId: "other", tenantId: "personal" };
export function draft() {
  return {
    from: "fixture@bittrees.org",
    to: ["one@bittrees.org"],
    cc: ["two@bittrees.org"],
    bcc: ["hidden@bittrees.org"],
    subject: "EXACT_PRIVATE_SUBJECT",
    text: "Exact private body 🐦\nwith trailing spaces  ",
    attachments: [
      {
        filename: "fixture.bin",
        contentType: "application/octet-stream" as const,
        content: Buffer.from([0, 1, 255]).toString("base64"),
      },
    ],
    reply: null,
  };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mail-send-journal-")),
    path = join(dir, "tasks.db"),
    vault = new Vault(randomBytes(32)),
    identity = {
      wallet: "0x" + "1".repeat(40),
      mailbox: "fixture@bittrees.org",
    };
  let store = new Store(path, vault),
    now = Date.now(),
    credential: Uint8Array | undefined,
    grant: any,
    receipt: any = null;
  const calls: string[] = [];
  let effect: (
    path: string,
    body: any,
    result: any,
  ) => Promise<void> = async () => {};
  const secret = {
    async getSecret() {
      return credential;
    },
    async setSecret(v: Uint8Array) {
      credential = Buffer.from(v);
    },
    async deleteCredential() {
      credential = undefined;
      return true;
    },
  };
  const transport: typeof fetch = async (url, init) => {
    const action = String(url).split("/").at(-1)!;
    calls.push(action);
    assert.ok(
      String(url).startsWith(
        "https://mail.bittrees.org/api/integrations/ai-send/",
      ),
    );
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    const input = JSON.parse(String(init?.body));
    let result: any;
    if (action === "exchange") {
      assert.equal(
        createHash("sha256").update(input.verifier).digest("base64url"),
        challenge,
      );
      result = grant;
      assert.equal((init?.headers as any).Authorization, undefined);
    } else {
      assert.equal(
        (init?.headers as any).Authorization,
        "Bearer " + grant.token,
      );
      result =
        action === "disconnect"
          ? { ok: true }
          : {
              operationId: grant.operationId,
              digest: grant.digest,
              sourceSubmission: "reserved",
              receipt,
            };
    }
    await effect(action, input, result);
    return Response.json(result);
  };
  let connector = new MailSendConnector(
      JSON.stringify(owner),
      secret,
      store.mailSends.forOwner(owner),
      transport,
      () => now,
    ),
    challenge = "";
  return {
    dir,
    path,
    vault,
    identity,
    secret,
    calls,
    get store() {
      return store;
    },
    get connector() {
      return connector;
    },
    get grant() {
      return grant;
    },
    get credential() {
      return credential;
    },
    setCredential: (v: Uint8Array | undefined) => (credential = v),
    setEffect: (f: typeof effect) => (effect = f),
    time: (ms: number) => (now += ms),
    receipt: (r: any) => (receipt = r),
    async issue() {
      const p = await connector.prepare({ identity, message: draft() });
      challenge = p.reviewFile.challenge;
      grant = {
        token: "a".repeat(64),
        grantId: "b".repeat(64),
        ...identity,
        audience: "https://ai.bittrees.org",
        operationId: p.operationId,
        digest: mailSendDigest(p.reviewFile.envelope),
        recipientCount: 3,
        expiresAt: new Date(now + 900000).toISOString(),
        previouslySubmitted: false,
      };
      await connector.finish({
        operationId: p.operationId,
        code: "c".repeat(64),
      });
      return p;
    },
    accepted(id: string) {
      return {
        contractVersion: mailSendVersion,
        operationId: id,
        digest: grant.digest,
        state: "accepted",
        recordedAt: now,
        completedAt: now + 1,
        recipientCount: 3,
        accepted: [0, 1, 2],
        refused: [],
        historical: true,
        delivery: "unverified",
        sentCopy: "saved",
      };
    },
    restart() {
      connector.invalidateReview();
      store.close();
      store = new Store(path, vault);
      connector = new MailSendConnector(
        JSON.stringify(owner),
        secret,
        store.mailSends.forOwner(owner),
        transport,
        () => now,
      );
    },
    close() {
      connector.invalidateReview();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("prepared exact messages are encrypted, owner-bound and exported without a credential or pending verifier", async () => {
  const f = fixture();
  try {
    const p = await f.issue(),
      r = f.store.mailSends.read(owner, p.operationId);
    assert.deepEqual(r.envelope, p.reviewFile.envelope);
    assert.equal(r.submittedAt, null);
    assert.equal(r.reconciliationOnly, false);
    assert.equal(
      (await f.connector.status()).connection?.grantId,
      f.grant.grantId,
    );
    assert.ok(
      !JSON.stringify(await f.connector.status()).includes(f.grant.token),
    );
    assert.ok(!JSON.stringify(r).includes(f.grant.token));
    assert.ok(!Buffer.from(f.credential!).toString().includes(r.envelope.text));
    assert.equal(p.consentUrl, "https://mail.bittrees.org/connect/ai-send");
    assert.deepEqual(Object.keys(p.reviewFile).sort(), [
      "challenge",
      "envelope",
      "version",
    ]);
    assert.deepEqual(f.calls, ["exchange"]);
    const bytes = f.store.db
      .prepare("SELECT payload FROM mail_sends")
      .get() as { payload: Buffer };
    assert.ok(!bytes.payload.includes(Buffer.from(r.envelope.subject)));
    assert.throws(() => f.store.mailSends.read(other, p.operationId));
    assert.deepEqual(f.store.mailSends.list(other), []);
    const second = f.store.mailSends.create(other, {
      identity: f.identity,
      envelope: { ...r.envelope, operationId: randomUUID() },
    });
    f.store.db
      .prepare("UPDATE mail_sends SET payload=? WHERE user_id=?")
      .run(bytes.payload, other.userId);
    assert.throws(() =>
      f.store.mailSends.read(other, second.envelope.operationId),
    );
  } finally {
    f.close();
  }
});
test("one local confirmation commits before a single dispatch and repeated/restarted attempts can only reconcile", async () => {
  const f = fixture();
  try {
    const p = await f.issue();
    f.receipt(f.accepted(p.operationId));
    const review = await f.connector.prepareSend({
      operationId: p.operationId,
    });
    review.envelope.text = "caller mutation";
    f.setEffect(async (action, body) => {
      if (action === "submit") {
        assert.equal(body.envelope.text, draft().text);
        assert.ok(f.store.mailSends.read(owner, p.operationId).submittedAt);
      }
    });
    const r = await f.connector.confirm({ id: review.id, confirmed: true });
    assert.equal(r.receipt?.state, "accepted");
    await assert.rejects(
      f.connector.confirm({ id: review.id, confirmed: true }),
    );
    await assert.rejects(
      f.connector.prepareSend({ operationId: p.operationId }),
    );
    f.restart();
    await f.connector.reconcile({ operationId: p.operationId });
    assert.equal(f.calls.filter((c) => c === "submit").length, 1);
    assert.equal(f.calls.at(-1), "receipt");
  } finally {
    f.close();
  }
});
test("lost submit response or failed receipt persistence retains uncertainty and never replays", async () => {
  for (const failure of ["response", "persistence"]) {
    const f = fixture();
    try {
      const p = await f.issue();
      f.receipt(f.accepted(p.operationId));
      const r = await f.connector.prepareSend({ operationId: p.operationId });
      if (failure === "response")
        f.setEffect(async (action) => {
          if (action === "submit") throw Error("private transport detail");
        });
      else
        f.store.mailSends.observe = () => {
          throw Error("private database detail");
        };
      await assert.rejects(
        f.connector.confirm({ id: r.id, confirmed: true }),
        (e: any) =>
          e.code === "MAIL_SEND_UNCONFIRMED" && !e.message.includes("private"),
      );
      assert.ok(f.store.mailSends.read(owner, p.operationId).submittedAt);
      assert.equal(f.store.mailSends.read(owner, p.operationId).receipt, null);
      f.setEffect(async () => {});
      f.restart();
      assert.equal(
        (await f.connector.reconcile({ operationId: p.operationId })).receipt
          ?.state,
        "accepted",
      );
      assert.equal(f.calls.filter((c) => c === "submit").length, 1);
    } finally {
      f.close();
    }
  }
});
test("a committed reservation with lost acknowledgement prevents all external dispatch", async () => {
  const f = fixture();
  try {
    const p = await f.issue(),
      r = await f.connector.prepareSend({ operationId: p.operationId }),
      reserve = f.store.mailSends.reserve.bind(f.store.mailSends);
    f.store.mailSends.reserve = (...args) => {
      reserve(...args);
      throw Error("commit acknowledgement lost");
    };
    await assert.rejects(f.connector.confirm({ id: r.id, confirmed: true }));
    assert.ok(f.store.mailSends.read(owner, p.operationId).submittedAt);
    assert.equal(f.calls.includes("submit"), false);
    f.restart();
    await assert.rejects(
      f.connector.prepareSend({ operationId: p.operationId }),
    );
    assert.equal(f.calls.includes("submit"), false);
  } finally {
    f.close();
  }
});
test("expired, cancelled or changed credential reviews cannot submit", async () => {
  for (const mode of ["expired", "cancel", "credential"]) {
    const f = fixture();
    try {
      const p = await f.issue(),
        r = await f.connector.prepareSend({ operationId: p.operationId });
      if (mode === "expired") f.time(120001);
      if (mode === "cancel") f.connector.cancelReview({ id: r.id });
      if (mode === "credential") {
        const saved = JSON.parse(Buffer.from(f.credential!).toString());
        saved.grant.grantId = "f".repeat(64);
        f.setCredential(Buffer.from(JSON.stringify(saved)));
      }
      await assert.rejects(f.connector.confirm({ id: r.id, confirmed: true }));
      assert.equal(f.calls.includes("submit"), false);
      assert.equal(
        f.store.mailSends.read(owner, p.operationId).submittedAt,
        null,
      );
    } finally {
      f.close();
    }
  }
});
test("source-reserved grants and restored prepared records never become permission to send", async () => {
  const f = fixture();
  let restored: Store | undefined;
  try {
    const p = await f.issue();
    await encryptedBackup(f.store, f.vault, join(f.dir, "prepared.aib"));
    await restoreBackup(
      join(f.dir, "prepared.aib"),
      f.vault,
      join(f.dir, "restored.db"),
    );
    restored = new Store(join(f.dir, "restored.db"), f.vault);
    const record = restored.mailSends.read(owner, p.operationId);
    assert.equal(record.reconciliationOnly, true);
    assert.equal(record.submittedAt, null);
    const c = new MailSendConnector(
      JSON.stringify(owner),
      f.secret,
      restored.mailSends.forOwner(owner),
      async () => {
        throw Error("no network expected");
      },
    );
    await assert.rejects(c.prepareSend({ operationId: p.operationId }));
    assert.throws(() =>
      restored!.mailSends.reserve(owner, p.operationId, {
        grantId: f.grant.grantId,
        digest: f.grant.digest,
        confirmed: true,
      }),
    );
    // Use the real exchange shape with the regenerated verifier in a separate transport.
    const c2 = new MailSendConnector(
      JSON.stringify(owner),
      f.secret,
      f.store.mailSends.forOwner(owner),
      async () => Response.json({ ...f.grant, previouslySubmitted: true }),
    );
    const connect = await c2.reconnect({ operationId: p.operationId });
    await c2.finish({ operationId: connect.operationId, code: "c".repeat(64) });
    await assert.rejects(c2.prepareSend({ operationId: p.operationId }));
    assert.equal(
      f.store.mailSends.read(owner, p.operationId).sourceSubmission,
      "reserved",
    );
  } finally {
    restored?.close();
    f.close();
  }
});
test("receipts bind exact operations, advance from uncertainty and cannot erase known acceptance", async () => {
  const f = fixture();
  try {
    const p = await f.issue(),
      known = f.accepted(p.operationId),
      base = {
        operationId: p.operationId,
        digest: f.grant.digest,
        sourceSubmission: "reserved" as const,
      };
    const unknown = {
      ...known,
      state: "uncertain",
      accepted: [],
      completedAt: null,
      sentCopy: "not_attempted",
    };
    f.store.mailSends.observe(owner, p.operationId, {
      ...base,
      receipt: unknown,
    });
    f.store.mailSends.observe(owner, p.operationId, {
      ...base,
      receipt: { ...known, sentCopy: "unverified" },
    });
    f.store.mailSends.observe(owner, p.operationId, {
      ...base,
      receipt: known,
    });
    assert.deepEqual(
      f.store.mailSends.observe(owner, p.operationId, {
        ...base,
        receipt: null,
      }).receipt,
      known,
    );
    assert.deepEqual(
      f.store.mailSends.observe(owner, p.operationId, {
        ...base,
        receipt: unknown,
      }).receipt,
      known,
    );
    for (const change of [
      { operationId: randomUUID() },
      { digest: "f".repeat(64) },
      { recordedAt: known.recordedAt + 1 },
      {
        state: "rejected",
        accepted: [],
        refused: [0, 1, 2],
        sentCopy: "not_attempted",
      },
      { sentCopy: "unavailable" },
    ])
      assert.throws(() =>
        f.store.mailSends.observe(owner, p.operationId, {
          ...base,
          receipt: { ...known, ...change },
        }),
      );
    assert.equal(
      mailSendReceiptSchema.safeParse({ ...known, delivery: "delivered" })
        .success,
      false,
    );
    assert.equal(
      mailSendReceiptSchema.safeParse({ ...known, accepted: [0, 1, 1] })
        .success,
      false,
    );
  } finally {
    f.close();
  }
});
test("disconnect persists suspension across response loss; deletion requires explicit acknowledgement and is owner-scoped", async () => {
  const f = fixture();
  try {
    const p = await f.issue();
    f.setEffect(async (action) => {
      if (action === "disconnect") throw Error("lost");
    });
    await assert.rejects(f.connector.disconnect());
    f.restart();
    assert.equal(
      (await f.connector.status()).connection?.state,
      "disconnect_pending",
    );
    await assert.rejects(
      f.connector.prepareSend({ operationId: p.operationId }),
    );
    f.setEffect(async () => {});
    await f.connector.disconnect();
    assert.equal((await f.connector.status()).connection, null);
    assert.equal(f.store.mailSends.list(owner).length, 1);
    await assert.rejects(
      f.connector.remove({ operationId: p.operationId, confirmed: true }),
    );
    const otherRecord = f.store.mailSends.create(other, {
      identity: f.identity,
      envelope: { ...p.reviewFile.envelope, operationId: randomUUID() },
    });
    assert.deepEqual(
      await f.connector.remove({
        operationId: p.operationId,
        confirmed: true,
        forgetSendTracking: true,
      }),
      { removed: true, sourceCancelled: false, sourceRevoked: false },
    );
    assert.deepEqual(f.store.mailSends.list(owner), []);
    assert.equal(
      f.store.mailSends.read(other, otherRecord.envelope.operationId).envelope
        .operationId,
      otherRecord.envelope.operationId,
    );
  } finally {
    f.close();
  }
});
test("contract accepts exact empty files and Unicode, rejecting normalization, extra authority and dropped groups", () => {
  const envelope = {
    contractVersion: mailSendVersion,
    operationId: randomUUID(),
    ...draft(),
  };
  assert.ok(
    mailSendEnvelopeSchema.safeParse({
      ...envelope,
      attachments: [
        {
          filename: "empty.bin",
          contentType: "application/octet-stream",
          content: "",
        },
      ],
    }).success,
  );
  for (const change of [
    { approved: true },
    { cc: undefined },
    { to: ["Name <x@example.org>"] },
    { subject: "\ud800" },
    { text: "\ufeff" },
    {
      attachments: [
        { filename: "x", contentType: "text/html", content: "eA==" },
      ],
    },
    { cc: [envelope.to[0]!] },
    { bcc: ["\nbcc@example.org"] },
  ])
    assert.equal(
      mailSendEnvelopeSchema.safeParse({ ...envelope, ...change }).success,
      false,
    );
});

test("authenticated local HTTP confines attachment limits, exports only owner records, and fences deletion during dispatch", async () => {
  const f = fixture(),
    server = createServer(),
    token = "test-local-token-".repeat(4);
  let release: () => void = () => {};
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    server.on(
      "request",
      localApi({ store: f.store, owner, token, port, mailSend: f.connector }),
    );
    const call = (
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
      method = body === undefined ? "GET" : "POST",
    ) =>
      fetch(`http://127.0.0.1:${port}/v1/${path}`, {
        method,
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const prefix = "connections/mail-send/",
      message = {
        ...draft(),
        attachments: [
          {
            filename: "full.bin",
            contentType: "application/octet-stream",
            content: Buffer.alloc(1048576, 7).toString("base64"),
          },
        ],
      };
    const input = { identity: f.identity, message };
    assert.equal(
      (await call(prefix + "prepare", input, { Authorization: "" })).status,
      401,
    );
    assert.equal(
      (
        await call(prefix + "prepare", input, {
          Origin: "https://attacker.example",
        })
      ).status,
      403,
    );
    assert.equal((await call(prefix + "finish", input)).status, 413);
    const prepared = await call(prefix + "prepare", input);
    assert.equal(prepared.status, 200);
    const data: any = await prepared.json();
    assert.equal(
      data.reviewFile.envelope.attachments[0].content,
      message.attachments[0]!.content,
    );
    assert.equal(JSON.stringify(data).includes("verifier"), false);
    assert.equal(f.calls.length, 0);
    assert.equal(
      (
        await call(prefix + "prepare", {
          ...input,
          padding: "x".repeat(1500000),
        })
      ).status,
      413,
    );
    assert.equal(
      (
        await call(prefix + "delete", {
          operationId: data.operationId,
          confirmed: true,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call(prefix + "delete", {
          operationId: data.operationId,
          confirmed: true,
          forgetSendTracking: true,
        })
      ).status,
      200,
    );
    const p = await f.issue();
    f.store.mailSends.create(other, {
      identity: f.identity,
      envelope: { ...p.reviewFile.envelope, operationId: randomUUID() },
    });
    const exported: any = await (await call("export")).json();
    assert.equal(exported.mailSends.length, 1);
    assert.equal(exported.mailSends[0].envelope.operationId, p.operationId);
    assert.ok(!JSON.stringify(exported).includes(f.grant.token));
    const reviewed: any = await (
      await call(prefix + "review", { operationId: p.operationId })
    ).json();
    let started: () => void = () => {};
    const start = new Promise<void>((r) => (started = r)),
      hold = new Promise<void>((r) => (release = r));
    f.receipt(f.accepted(p.operationId));
    f.setEffect(async (action) => {
      if (action === "submit") {
        started();
        await hold;
      }
    });
    const confirming = call(prefix + "confirm", {
      id: reviewed.id,
      confirmed: true,
    });
    await start;
    assert.equal(
      (
        await call(
          "data",
          undefined,
          { "X-Confirm-Delete": "all-local-task-data" },
          "DELETE",
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await call(prefix + "delete", {
          operationId: p.operationId,
          confirmed: true,
          forgetSendTracking: true,
        })
      ).status,
      400,
    );
    release();
    assert.equal((await confirming).status, 200);
    assert.equal(f.calls.filter((c) => c === "submit").length, 1);
    assert.equal(
      (
        await call(
          "data",
          undefined,
          { "X-Confirm-Delete": "all-local-task-data" },
          "DELETE",
        )
      ).status,
      204,
    );
    assert.deepEqual(f.store.mailSends.list(owner), []);
    assert.equal(f.store.mailSends.list(other).length, 1);
    assert.equal(
      (await call(prefix + "confirm", { id: reviewed.id, confirmed: true }))
        .status,
      400,
    );
  } finally {
    release();
    await new Promise<void>((r) => server.close(() => r()));
    f.close();
  }
});

test("local whole-data deletion invalidates a held unsent review", async () => {
  const f = fixture(),
    server = createServer(),
    token = "test-local-token-".repeat(4);
  try {
    const p = await f.issue(),
      review = await f.connector.prepareSend({ operationId: p.operationId });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    server.on(
      "request",
      localApi({ store: f.store, owner, token, port, mailSend: f.connector }),
    );
    const result = await fetch(`http://127.0.0.1:${port}/v1/data`, {
      method: "DELETE",
      headers: {
        Authorization: "Bearer " + token,
        "X-Confirm-Delete": "all-local-task-data",
      },
    });
    assert.equal(result.status, 204);
    await assert.rejects(
      f.connector.confirm({ id: review.id, confirmed: true }),
      /REVIEW_EXPIRED/,
    );
    assert.equal(f.calls.includes("submit"), false);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    f.close();
  }
});

test("journal refuses unsafe durability settings, bounded capacity and enclosing transactions", async () => {
  const f = fixture();
  try {
    const p = await f.issue(),
      input = {
        digest: f.grant.digest,
        grantId: f.grant.grantId,
        confirmed: true,
      };
    f.store.db.pragma("synchronous=NORMAL");
    assert.throws(() => f.store.mailSends.reserve(owner, p.operationId, input));
    f.store.db.pragma("synchronous=FULL");
    assert.throws(() =>
      f.store.db.transaction(() =>
        f.store.mailSends.reserve(owner, p.operationId, input),
      )(),
    );
    assert.equal(
      f.store.mailSends.read(owner, p.operationId).submittedAt,
      null,
    );
    for (let i = 1; i < 100; i++)
      f.store.mailSends.create(owner, {
        identity: f.identity,
        envelope: { ...p.reviewFile.envelope, operationId: randomUUID() },
      });
    assert.throws(
      () =>
        f.store.mailSends.create(other, {
          identity: f.identity,
          envelope: { ...p.reviewFile.envelope, operationId: randomUUID() },
        }),
      /CAPACITY/,
    );
    assert.equal(f.store.mailSends.list(owner).length, 100);
  } finally {
    f.close();
  }
});

test("committed Mail reservation survives abrupt process exit before dispatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "mail-crash-")),
    path = join(dir, "tasks.db"),
    key = randomBytes(32),
    operationId = randomUUID(),
    identity = {
      wallet: "0x" + "1".repeat(40),
      mailbox: "fixture@bittrees.org",
    },
    envelope = { contractVersion: mailSendVersion, operationId, ...draft() };
  let store: Store | undefined;
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
 import {Store} from './modules/storage/store.ts';import {Vault} from './modules/storage/vault.ts';import {mailSendDigest} from './modules/connectors/mail-send-contracts.ts';
 let input='';for await(const part of process.stdin)input+=part;const x=JSON.parse(input),s=new Store(x.path,new Vault(Buffer.from(x.key,'hex')));s.mailSends.create(x.owner,{identity:x.identity,envelope:x.envelope});s.mailSends.reserve(x.owner,x.envelope.operationId,{digest:mailSendDigest(x.envelope),grantId:'b'.repeat(64),confirmed:true});process.exit(0);
 `,
      ],
      {
        input: JSON.stringify({
          path,
          key: key.toString("hex"),
          owner,
          identity,
          envelope,
        }),
        encoding: "utf8",
      },
    );
    assert.equal(child.status, 0, child.stderr);
    store = new Store(path, new Vault(key));
    assert.ok(store.mailSends.read(owner, operationId).submittedAt);
    assert.throws(() =>
      store!.mailSends.reserve(owner, operationId, {
        digest: mailSendDigest(envelope),
        grantId: "b".repeat(64),
        confirmed: true,
      }),
    );
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mismatched exchange authority never becomes a saved credential or a send permission", async () => {
  for (const change of [
    { audience: "https://chat.bittrees.org" },
    { wallet: "0x" + "2".repeat(40) },
    { mailbox: "other@bittrees.org" },
    { operationId: randomUUID() },
    { digest: "f".repeat(64) },
    { recipientCount: 2 },
    { expiresAt: "2000-01-01T00:00:00.000Z" },
    { expiresAt: "2100-01-01T00:00:00.000Z" },
    { sendAll: true },
  ]) {
    const f = fixture();
    try {
      f.setEffect(async (action, _input, result) => {
        if (action === "exchange") Object.assign(result, change);
      });
      await assert.rejects(f.issue(), /INVALID_SOURCE/);
      assert.equal(f.credential, undefined);
      assert.deepEqual(f.calls, ["exchange"]);
      const record = f.store.mailSends.list(owner)[0]!;
      assert.equal(record.submittedAt, null);
      await assert.rejects(
        f.connector.finish({
          operationId: record.envelope.operationId,
          code: "c".repeat(64),
        }),
        /INVALID_CONNECTION/,
      );
      assert.deepEqual(f.calls, ["exchange"]);
    } finally {
      f.close();
    }
  }
});
