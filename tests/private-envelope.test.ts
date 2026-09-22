import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  Aes256Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from "@hpke/core";
import {
  openPrivateEnvelope,
  sealPrivateEnvelope,
  privateEnvelopeSuite,
  privateEnvelopeLimit,
  PrivateEnvelopeError,
  type PrivateHeader,
} from "../modules/remote/private-envelope.js";
const now = 1_800_000_000_000;
const clock = () => now;
const bytes = (text: string) => new TextEncoder().encode(text);
const suite = () =>
  new CipherSuite({
    kem: new DhkemP256HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
  });
const keypair = () =>
  crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
const header = (): PrivateHeader => ({
  version: 1,
  suite: privateEnvelopeSuite,
  ownerId: randomUUID(),
  senderId: randomUUID(),
  recipientId: randomUUID(),
  senderKeyEpoch: 1,
  recipientKeyEpoch: 2,
  messageId: randomUUID(),
  operationId: randomUUID(),
  sequence: 1,
  issuedAt: now,
  expiresAt: now + 300000,
});
const invalid = (error: unknown) =>
  error instanceof PrivateEnvelopeError &&
  error.message === "PRIVATE_ENVELOPE_INVALID" &&
  error.cause === undefined;
const from64 = (text: string) => new Uint8Array(Buffer.from(text, "base64url"));
const to64 = (value: ArrayBuffer | Uint8Array) =>
  Buffer.from(
    value instanceof Uint8Array ? value : new Uint8Array(value),
  ).toString("base64url");
function independentAad(h: PrivateHeader) {
  return bytes(
    JSON.stringify([
      h.version,
      h.suite,
      h.ownerId,
      h.senderId,
      h.recipientId,
      h.senderKeyEpoch,
      h.recipientKeyEpoch,
      h.messageId,
      h.operationId,
      h.sequence,
      h.issuedAt,
      h.expiresAt,
    ]),
  );
}

test("Selected HPKE library suite matches the pinned RFC 9180 Auth test vector", async () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/hpke-rfc9180-auth-p256.json", import.meta.url),
      "utf8",
    ),
  );
  const v = fixture.vector,
    e = fixture.encryption,
    s = suite(),
    hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
  const senderKey = await s.kem.deriveKeyPair(hex(v.ikmS)),
    recipientKey = await s.kem.deriveKeyPair(hex(v.ikmR)),
    ephemeral = await s.kem.deriveKeyPair(hex(v.ikmE));
  assert.equal(
    to64(await s.kem.serializePublicKey(senderKey.publicKey)),
    to64(hex(v.pkSm)),
  );
  const result = await s.seal(
    {
      senderKey,
      recipientPublicKey: recipientKey.publicKey,
      info: hex(v.info),
      ekm: ephemeral,
    },
    hex(e.pt),
    hex(e.aad),
  );
  assert.deepEqual(new Uint8Array(result.enc), hex(v.enc));
  assert.deepEqual(new Uint8Array(result.ct), hex(e.ct));
  const plain = await s.open(
    {
      recipientKey,
      senderPublicKey: senderKey.publicKey,
      enc: hex(v.enc),
      info: hex(v.info),
    },
    hex(e.ct),
    hex(e.aad),
  );
  assert.deepEqual(new Uint8Array(plain), hex(e.pt));
});

test("Private envelopes interoperate with independent HPKE calls and nonextractable endpoint keys", async () => {
  const senderKey = await keypair(),
    recipientKey = await keypair(),
    h = header(),
    plain = bytes('PRIVATE_PROMPT_α😀 {"approval":"not authority"}');
  assert.equal(senderKey.privateKey.extractable, false);
  assert.equal(recipientKey.privateKey.extractable, false);
  const envelope = await sealPrivateEnvelope(
    h,
    plain,
    { senderKey, recipientPublicKey: recipientKey.publicKey },
    clock,
  );
  assert.equal(JSON.stringify(envelope).includes("PRIVATE_PROMPT"), false);
  assert.deepEqual(
    (
      await openPrivateEnvelope(
        envelope,
        h,
        { recipientKey, senderPublicKey: senderKey.publicKey },
        clock,
      )
    ).plaintext,
    plain,
  );
  const s = suite(),
    info = bytes("org.bittrees.ai/private-envelope/v1");
  assert.deepEqual(
    new Uint8Array(
      await s.open(
        {
          recipientKey,
          senderPublicKey: senderKey.publicKey,
          enc: from64(envelope.enc),
          info,
        },
        from64(envelope.ciphertext),
        independentAad(h),
      ),
    ),
    plain,
  );
  const foreign = await s.seal(
    { senderKey, recipientPublicKey: recipientKey.publicKey, info },
    plain,
    independentAad(h),
  );
  assert.deepEqual(
    (
      await openPrivateEnvelope(
        { header: h, enc: to64(foreign.enc), ciphertext: to64(foreign.ct) },
        h,
        { recipientKey, senderPublicKey: senderKey.publicKey },
        clock,
      )
    ).plaintext,
    plain,
  );
  // Parsing fixes canonical field order; JSON property order is not authority.
  const reordered = {
    ...envelope,
    header: Object.fromEntries(Object.entries(h).reverse()),
  };
  assert.deepEqual(
    (
      await openPrivateEnvelope(
        reordered,
        h,
        { recipientKey, senderPublicKey: senderKey.publicKey },
        clock,
      )
    ).plaintext,
    plain,
  );
});

test("Private envelope opening requires sender authentication and the application domain", async () => {
  const senderKey = await keypair(),
    recipientKey = await keypair(),
    h = header();
  const info = bytes("org.bittrees.ai/private-envelope/v1");
  for (const params of [
    { recipientPublicKey: recipientKey.publicKey, info },
    {
      recipientPublicKey: recipientKey.publicKey,
      senderKey,
      info: bytes("different application"),
    },
  ]) {
    const other = await suite().seal(
      params,
      bytes("secret"),
      independentAad(h),
    );
    await assert.rejects(
      openPrivateEnvelope(
        { header: h, enc: to64(other.enc), ciphertext: to64(other.ct) },
        h,
        { recipientKey, senderPublicKey: senderKey.publicKey },
        clock,
      ),
      invalid,
    );
  }
  const envelope = await sealPrivateEnvelope(
    h,
    bytes("secret"),
    { senderKey, recipientPublicKey: recipientKey.publicKey },
    clock,
  );
  await assert.rejects(
    openPrivateEnvelope(
      envelope,
      h,
      { recipientKey, senderPublicKey: undefined as unknown as CryptoKey },
      clock,
    ),
    invalid,
  );
  await assert.rejects(
    sealPrivateEnvelope(
      h,
      bytes("secret"),
      {
        senderKey: undefined as unknown as CryptoKeyPair,
        recipientPublicKey: recipientKey.publicKey,
      },
      clock,
    ),
    invalid,
  );
});

test("Every routing, epoch, operation, sequence and time field is authenticated", async () => {
  const senderKey = await keypair(),
    recipientKey = await keypair(),
    h = header(),
    keys = { recipientKey, senderPublicKey: senderKey.publicKey };
  const envelope = await sealPrivateEnvelope(
    h,
    bytes("private source"),
    { senderKey, recipientPublicKey: recipientKey.publicKey },
    clock,
  );
  for (const field of [
    "ownerId",
    "senderId",
    "recipientId",
    "messageId",
    "operationId",
    "senderKeyEpoch",
    "recipientKeyEpoch",
    "sequence",
    "issuedAt",
    "expiresAt",
  ] as const) {
    const changed = {
      ...h,
      [field]:
        typeof h[field] === "number" ? Number(h[field]) + 1 : randomUUID(),
    };
    // Even if the caller expects the tampered routing, the original tag must reject it.
    await assert.rejects(
      openPrivateEnvelope(
        { ...envelope, header: changed },
        changed,
        keys,
        clock,
      ),
      invalid,
    );
  }
  for (const field of ["enc", "ciphertext"] as const) {
    const changed = from64(envelope[field]);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    await assert.rejects(
      openPrivateEnvelope(
        { ...envelope, [field]: to64(changed) },
        h,
        keys,
        clock,
      ),
      invalid,
    );
  }
  const outsider = await keypair();
  await assert.rejects(
    openPrivateEnvelope(
      envelope,
      h,
      { recipientKey: outsider, senderPublicKey: senderKey.publicKey },
      clock,
    ),
    invalid,
  );
  await assert.rejects(
    openPrivateEnvelope(
      envelope,
      h,
      { recipientKey, senderPublicKey: outsider.publicKey },
      clock,
    ),
    invalid,
  );
  await assert.rejects(
    openPrivateEnvelope(envelope, { ...h, sequence: 2 }, keys, clock),
    invalid,
  );
  await assert.rejects(
    openPrivateEnvelope(envelope, { ...h, recipientKeyEpoch: 3 }, keys, clock),
    invalid,
  );
});

test("Private codec rejects plaintext/downgrade fallback, malformed encodings, extra fields and invalid lifetimes", async () => {
  const senderKey = await keypair(),
    recipientKey = await keypair(),
    h = header(),
    keys = { recipientKey, senderPublicKey: senderKey.publicKey };
  const envelope = await sealPrivateEnvelope(
    h,
    bytes("private source"),
    { senderKey, recipientPublicKey: recipientKey.publicKey },
    clock,
  );
  for (const raw of [
    null,
    { header: h, plaintext: "secret" },
    { ...envelope, plaintext: "secret" },
    { ...envelope, enc: envelope.enc + "=" },
    { ...envelope, enc: "AA" },
    { ...envelope, ciphertext: "AA" },
    { ...envelope, ciphertext: "a".repeat(90000) },
    { ...envelope, header: { ...h, title: "private title" } },
    { ...envelope, header: { ...h, suite: "none" } },
    { ...envelope, header: { ...h, version: 2 } },
  ]) {
    await assert.rejects(openPrivateEnvelope(raw, h, keys, clock), invalid);
  }
  for (const change of [
    { issuedAt: now + 30001 },
    { expiresAt: now },
    { expiresAt: now + 86400001 },
    { sequence: 0 },
    { senderKeyEpoch: Number.MAX_SAFE_INTEGER + 1 },
    { senderId: h.recipientId },
  ]) {
    await assert.rejects(
      sealPrivateEnvelope(
        { ...h, ...change },
        bytes("secret"),
        { senderKey, recipientPublicKey: recipientKey.publicKey },
        clock,
      ),
      invalid,
    );
  }
  await assert.rejects(
    openPrivateEnvelope(envelope, h, keys, () => h.expiresAt),
    invalid,
  );
  await assert.rejects(
    openPrivateEnvelope(envelope, h, keys, () => NaN),
    invalid,
  );
  for (const body of [
    new Uint8Array(),
    new Uint8Array(privateEnvelopeLimit + 1),
    new Uint8Array(new SharedArrayBuffer(5)),
  ])
    await assert.rejects(
      sealPrivateEnvelope(
        h,
        body,
        { senderKey, recipientPublicKey: recipientKey.publicKey },
        clock,
      ),
      invalid,
    );
  const largest = new Uint8Array(privateEnvelopeLimit).fill(255);
  const full = await sealPrivateEnvelope(
    h,
    largest,
    { senderKey, recipientPublicKey: recipientKey.publicKey },
    clock,
  );
  assert.deepEqual(
    (await openPrivateEnvelope(full, h, keys, clock)).plaintext,
    largest,
  );
});

test("Private codec snapshots mutable inputs, rechecks expiry and uses fresh contexts under concurrency", async () => {
  const senderKey = await keypair(),
    recipientKey = await keypair(),
    h = header(),
    expected = { ...h },
    plain = bytes("original"),
    keys = { senderKey, recipientPublicKey: recipientKey.publicKey };
  const pending = sealPrivateEnvelope(h, plain, keys, clock);
  plain.fill(0);
  h.operationId = randomUUID();
  keys.recipientPublicKey = senderKey.publicKey;
  const envelope = await pending;
  const openKeys = { recipientKey, senderPublicKey: senderKey.publicKey };
  assert.equal(
    new TextDecoder().decode(
      (await openPrivateEnvelope(envelope, expected, openKeys, clock))
        .plaintext,
    ),
    "original",
  );
  const open = openPrivateEnvelope(envelope, expected, openKeys, clock);
  envelope.header.sequence = 100;
  expected.sequence = 200;
  openKeys.senderPublicKey = recipientKey.publicKey;
  assert.equal(new TextDecoder().decode((await open).plaintext), "original");
  let ticks = 0;
  await assert.rejects(
    sealPrivateEnvelope(
      header(),
      bytes("secret"),
      { senderKey, recipientPublicKey: recipientKey.publicKey },
      () => (ticks++ === 0 ? now : now + 86400000),
    ),
    invalid,
  );
  const stable = header();
  const concurrent = await Promise.all(
    Array.from({ length: 12 }, () =>
      sealPrivateEnvelope(
        stable,
        bytes("same"),
        { senderKey, recipientPublicKey: recipientKey.publicKey },
        clock,
      ),
    ),
  );
  assert.equal(new Set(concurrent.map((e) => e.enc)).size, 12);
  assert.equal(new Set(concurrent.map((e) => e.ciphertext)).size, 12);
  for (const value of concurrent)
    assert.equal(
      new TextDecoder().decode(
        (
          await openPrivateEnvelope(
            value,
            stable,
            { recipientKey, senderPublicKey: senderKey.publicKey },
            clock,
          )
        ).plaintext,
      ),
      "same",
    );
  ticks = 0;
  await assert.rejects(
    openPrivateEnvelope(
      concurrent[0],
      stable,
      { recipientKey, senderPublicKey: senderKey.publicKey },
      () => (ticks++ === 0 ? now : now + 86400000),
    ),
    invalid,
  );
  // This codec deliberately does not maintain an inbox: replay consumption belongs to durable acceptance.
  await openPrivateEnvelope(
    concurrent[0],
    stable,
    { recipientKey, senderPublicKey: senderKey.publicKey },
    clock,
  );
  await openPrivateEnvelope(
    concurrent[0],
    stable,
    { recipientKey, senderPublicKey: senderKey.publicKey },
    clock,
  );
});
