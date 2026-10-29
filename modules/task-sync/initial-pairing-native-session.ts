import { createHash, createPublicKey } from "node:crypto";
import { z } from "zod";
import type { Vault } from "../storage/vault.js";
import {
  NativeInitialPairing,
  initialPairingRequest,
  pairingConsent,
  pairingIdentity,
  type InitialPairingConsent,
  type InitialPairingStore,
} from "./initial-pairing.js";
import { InitialPairingHTTPS } from "./initial-pairing-https.js";
import { openNativeInitialPairingJournal } from "./initial-pairing-native-journal.js";
import { signNativeInitialPairingMessage } from "./initial-pairing-signer.js";
import { readNativeWorkflowIdentity } from "./native-identity-review.js";

type Network = {
  resolve?: ConstructorParameters<typeof InitialPairingHTTPS>[2];
  send?: ConstructorParameters<typeof InitialPairingHTTPS>[3];
};
/** Unregistered trusted native assembly. No constructor-time disk, vault,
 * Keychain, DNS or socket access. Not a model/browser/MCP interface. */
export class NativeInitialPairingSession {
  private readonly identity;
  private readonly fingerprint: string;
  private readonly sourceKey: string;
  private readonly sourceFingerprint: string;
  private readonly abort = new AbortController();
  private closing = false;
  private inflight: Promise<unknown> | undefined;
  private journal:
    ReturnType<typeof openNativeInitialPairingJournal> | undefined;
  private pairing: NativeInitialPairing | undefined;
  constructor(
    private readonly options: {
      identity: { principal: string; publicKey: string };
      taskStatePath: string;
      journalPath: string;
      vault: Vault;
      currentConsent: () => InitialPairingConsent | null;
      rolesPublicKey: string;
      admitSource: (review: {
        purpose: "metadata-only-owner-pairing";
        rolesKeyFingerprint: string;
        consent: InitialPairingConsent;
      }) => void;
      // Native dependency injection for synthetic acceptance only; never read from
      // model output, environment, browser messages or source responses.
      network?: Network;
    },
  ) {
    this.identity = pairingIdentity.parse(options.identity);
    const local = createPublicKey(this.identity.publicKey);
    const source = createPublicKey(options.rolesPublicKey);
    if (
      local.asymmetricKeyType !== "ed25519" ||
      source.asymmetricKeyType !== "ed25519" ||
      local.export({ type: "spki", format: "pem" }).toString() !==
        this.identity.publicKey ||
      source.export({ type: "spki", format: "pem" }).toString() !==
        options.rolesPublicKey
    )
      throw Error("Canonical independently reviewed pairing keys required");
    this.sourceKey = options.rolesPublicKey;
    this.fingerprint = createHash("sha256")
      .update(this.identity.publicKey)
      .digest("hex");
    this.sourceFingerprint = createHash("sha256")
      .update(this.sourceKey)
      .digest("hex");
  }
  private consent() {
    if (this.closing) throw Error("Native pairing session closed");
    const consent = pairingConsent.parse(this.options.currentConsent()),
      now = Date.now();
    if (
      consent.principal !== this.identity.principal ||
      consent.keyFingerprint !== this.fingerprint ||
      consent.expiresAt <= now ||
      consent.expiresAt > now + 300000
    )
      throw Error("Current exact native pairing consent required");
    return consent;
  }
  private admit = () => {
    const before = this.consent();
    this.options.admitSource({
      purpose: "metadata-only-owner-pairing",
      rolesKeyFingerprint: this.sourceFingerprint,
      consent: { ...before },
    });
    const after = this.consent();
    if (before.id !== after.id || before.expiresAt !== after.expiresAt)
      throw Error("Native pairing consent changed during source admission");
  };
  private assemble() {
    if (this.pairing) return this.pairing;
    this.admit();
    const existing = readNativeWorkflowIdentity(
      this.options.taskStatePath,
      this.options.vault,
    );
    if (
      existing.status !== "existing" ||
      existing.principal !== this.identity.principal ||
      existing.publicKey !== this.identity.publicKey ||
      existing.credentialId !== this.fingerprint
    )
      throw Error("Existing reviewed native identity required");
    this.admit();
    const journal = openNativeInitialPairingJournal(
      this.options.journalPath,
      this.options.vault,
      { principal: this.identity.principal, keyFingerprint: this.fingerprint },
    );
    try {
      let cached: unknown = null;
      const store: InitialPairingStore = {
        async load() {
          cached = await journal.store.load();
          return cached;
        },
        async save(value) {
          await journal.store.save(value);
          cached = value;
        },
      };
      const transport = new InitialPairingHTTPS(
        this.admit,
        () => {
          const parsed = z
            .object({
              phase: z.literal("pending"),
              request: initialPairingRequest,
              challenge: z.object({ pairingId: z.uuid() }),
            })
            .safeParse(cached);
          return parsed.success
            ? {
                request: parsed.data.request,
                pairingId: parsed.data.challenge.pairingId,
              }
            : null;
        },
        this.options.network?.resolve,
        this.options.network?.send,
      );
      const pairing = new NativeInitialPairing({
        identity: this.identity,
        rolesPublicKey: this.sourceKey,
        currentConsent: () => this.consent(),
        store,
        signLocal: async (message) => {
          this.admit();
          return signNativeInitialPairingMessage(
            this.options.taskStatePath,
            this.options.vault,
            () => this.consent(),
            message,
          );
        },
        transport: async (plan) => {
          this.admit();
          return transport.dispatch(plan, this.abort.signal);
        },
      });
      this.journal = journal;
      this.pairing = pairing;
      return pairing;
    } catch (error) {
      journal.close();
      throw error;
    }
  }
  private run<T>(
    action: (pairing: NativeInitialPairing) => Promise<T>,
  ): Promise<T> {
    if (this.closing || this.inflight)
      return Promise.reject(Error("Native pairing session closed or busy"));
    const pending = Promise.resolve().then(() => {
      this.admit();
      return action(this.assemble());
    });
    this.inflight = pending;
    return pending.finally(() => {
      if (this.inflight === pending) this.inflight = undefined;
    });
  }
  start() {
    return this.run((pairing) => pairing.start());
  }
  reviewBinding() {
    return {
      principal: this.identity.principal,
      keyFingerprint: this.fingerprint,
      rolesKeyFingerprint: this.sourceFingerprint,
    };
  }
  poll() {
    return this.run((pairing) => pairing.poll());
  }
  async close() {
    this.closing = true;
    this.abort.abort(Error("Native pairing session cancelled"));
    try {
      await this.inflight;
    } catch {
      /* Durable uncertain outcome remains held. */
    }
    this.journal?.close();
  }
}
