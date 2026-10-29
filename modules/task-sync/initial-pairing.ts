import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { z } from "zod";

// Native-only metadata pairing. This module creates no runtime credential,
// controller, workspace, source permission or delegation.
export const INITIAL_PAIRING_START =
  "https://roles.bittrees.org/api/mcp/pairing/start";
export const INITIAL_PAIRING_POLL =
  "https://roles.bittrees.org/api/mcp/pairing/poll";
export const INITIAL_PAIRING_AUDIENCE = "bittrees-ai-native-initial-pairing-v1";
export const INITIAL_PAIRING_MAX_CALLS = 62;
export const INITIAL_PAIRING_MAX_DURATION_MS = 300000;
const hex = z.string().regex(/^[a-f0-9]{64}$/),
  time = z.number().int().nonnegative();
const principal = z
  .string()
  .refine(
    (v) => v.startsWith("agent:") && z.uuid().safeParse(v.slice(6)).success,
  );
export const pairingIdentity = z.strictObject({
  principal,
  publicKey: z.string().max(1024),
});
export const pairingConsent = z.strictObject({
  id: z.uuid(),
  principal,
  keyFingerprint: hex,
  expiresAt: time,
});
export const initialPairingRequest = z.strictObject({
  version: z.literal(1),
  audience: z.literal(INITIAL_PAIRING_START),
  purpose: z.literal("metadata-only-owner-pairing"),
  target: z.literal("Bittrees local AI on this Mac"),
  operationId: z.uuid(),
  requestId: z.uuid(),
  principal,
  publicKey: z.string().max(1024),
  keyFingerprint: hex,
  issuedAt: time,
  expiresAt: time,
});
export const initialPairingPoll = z.strictObject({
  version: z.literal(1),
  audience: z.literal(INITIAL_PAIRING_POLL),
  pairingId: z.uuid(),
  pollSecret: hex,
  operationId: z.uuid(),
  principal,
  keyFingerprint: hex,
  requestDigest: hex,
  issuedAt: time,
  nonce: z.uuid(),
});
const challengeSchema = z.strictObject({
  status: z.literal("pending"),
  pairingId: z.uuid(),
  pollSecret: hex,
  requestDigest: hex,
  reviewUrl: z.string().max(256),
  expiresAt: time,
  permissionsGranted: z.literal(false),
});
const claimSchema = z.strictObject({
  version: z.literal(1),
  issuer: z.literal("https://roles.bittrees.org"),
  audience: z.literal(INITIAL_PAIRING_AUDIENCE),
  purpose: z.literal("metadata-only-owner-pairing"),
  pairingId: z.uuid(),
  operationId: z.uuid(),
  requestDigest: hex,
  pollRequestDigest: hex,
  principal,
  keyFingerprint: hex,
  ownerProfile: z.uuid(),
  personPrincipal: z.string().max(64),
  policyDigest: hex,
  activePerson: z.literal(true),
  applicableRole: z.literal(true),
  checkedAt: time,
  expiresAt: time,
  permissionsGranted: z.literal(false),
  rolesCredentialId: z.null(),
  runtimeEnrolled: z.literal(false),
  workspace: z.null(),
  nativeLease: z.null(),
  agentController: z.null(),
});
const signatureSchema = z.string().regex(/^[A-Za-z0-9+/]{86}==$/);
type Initial = z.infer<typeof initialPairingRequest>;
type Poll = z.infer<typeof initialPairingPoll>;
type Identity = z.infer<typeof pairingIdentity>;
export type InitialPairingConsent = z.infer<typeof pairingConsent>;
const stateSchema = z.strictObject({
  phase: z.enum(["starting", "pending", "held", "paired"]),
  consentId: z.uuid(),
  request: initialPairingRequest,
  calls: z.number().int().min(1).max(INITIAL_PAIRING_MAX_CALLS),
  lastPoll: time,
  challenge: challengeSchema.optional(),
  proof: z.unknown().optional(),
});
export type InitialPairingState = z.infer<typeof stateSchema>;
export interface InitialPairingStore {
  load(): Promise<unknown | null>;
  save(state: InitialPairingState): Promise<void>;
}
function fail(): never {
  throw Error("Initial native pairing unavailable or binding rejected");
}
function bounded(v: unknown) {
  let nodes = 0;
  const seen = new Set<object>();
  function walk(x: unknown, depth: number) {
    if (++nodes > 256 || depth > 8) fail();
    if (
      x === null ||
      typeof x === "boolean" ||
      (typeof x === "string" && x.length <= 4096) ||
      (typeof x === "number" && Number.isSafeInteger(x))
    )
      return;
    if (
      !x ||
      typeof x !== "object" ||
      seen.has(x) ||
      (!Array.isArray(x) && Object.getPrototypeOf(x) !== Object.prototype)
    )
      fail();
    seen.add(x);
    for (const [k, value] of Object.entries(x)) {
      if (k.length > 128) fail();
      walk(value, depth + 1);
    }
    seen.delete(x);
  }
  walk(v, 0);
  if (Buffer.byteLength(JSON.stringify(v)) > 16384) fail();
}
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const o = v as Record<string, unknown>;
  return (
    "{" +
    Object.keys(o)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(o[k]))
      .join(",") +
    "}"
  );
}
export const pairingDigest = (v: unknown) => {
  bounded(v);
  return createHash("sha256").update(canonical(v)).digest("hex");
};
const message = (domain: string, v: unknown) => {
  bounded(v);
  return domain + canonical(v);
};
export const initialPairingMessage = (v: unknown) =>
  message("Bittrees native initial owner pairing request v1\n", v);
export const initialPairingPollMessage = (v: unknown) =>
  message("Bittrees native initial owner pairing poll v1\n", v);
export const initialPairingClaimMessage = (v: unknown) =>
  message("Bittrees native initial owner pairing claim v1\n", v);
function keyIdentity(raw: Identity) {
  const id = pairingIdentity.parse(raw),
    key = createPublicKey(id.publicKey);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    key.export({ type: "spki", format: "pem" }).toString() !== id.publicKey
  )
    fail();
  return {
    key,
    keyFingerprint: createHash("sha256").update(id.publicKey).digest("hex"),
  };
}
function signed(
  text: string,
  signature: string,
  key: ReturnType<typeof createPublicKey>,
) {
  return (
    signatureSchema.safeParse(signature).success &&
    key.asymmetricKeyType === "ed25519" &&
    verify(null, Buffer.from(text), key, Buffer.from(signature, "base64"))
  );
}
export function validateInitialPairingRequest(raw: unknown, now = Date.now()) {
  bounded(raw);
  const r = initialPairingRequest.parse(raw);
  if (
    r.issuedAt > now ||
    r.issuedAt < now - 15000 ||
    r.expiresAt <= now ||
    r.expiresAt > r.issuedAt + INITIAL_PAIRING_MAX_DURATION_MS ||
    keyIdentity({ principal: r.principal, publicKey: r.publicKey })
      .keyFingerprint !== r.keyFingerprint
  )
    fail();
  return r;
}
export function verifyInitialPairingRequest(raw: unknown, now = Date.now()) {
  bounded(raw);
  const p = z
      .strictObject({
        request: initialPairingRequest,
        signature: signatureSchema,
      })
      .parse(raw),
    r = validateInitialPairingRequest(p.request, now);
  if (
    !signed(
      initialPairingMessage(r),
      p.signature,
      keyIdentity({ principal: r.principal, publicKey: r.publicKey }).key,
    )
  )
    fail();
  return r;
}
function challenge(raw: unknown, request: Initial, now: number) {
  bounded(raw);
  const c = challengeSchema.parse(raw);
  if (
    c.requestDigest !== pairingDigest(request) ||
    c.reviewUrl !==
      "https://roles.bittrees.org/profile?pairingRequest=" + c.pairingId ||
    c.expiresAt <= now ||
    c.expiresAt > request.expiresAt
  )
    fail();
  return c;
}
export function verifyInitialPairingPollRequest(
  raw: unknown,
  initial: Initial,
  pairingId: string,
  now = Date.now(),
) {
  bounded(raw);
  validateInitialPairingRequest(initial, initial.issuedAt);
  const p = z
      .strictObject({ request: initialPairingPoll, signature: signatureSchema })
      .parse(raw),
    r = p.request;
  if (
    initial.expiresAt <= now ||
    r.pairingId !== pairingId ||
    r.operationId !== initial.operationId ||
    r.principal !== initial.principal ||
    r.keyFingerprint !== initial.keyFingerprint ||
    r.requestDigest !== pairingDigest(initial) ||
    r.issuedAt > now ||
    now - r.issuedAt > 15000 ||
    !signed(
      initialPairingPollMessage(r),
      p.signature,
      keyIdentity({
        principal: initial.principal,
        publicKey: initial.publicKey,
      }).key,
    )
  )
    fail();
  return r;
}
export function verifyInitialPairingClaim(
  raw: unknown,
  request: Initial,
  rawPoll: Poll,
  rolesPublicKey: string,
  now = Date.now(),
) {
  bounded(raw);
  validateInitialPairingRequest(request, request.issuedAt);
  const poll = initialPairingPoll.parse(rawPoll);
  if (
    request.expiresAt <= now ||
    poll.operationId !== request.operationId ||
    poll.principal !== request.principal ||
    poll.keyFingerprint !== request.keyFingerprint ||
    poll.requestDigest !== pairingDigest(request) ||
    poll.issuedAt > now ||
    now - poll.issuedAt > 15000
  )
    fail();
  const p = z
      .strictObject({ claim: claimSchema, signature: signatureSchema })
      .parse(raw),
    c = p.claim;
  if (
    c.pairingId !== poll.pairingId ||
    c.pollRequestDigest !== pairingDigest(poll) ||
    c.operationId !== request.operationId ||
    c.requestDigest !== pairingDigest(request) ||
    c.principal !== request.principal ||
    c.keyFingerprint !== request.keyFingerprint ||
    c.personPrincipal !== "person:" + c.ownerProfile ||
    c.checkedAt > now ||
    c.checkedAt < poll.issuedAt ||
    c.expiresAt <= now ||
    c.expiresAt - c.checkedAt > 5000 ||
    c.expiresAt > request.expiresAt
  )
    fail();
  const key = createPublicKey(rolesPublicKey);
  if (
    key.export({ type: "spki", format: "pem" }).toString() !== rolesPublicKey ||
    !signed(initialPairingClaimMessage(c), p.signature, key)
  )
    fail();
  return c;
}
/** Trusted native helper only; no construction-time I/O. Source owner routes,
 * signer purpose, current active person/role and admission must be reviewed
 * separately before this can be wired. No source key is accepted from replies. */
export class NativeInitialPairing {
  private busy = false;
  private identity: Identity;
  private fingerprint: string;
  constructor(
    private options: {
      identity: Identity;
      signLocal: (message: string) => Promise<string>;
      currentConsent: () => InitialPairingConsent | null;
      store: InitialPairingStore;
      transport: (input: {
        url: string;
        method: "POST";
        body: unknown;
      }) => Promise<unknown>;
      rolesPublicKey: string;
      now?: () => number;
    },
  ) {
    this.identity = pairingIdentity.parse(options.identity);
    this.fingerprint = keyIdentity(this.identity).keyFingerprint;
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private current() {
    const c = pairingConsent.parse(this.options.currentConsent()),
      now = this.now();
    if (
      !Number.isSafeInteger(now) ||
      c.principal !== this.identity.principal ||
      c.keyFingerprint !== this.fingerprint ||
      c.expiresAt <= now ||
      c.expiresAt > now + INITIAL_PAIRING_MAX_DURATION_MS
    )
      fail();
    return c;
  }
  private async exclusive<T>(action: () => Promise<T>) {
    if (this.busy) fail();
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
    }
  }
  async start() {
    return this.exclusive(async () => {
      const consent = this.current();
      if (await this.options.store.load())
        throw Error("Reconcile existing pairing before starting another");
      this.current();
      const request: Initial = {
        version: 1,
        audience: INITIAL_PAIRING_START,
        purpose: "metadata-only-owner-pairing",
        target: "Bittrees local AI on this Mac",
        operationId: randomUUID(),
        requestId: randomUUID(),
        ...this.identity,
        keyFingerprint: this.fingerprint,
        issuedAt: this.now(),
        expiresAt: consent.expiresAt,
      };
      const signature = await this.options.signLocal(
        initialPairingMessage(request),
      );
      verifyInitialPairingRequest({ request, signature }, this.now());
      const state: InitialPairingState = {
        phase: "starting",
        consentId: consent.id,
        request,
        calls: 1,
        lastPoll: 0,
      };
      await this.options.store.save(state);
      try {
        if (this.current().id !== consent.id) fail();
        validateInitialPairingRequest(request, this.now());
        const raw = await this.options.transport({
          url: INITIAL_PAIRING_START,
          method: "POST",
          body: { request, signature },
        });
        if (this.current().id !== consent.id) fail();
        const result = challenge(raw, request, this.now());
        await this.options.store.save({
          ...state,
          phase: "pending",
          challenge: result,
        });
        if (
          this.current().id !== consent.id ||
          this.current().expiresAt !== consent.expiresAt
        )
          fail();
        return {
          status: "pending",
          reviewUrl: result.reviewUrl,
          expiresAt: result.expiresAt,
          permissionsGranted: false,
        };
      } catch (error) {
        await this.options.store.save({ ...state, phase: "held" });
        throw error;
      }
    });
  }
  async poll() {
    return this.exclusive(async () => {
      const consent = this.current(),
        state = stateSchema.parse(await this.options.store.load());
      if (
        state.phase !== "pending" ||
        state.consentId !== consent.id ||
        state.request.expiresAt !== consent.expiresAt ||
        state.request.principal !== this.identity.principal ||
        state.request.keyFingerprint !== this.fingerprint ||
        state.calls >= INITIAL_PAIRING_MAX_CALLS ||
        this.now() - state.lastPoll < 5000
      )
        fail();
      const pending = challenge(state.challenge, state.request, this.now());
      const next = { ...state, calls: state.calls + 1, lastPoll: this.now() };
      await this.options.store.save(next);
      if (this.current().id !== consent.id) fail();
      const request: Poll = {
        version: 1,
        audience: INITIAL_PAIRING_POLL,
        pairingId: pending.pairingId,
        pollSecret: pending.pollSecret,
        operationId: state.request.operationId,
        principal: this.identity.principal,
        keyFingerprint: this.fingerprint,
        requestDigest: pairingDigest(state.request),
        issuedAt: this.now(),
        nonce: randomUUID(),
      };
      const signature = await this.options.signLocal(
        initialPairingPollMessage(request),
      );
      if (
        this.current().id !== consent.id ||
        this.current().expiresAt !== state.request.expiresAt
      )
        fail();
      verifyInitialPairingPollRequest(
        { request, signature },
        state.request,
        pending.pairingId,
        this.now(),
      );
      const raw = await this.options.transport({
        url: INITIAL_PAIRING_POLL,
        method: "POST",
        body: { request, signature },
      });
      if (this.current().id !== consent.id) fail();
      bounded(raw);
      if ((raw as { status?: unknown })?.status === "pending") {
        const p = z
          .strictObject({
            status: z.literal("pending"),
            expiresAt: time,
            permissionsGranted: z.literal(false),
          })
          .parse(raw);
        if (p.expiresAt !== pending.expiresAt) fail();
        return p;
      }
      const result = z
        .strictObject({ status: z.literal("paired"), proof: z.unknown() })
        .parse(raw);
      const claim = verifyInitialPairingClaim(
        result.proof,
        state.request,
        request,
        this.options.rolesPublicKey,
        this.now(),
      );
      await this.options.store.save({
        ...next,
        phase: "paired",
        proof: result.proof,
      });
      try {
        if (
          this.current().id !== consent.id ||
          this.current().expiresAt !== consent.expiresAt
        )
          fail();
      } catch (error) {
        await this.options.store.save({
          ...next,
          phase: "held",
          proof: result.proof,
        });
        throw error;
      }
      return {
        status: "paired",
        principal: claim.principal,
        keyFingerprint: claim.keyFingerprint,
        ownerProfile: claim.ownerProfile,
        permissionsGranted: false,
        rolesCredentialId: null,
        runtimeEnrolled: false,
        workspace: null,
        nativeLease: null,
        agentController: null,
      };
    });
  }
}
