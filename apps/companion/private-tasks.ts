import { z } from "zod";
import { exportPrivateTaskReceipts } from "../../modules/remote/private-task-receipts.js";
import type { Store, Owner } from "../../modules/storage/store.js";
import type { Vault } from "../../modules/storage/vault.js";
import type { RemoteClient } from "../../modules/remote/client.js";
import type { PrivateBinding } from "../../modules/remote/private-peer-contracts.js";
import type { PrivateKeyLifecycle } from "../../modules/remote/private-key-lifecycle.js";
import { PrivatePeerEnrollment } from "../../modules/remote/private-peers.js";
import { PrivateTaskConsent } from "../../modules/remote/private-task-consent.js";
import { privateEnvelopeSchema } from "../../modules/remote/private-envelope.js";
import {
  PrivateTaskReceiver,
  PrivateTaskError,
} from "../../modules/remote/private-task-receiver.js";
import {
  PrivateTaskResponses,
  exportPrivateTaskResponses,
} from "../../modules/remote/private-task-responses.js";

const responseId = z.strictObject({ id: z.uuid(), confirmed: z.literal(true) });
export const responsePrepareSchema = z.strictObject({
  operationId: z.uuid(),
  peerId: z.uuid(),
  kind: z.enum(["accepted", "result"]),
  confirmed: z.literal(true),
});
export const responseDeliverySchema = responseId.extend({
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
type ResponseEntry = ReturnType<PrivateTaskResponses["get"]>;
// Only local routing/state metadata crosses the controller boundary. Plaintext
// response content and key/permission proofs stay inside the protocol modules.
function summary(e: ResponseEntry) {
  return {
    id: e.id,
    revision: e.revision,
    kind: e.kind,
    locked: e.locked,
    state: e.value.state,
    operationId: e.value.header.operationId,
    peerId: e.value.header.recipientId,
    expiresAt: e.value.header.expiresAt,
    attempts: e.value.attempts,
  };
}
/** Parent serializes these operations with key/peer/consent changes and deletion.
 * This is an authenticated local handoff, not a relay listener or background sender.
 */
export class CompanionPrivateTasks {
  constructor(
    private store: Store,
    private vault: Vault,
    private owner: Owner,
    private keys: (
      current?: () => PrivateBinding | null,
    ) => PrivateKeyLifecycle,
    private remote?: RemoteClient,
    private enabled = false,
    private now = Date.now,
  ) {
    this.owner = { ...owner };
  }

  status() {
    return {
      available: true,
      enabled: this.enabled && !!this.remote,
      transportActive: false,
      // Owner-local history only. These identifiers cannot authorize response
      // preparation or sending; those operations obtain fresh native scopes.
      acceptedTasks: exportPrivateTaskReceipts(
        this.store,
        this.vault,
        this.owner,
      ).map((receipt) => ({
        operationId: receipt.header.operationId,
        taskId: receipt.taskId,
        peerId: receipt.header.senderId,
        peerKeyEpoch: receipt.header.senderKeyEpoch,
        acceptedAt: receipt.acceptedAt,
      })),
      responses: exportPrivateTaskResponses(
        this.store,
        this.vault,
        this.owner,
      ).map(summary),
    };
  }
  private responses(
    current: () => PrivateBinding | null = () => null,
    authority: ConstructorParameters<typeof PrivateTaskResponses>[4] = () =>
      null,
  ) {
    return new PrivateTaskResponses(
      this.store,
      this.vault,
      this.owner,
      current,
      authority,
      this.now,
    );
  }
  private async scope<T>(
    peerId: string,
    action: (
      current: () => PrivateBinding | null,
      providers: Awaited<ReturnType<PrivateTaskConsent["resolve"]>>,
    ) => Promise<T> | T,
  ): Promise<T> {
    if (!this.enabled || !this.remote) throw new PrivateTaskError("DENIED");
    return this.remote.withVerifiedDevice((scope) =>
      this.withCurrent(peerId, scope.current, action),
    );
  }
  private async withCurrent<T>(
    peerId: string,
    current: () => PrivateBinding | null,
    action: (
      current: () => PrivateBinding | null,
      providers: Awaited<ReturnType<PrivateTaskConsent["resolve"]>>,
    ) => Promise<T> | T,
  ): Promise<T> {
    if (!this.enabled || !this.remote || !current())
      throw new PrivateTaskError("DENIED");
    const consent = new PrivateTaskConsent(
      this.store,
      this.vault,
      this.owner,
      current,
      this.keys(current),
      new PrivatePeerEnrollment(
        this.store,
        this.vault,
        this.owner,
        current,
        this.now,
      ),
      this.now,
    );
    const providers = await consent.resolve(peerId);
    return action(current, providers);
  }
  async receive(raw: unknown) {
    const envelope = privateEnvelopeSchema.parse(raw);
    return this.scope(envelope.header.senderId, (current, providers) =>
      this.admit(envelope, current, providers),
    );
  }
  /** Internal native callback only, supplied by active relay custody. Never JSON
   * authority: the parent holds key/peer/consent exclusion before opening custody. */
  async receiveVerified(raw: unknown, current: () => PrivateBinding | null) {
    const envelope = privateEnvelopeSchema.parse(raw);
    return this.withCurrent(
      envelope.header.senderId,
      current,
      (live, providers) => this.admit(envelope, live, providers),
    );
  }
  private async admit(
    envelope: z.infer<typeof privateEnvelopeSchema>,
    current: () => PrivateBinding | null,
    providers: Awaited<ReturnType<PrivateTaskConsent["resolve"]>>,
  ) {
    const receipt = await new PrivateTaskReceiver(
      this.store,
      this.vault,
      this.owner,
      current,
      providers.receive,
      this.now,
    ).accept(envelope);
    return {
      status: "accepted-locally" as const,
      taskId: receipt.taskId,
      operationId: receipt.header.operationId,
    };
  }
  async prepareResponse(raw: unknown) {
    const input = responsePrepareSchema.parse(raw);
    return this.scope(input.peerId, async (current, providers) =>
      summary(await this.responses(current, providers.respond).prepare(input)),
    );
  }
  async prepareResponseVerified(
    raw: unknown,
    current: () => PrivateBinding | null,
    deliveryLimit: number,
  ) {
    const input = responsePrepareSchema.parse(raw);
    return this.withCurrent(input.peerId, current, async (live, providers) =>
      summary(
        await this.responses(live, providers.respond).prepare(
          input,
          deliveryLimit,
        ),
      ),
    );
  }
  responseTarget(raw: unknown) {
    const input = responseDeliverySchema.parse(raw),
      stored = this.responses().get(input.id);
    if (stored.revision !== input.expectedRevision)
      throw new PrivateTaskError("CONFLICT");
    return summary(stored);
  }
  async responseEnvelopeVerified(
    raw: unknown,
    current: () => PrivateBinding | null,
    deliveryLimit: number,
  ) {
    const input = responseDeliverySchema.parse(raw),
      target = this.responseTarget(input);
    return this.withCurrent(target.peerId, current, (live, providers) =>
      this.responses(live, providers.respond).delivery(
        input.id,
        input.expectedRevision,
        deliveryLimit,
      ),
    );
  }
  async resumeResponse(raw: unknown) {
    const input = responseId.parse(raw),
      stored = this.responses().get(input.id);
    return this.scope(
      stored.value.permission.peerId,
      async (current, providers) =>
        summary(
          await this.responses(current, providers.respond).resume(input.id),
        ),
    );
  }
  async responseEnvelope(raw: unknown) {
    const input = responseId.parse(raw),
      stored = this.responses().get(input.id);
    return this.scope(stored.value.permission.peerId, (current, providers) =>
      this.responses(current, providers.respond).delivery(input.id),
    );
  }
  stopResponse(raw: unknown) {
    // Offline and usable even with setup disabled. Stop does not cancel local work
    // or retract copies already handed to a caller; revision confirmation is required.
    return summary(this.responses().stop(raw));
  }
}
