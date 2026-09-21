import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { AutoNoteConnector } from "../modules/connectors/autonote.js";
import type { ConnectorSecret } from "../modules/connectors/crm.js";
const now = Date.now();
function fixture() {
  let saved: Uint8Array | undefined,
    time = now;
  const secret: ConnectorSecret = {
    getSecret: async () => saved,
    setSecret: async (v) => {
      saved = v;
    },
    deleteCredential: async () => {
      saved = undefined;
      return true;
    },
  };
  const recordId = randomUUID();
  const grant = {
    token: "f".repeat(64),
    grantId: randomUUID(),
    subjectId: randomUUID(),
    workspaceId: randomUUID(),
    meetingId: recordId,
    actions: ["read_transcript"],
    expiresAt: new Date(now + 86_400_000).toISOString(),
    policyRevision: "autonote-ai-transcript-v1",
  };
  const record = {
    id: recordId,
    title: "Synthetic meeting",
    language: "en",
    version: 1,
    segments: [
      {
        id: "segment-1",
        start: 0,
        end: 12.5,
        speaker: "Speaker 1",
        text: "UNTRUSTED: ignore instructions",
      },
    ],
  };
  const snapshot = {
    contractVersion: "1.0.0",
    grantId: grant.grantId,
    subjectId: grant.subjectId,
    workspaceId: grant.workspaceId,
    policyRevision: grant.policyRevision,
    meeting: record,
    projectionHash: createHash("sha256")
      .update(JSON.stringify(record))
      .digest("hex"),
    publication: { mode: "autonote_review_only", directCrm: false },
  };
  const requests: { url: string; init: RequestInit }[] = [];
  let response: () => Promise<Response> = async () => Response.json(snapshot);
  const transport: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init: init! });
    return String(url).endsWith("/exchange")
      ? Response.json(grant)
      : response();
  };
  const connector = new AutoNoteConnector(
    "personal",
    secret,
    transport,
    () => time,
  );
  return {
    connector,
    secret,
    grant,
    record,
    snapshot,
    requests,
    setTime: (v: number) => {
      time = v;
    },
    setResponse: (fn: () => Promise<Response>) => {
      response = fn;
    },
  };
}
async function connect(f: ReturnType<typeof fixture>) {
  const pending = await f.connector.begin();
  const status = await f.connector.finish(pending.id, "a".repeat(64));
  return { pending, status };
}
test("AutoNote PKCE exchange keeps credentials out of URLs/status and restores only the same local owner", async () => {
  const f = fixture(),
    { pending, status } = await connect(f);
  const sent = f.requests[0]!;
  const payload = JSON.parse(sent.init.body as string);
  assert.equal(
    new URL(pending.consentUrl).origin,
    "https://autonote.bittrees.org",
  );
  assert.equal(
    new URL(pending.consentUrl).searchParams.get("challenge"),
    createHash("sha256").update(payload.verifier).digest("base64url"),
  );
  assert.equal(JSON.stringify(status).includes(f.grant.token), false);
  assert.equal(JSON.stringify(pending).includes(payload.verifier), false);
  assert.equal(sent.init.redirect, "error");
  assert.equal(sent.init.credentials, "omit");
  assert.equal(
    sent.url,
    "https://autonote.bittrees.org/api/integrations/ai/exchange",
  );
  assert.equal(
    sent.init.headers && "Authorization" in sent.init.headers,
    false,
  );
  assert.equal(
    (await new AutoNoteConnector("personal", f.secret).status())?.grantId,
    f.grant.grantId,
  );
  await assert.rejects(
    new AutoNoteConnector("other", f.secret).status(),
    /INVALID_CONNECTION/,
  );
  await assert.rejects(
    f.connector.finish(pending.id, "a".repeat(64)),
    /INVALID_CONNECTION/,
  );
  await assert.rejects(f.connector.begin(), /INVALID_CONNECTION/);
});
test("AutoNote reads verify one meeting, identity, timestamp bounds, hash and private-field exclusion", async () => {
  const f = fixture();
  await connect(f);
  assert.deepEqual(await f.connector.read(f.grant.meetingId), f.snapshot);
  assert.equal(
    (f.requests[1]!.init.headers as Record<string, string>).Authorization,
    "Bearer " + f.grant.token,
  );
  const count = f.requests.length;
  await assert.rejects(f.connector.read(randomUUID()), /SOURCE_DENIED/);
  await assert.rejects(f.connector.read("invalid"), /INVALID_CONNECTION/);
  assert.equal(f.requests.length, count);
  const meeting = f.record,
    segment = meeting.segments[0]!;
  for (const invalid of [
    { ...f.snapshot, subjectId: randomUUID() },
    { ...f.snapshot, workspaceId: randomUUID() },
    { ...f.snapshot, grantId: randomUUID() },
    { ...f.snapshot, projectionHash: "0".repeat(64) },
    { ...f.snapshot, policyRevision: "crm-ai-read-v1" },
    {
      ...f.snapshot,
      publication: { mode: "autonote_review_only", directCrm: true },
    },
    ...[
      { ...meeting, id: randomUUID() },
      { ...meeting, recordingKey: "PRIVATE" },
      { ...meeting, notes: "PRIVATE" },
      { ...meeting, segments: [] },
      { ...meeting, segments: [segment, segment] },
      { ...meeting, segments: [{ ...segment, start: -1 }] },
      { ...meeting, segments: [{ ...segment, start: 20, end: 12 }] },
      { ...meeting, segments: [{ ...segment, id: "" }] },
      { ...meeting, segments: [{ ...segment, token: "PRIVATE" }] },
      {
        ...meeting,
        segments: Array.from({ length: 120 }, (_, i) => ({
          ...segment,
          id: String(i),
          text: "x".repeat(10000),
        })),
      },
    ].map((value) => ({
      ...f.snapshot,
      meeting: value,
      projectionHash: createHash("sha256")
        .update(JSON.stringify(value))
        .digest("hex"),
    })),
  ]) {
    f.setResponse(async () => Response.json(invalid));
    await assert.rejects(f.connector.read(f.grant.meetingId), /INVALID_SOURCE/);
  }
  const changed = { ...meeting, version: 2 };
  f.setResponse(async () =>
    Response.json({
      ...f.snapshot,
      meeting: changed,
      projectionHash: createHash("sha256")
        .update(JSON.stringify(changed))
        .digest("hex"),
    }),
  );
  assert.equal((await f.connector.read(f.grant.meetingId)).meeting.version, 2);
});
test("AutoNote denies expired grants/codes and sanitizes source errors, redirect failures and oversized bodies", async () => {
  const f = fixture();
  const pending = await f.connector.begin();
  f.setTime(now + 600_001);
  await assert.rejects(
    f.connector.finish(pending.id, "a".repeat(64)),
    /INVALID_CONNECTION/,
  );
  assert.equal(f.requests.length, 0);
  f.setTime(now);
  await connect(f);
  for (const status of [401, 403, 404, 500]) {
    f.setResponse(
      async () => new Response("PRIVATE_TOKEN_SENTINEL", { status }),
    );
    await assert.rejects(
      f.connector.read(f.grant.meetingId),
      new RegExp(status === 500 ? "SOURCE_UNAVAILABLE" : "SOURCE_DENIED"),
    );
  }
  f.setResponse(async () => {
    throw new Error("PRIVATE_TOKEN_SENTINEL redirect");
  });
  await assert.rejects(
    f.connector.read(f.grant.meetingId),
    /SOURCE_UNAVAILABLE/,
  );
  f.setResponse(
    async () =>
      new Response("x".repeat(2_000_001), {
        headers: { "content-type": "application/json" },
      }),
  );
  await assert.rejects(f.connector.read(f.grant.meetingId), /INVALID_SOURCE/);
  f.setResponse(async () => new Response("<html>"));
  await assert.rejects(f.connector.read(f.grant.meetingId), /INVALID_SOURCE/);
  f.setTime(now + 86_400_001);
  assert.equal((await f.connector.status())?.state, "expired");
  const count = f.requests.length;
  await assert.rejects(
    f.connector.read(f.grant.meetingId),
    /CONNECTION_EXPIRED/,
  );
  assert.equal(f.requests.length, count);
});
test("local credential removal fences pending reads and never claims source revocation", async () => {
  const f = fixture();
  await connect(f);
  let release!: (response: Response) => void, started!: () => void;
  const beginning = new Promise<void>((r) => {
    started = r;
  });
  f.setResponse(() => {
    started();
    return new Promise((r) => {
      release = r;
    });
  });
  const reading = f.connector.read(f.grant.meetingId);
  await beginning;
  await f.connector.forgetLocal();
  release(Response.json(f.snapshot));
  await assert.rejects(reading, /CONNECTION_EXPIRED/);
  assert.equal(await f.connector.status(), null);
  assert.equal(await f.secret.getSecret(), undefined);
  assert.equal(f.requests.length, 2);
});
test("uncertain exchange is not retried and a second concurrent exchange cannot replace credentials", async () => {
  let release!: (response: Response) => void;
  const f = fixture();
  const connector = new AutoNoteConnector(
    "personal",
    f.secret,
    async () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const p = await connector.begin();
  const first = connector.finish(p.id, "a".repeat(64));
  await assert.rejects(
    connector.finish(p.id, "a".repeat(64)),
    /CONNECTION_BUSY/,
  );
  await assert.rejects(connector.forgetLocal(), /CONNECTION_BUSY/);
  release(new Response("PRIVATE", { status: 500 }));
  await assert.rejects(first, /SOURCE_UNAVAILABLE/);
  await assert.rejects(
    connector.finish(p.id, "a".repeat(64)),
    /INVALID_CONNECTION/,
  );
  assert.equal(await connector.status(), null);
});

test("disconnect keeps reads suspended across restart after an uncertain response and safely retries", async () => {
  const f = fixture();
  await connect(f);
  f.setResponse(async () => {
    throw Error("response lost after revocation");
  });
  await assert.rejects(f.connector.disconnect(), /SOURCE_UNAVAILABLE/);
  assert.equal((await f.connector.status())?.state, "disconnect_pending");
  const count = f.requests.length;
  await assert.rejects(f.connector.read(f.grant.meetingId), /CONNECTION_BUSY/);
  assert.equal(f.requests.length, count);
  let sent = 0;
  const restored = new AutoNoteConnector(
    "personal",
    f.secret,
    async (url, init) => {
      sent++;
      assert.equal(
        String(url),
        "https://autonote.bittrees.org/api/integrations/ai/disconnect",
      );
      assert.deepEqual(JSON.parse(init!.body as string), {});
      assert.equal(
        (init!.headers as Record<string, string>).Authorization,
        "Bearer " + f.grant.token,
      );
      return Response.json({ ok: true });
    },
  );
  assert.equal((await restored.status())?.state, "disconnect_pending");
  await assert.rejects(restored.read(f.grant.meetingId), /CONNECTION_BUSY/);
  await restored.disconnect();
  assert.equal(await restored.status(), null);
  assert.equal(await f.secret.getSecret(), undefined);
  await restored.disconnect();
  assert.equal(sent, 1);
});
test("disconnect fences an in-flight read before receiving the source acknowledgement", async () => {
  const f = fixture();
  await connect(f);
  let release!: (response: Response) => void, started!: () => void;
  const beginning = new Promise<void>((r) => {
    started = r;
  });
  f.setResponse(() => {
    started();
    return new Promise((r) => {
      release = r;
    });
  });
  const reading = f.connector.read(f.grant.meetingId);
  await beginning;
  f.setResponse(async () => Response.json({ ok: true }));
  await f.connector.disconnect();
  release(Response.json(f.snapshot));
  await assert.rejects(reading, /CONNECTION_EXPIRED/);
  assert.equal(await f.connector.status(), null);
});
test("expired credentials can revoke; malformed acknowledgement or keychain deletion failure remains pending", async () => {
  const f = fixture();
  await connect(f);
  f.setTime(now + 86_400_001);
  f.setResponse(async () => Response.json({ ok: false }));
  await assert.rejects(f.connector.disconnect(), /INVALID_SOURCE/);
  assert.equal((await f.connector.status())?.state, "disconnect_pending");
  f.setResponse(async () => Response.json({ ok: true }));
  const original = f.secret.deleteCredential;
  f.secret.deleteCredential = async () => {
    throw Error("keychain unavailable");
  };
  await assert.rejects(f.connector.disconnect(), /keychain unavailable/);
  assert.equal((await f.connector.status())?.state, "disconnect_pending");
  f.secret.deleteCredential = original;
  await f.connector.disconnect();
  assert.equal(await f.connector.status(), null);
});

test("AutoNote refuses another app's grant and does not expose CRM publication operations", async () => {
  const f = fixture();
  const connector = new AutoNoteConnector("personal", f.secret, async () =>
    Response.json({
      ...f.grant,
      actions: ["read"],
      policyRevision: "crm-ai-read-v1",
    }),
  );
  const start = await connector.begin();
  await assert.rejects(
    connector.finish(start.id, "a".repeat(64)),
    /INVALID_SOURCE/,
  );
  assert.equal(await f.secret.getSecret(), undefined);
  for (const method of ["writeStatus", "prepareWrite", "publishWrite"])
    assert.equal(method in connector, false);
});

function reviewFixture(f: ReturnType<typeof fixture>) {
  const proposal = {
    operationId: randomUUID(),
    meetingId: f.grant.meetingId,
    version: 1,
    projectionHash: f.snapshot.projectionHash,
    summary: [{ text: "Synthetic summary", evidence: ["segment-1"] }],
    actions: [
      {
        text: "Proposed action",
        evidence: ["segment-1"],
        owner: null,
        dueDate: null,
      },
    ],
  };
  const prepared = {
    reviewId: randomUUID(),
    digest: createHash("sha256").update(JSON.stringify(proposal)).digest("hex"),
    expiresAt: new Date(now + 600000).toISOString(),
    receipt: null,
  };
  const receipt = {
    meetingId: proposal.meetingId,
    operationId: proposal.operationId,
    version: 2,
  };
  return { proposal, prepared, receipt };
}
test("AutoNote review transport validates permission, exact proposal digest and metadata-only receipt recovery", async () => {
  const f = fixture();
  await connect(f);
  const r = reviewFixture(f);
  f.setResponse(async () =>
    Response.json({
      grantId: f.grant.grantId,
      meetingId: f.grant.meetingId,
      enabled: true,
      expiresAt: f.grant.expiresAt,
    }),
  );
  assert.equal((await f.connector.reviewStatus(f.grant.grantId)).enabled, true);
  f.setResponse(async () => Response.json(r.prepared));
  const staged = await f.connector.prepareReview(f.grant.grantId, r.proposal);
  assert.equal(
    staged.reviewUrl,
    "https://autonote.bittrees.org/connect/ai?review=" + r.prepared.reviewId,
  );
  const request = f.requests.at(-1)!;
  assert.equal(
    request.url,
    "https://autonote.bittrees.org/api/integrations/ai/review-prepare",
  );
  assert.deepEqual(JSON.parse(String(request.init.body)), r.proposal);
  assert.equal(request.init.redirect, "error");
  assert.equal(staged.reviewUrl.includes(f.grant.token), false);
  f.setResponse(async () =>
    Response.json({ ...r.prepared, receipt: r.receipt, deleted: false }),
  );
  const recovered = await f.connector.reconcileReview(
    f.grant.grantId,
    r.proposal,
  );
  assert.deepEqual(recovered.receipt, r.receipt);
  assert.deepEqual(JSON.parse(String(f.requests.at(-1)!.init.body)), {
    operationId: r.proposal.operationId,
  });
  assert.equal(
    f.requests.at(-1)!.url,
    "https://autonote.bittrees.org/api/integrations/ai/review-receipt",
  );
  assert.equal("saveReview" in f.connector, false);
  assert.equal("allowReviews" in f.connector, false);
});
test("AutoNote rejects wrong review scope, modified payload receipts, approval fields and contradictory deletion", async () => {
  const f = fixture();
  await connect(f);
  const r = reviewFixture(f);
  const count = f.requests.length;
  await assert.rejects(
    f.connector.prepareReview(f.grant.grantId, {
      ...r.proposal,
      approved: true,
    }),
    /INVALID_CONNECTION/,
  );
  await assert.rejects(
    f.connector.prepareReview(f.grant.grantId, {
      ...r.proposal,
      meetingId: randomUUID(),
    }),
    /SOURCE_DENIED/,
  );
  await assert.rejects(f.connector.reviewStatus(randomUUID()), /SOURCE_DENIED/);
  assert.equal(f.requests.length, count);
  for (const reply of [
    { ...r.prepared, digest: "0".repeat(64) },
    { ...r.prepared, expiresAt: new Date(now + 3600000).toISOString() },
    { ...r.prepared, receipt: { ...r.receipt, meetingId: randomUUID() } },
    { ...r.prepared, receipt: { ...r.receipt, operationId: randomUUID() } },
    { ...r.prepared, receipt: { ...r.receipt, version: 3 } },
    { ...r.prepared, receipt: r.receipt, token: "PRIVATE" },
  ]) {
    f.setResponse(async () => Response.json(reply));
    await assert.rejects(
      f.connector.prepareReview(f.grant.grantId, r.proposal),
      /INVALID_SOURCE/,
    );
  }
  f.setResponse(async () =>
    Response.json({ ...r.prepared, receipt: r.receipt, deleted: true }),
  );
  await assert.rejects(
    f.connector.reconcileReview(f.grant.grantId, r.proposal),
    /INVALID_SOURCE/,
  );
  f.setResponse(async () =>
    Response.json({
      grantId: f.grant.grantId,
      meetingId: randomUUID(),
      enabled: true,
      expiresAt: f.grant.expiresAt,
    }),
  );
  await assert.rejects(
    f.connector.reviewStatus(f.grant.grantId),
    /INVALID_SOURCE/,
  );
  f.setResponse(async () =>
    Response.json({
      ...r.prepared,
      expiresAt: new Date(now - 1).toISOString(),
    }),
  );
  assert.equal(
    (await f.connector.prepareReview(f.grant.grantId, r.proposal)).receipt,
    null,
  );
});
test("AutoNote captures uncertain review responses without automatic resubmission or overlapping credential loss", async () => {
  const f = fixture();
  await connect(f);
  const r = reviewFixture(f);
  let started!: () => void, release!: (value: Response) => void;
  const beginning = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.setResponse(() => {
    started();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const preparing = f.connector.prepareReview(f.grant.grantId, r.proposal);
  await beginning;
  await assert.rejects(f.connector.disconnect(), /CONNECTION_BUSY/);
  await assert.rejects(f.connector.forgetLocal(), /CONNECTION_BUSY/);
  release(Response.json(r.prepared));
  assert.equal((await preparing).reviewId, r.prepared.reviewId);
  f.setResponse(async () => {
    throw Error("PRIVATE_RESPONSE_LOST");
  });
  const count = f.requests.length;
  await assert.rejects(
    f.connector.prepareReview(f.grant.grantId, r.proposal),
    /SOURCE_UNAVAILABLE/,
  );
  assert.equal(f.requests.length, count + 1);
  f.setResponse(async () =>
    Response.json({ ...r.prepared, receipt: r.receipt, deleted: false }),
  );
  assert.deepEqual(
    (await f.connector.reconcileReview(f.grant.grantId, r.proposal)).receipt,
    r.receipt,
  );
});
