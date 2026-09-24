import type { Store, Owner } from "../../modules/storage/store.js";
import type { Vault } from "../../modules/storage/vault.js";
import type { RemoteClient } from "../../modules/remote/client.js";
import type { PrivateBinding } from "../../modules/remote/private-peer-contracts.js";
import type { PrivateKeyLifecycle } from "../../modules/remote/private-key-lifecycle.js";
import { PrivatePeerEnrollment } from "../../modules/remote/private-peers.js";
import { PrivateConversationConsent } from "../../modules/remote/private-conversation-consent.js";
import {
  PrivateConversationContent,
  ConversationContentError,
  conversationPrepareInputSchema,
  conversationSealInputSchema,
  conversationReceiveInputSchema,
  conversationReconcileInputSchema,
  type ConversationTaskAccess,
} from "../../modules/remote/private-conversation-content.js";

type Entry = Awaited<ReturnType<PrivateConversationContent["prepare"]>>;
// No task text, key proofs, source bindings or ciphertext in status/receipts.
function summary(entry: Entry) {
  const v = entry.value;
  return {
    id: v.content.id,
    permissionId: v.grant.id,
    revision: entry.revision,
    direction: v.direction,
    kind: v.content.type,
    state: v.state,
    locked: entry.locked,
    peerId: v.grant.choices.peerId,
    localMessageId: v.localMessageId,
    expiresAt: v.header.expiresAt,
    receiptPrepared: v.direction === "incoming" && !!v.receiptEnvelope,
    recipientAccepted: v.direction === "outgoing" && !!v.receiptEnvelope,
    recipientAcceptedAt:
      v.direction === "outgoing" ? (v.receipt?.acceptedAt ?? null) : null,
  };
}

/** Authenticated local handoff. The parent holds key/peer/permission exclusion.
 * Construction/status never accesses native keys or the network. This class
 * does not poll, submit to a relay, or claim recipient delivery. */
export class CompanionConversationContent {
  private generation = 0;
  constructor(
    private store: Store,
    private vault: Vault,
    private owner: Owner,
    private keys: (current: () => PrivateBinding | null) => PrivateKeyLifecycle,
    private remote?: RemoteClient,
    private enabled = false,
    private taskAccess?: ConversationTaskAccess,
    private now = Date.now,
  ) {
    this.owner = { ...owner };
  }

  invalidate() {
    this.generation++;
  }
  status() {
    return {
      available: true,
      enabled: this.enabled && !!this.remote,
      transportActive: false,
      items: this.store
        .exportPrivateConversationContent(this.owner)
        .map(summary),
    };
  }
  private async scope<T>(
    action: (engine: PrivateConversationContent) => Promise<T>,
  ): Promise<T> {
    if (!this.enabled || !this.remote)
      throw new ConversationContentError("DENIED");
    const generation = this.generation;
    return this.remote.withVerifiedDevice(async (scope) => {
      const current = () =>
        generation === this.generation ? scope.current() : null;
      if (!current()) throw new ConversationContentError("DENIED");
      const keys = this.keys(current);
      const consent = new PrivateConversationConsent(
        this.store,
        this.vault,
        this.owner,
        current,
        keys,
        new PrivatePeerEnrollment(
          this.store,
          this.vault,
          this.owner,
          current,
          this.now,
        ),
        this.now,
      );
      const engine = new PrivateConversationContent(
        this.store,
        this.vault,
        this.owner,
        consent,
        keys,
        this.taskAccess,
        this.now,
      );
      const result = await action(engine);
      if (!current()) throw new ConversationContentError("DENIED");
      return result;
    });
  }
  prepare(raw: unknown) {
    const input = conversationPrepareInputSchema.parse(raw);
    return this.scope(async (engine) => ({
      entry: summary(await engine.prepare(input)),
    }));
  }
  envelope(raw: unknown) {
    const input = conversationSealInputSchema.parse(raw);
    return this.scope(async (engine) => ({
      envelope: await engine.seal(input),
    }));
  }
  receive(raw: unknown) {
    const input = conversationReceiveInputSchema.parse(raw);
    return this.scope(async (engine) => {
      const result = await engine.accept(input);
      return {
        status: "accepted-locally" as const,
        duplicate: result.duplicate,
        entry: summary(result.entry),
      };
    });
  }
  reconcile(raw: unknown) {
    const input = conversationReconcileInputSchema.parse(raw);
    return this.scope(async (engine) => {
      const result = await engine.reconcile(input);
      return {
        status: "recipient-storage-confirmed" as const,
        duplicate: result.duplicate,
        entry: summary(result.entry),
      };
    });
  }
}
