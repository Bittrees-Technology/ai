import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PrivateAutoNoteApprovalConsent } from "../../modules/remote/private-autonote-approval-consent.js";
import {
  PrivateAutoNoteApprovalOutbox,
  ApprovalOutboxError,
} from "../../modules/remote/private-autonote-approval-outbox.js";
import { PrivatePeerEnrollment } from "../../modules/remote/private-peers.js";
import type { PrivateKeyLifecycle } from "../../modules/remote/private-key-lifecycle.js";
import type { PrivateBinding } from "../../modules/remote/private-peer-contracts.js";
import type { RemoteClient } from "../../modules/remote/client.js";
import type { Store, Owner } from "../../modules/storage/store.js";
import type { Vault } from "../../modules/storage/vault.js";
import type { AutoNoteApprovalConnector } from "../../modules/connectors/autonote-approval.js";
import type { AutoNoteTasks } from "../../modules/connectors/autonote-tasks.js";
import type { CompanionPrivateRelay } from "./private-relay.js";
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const base = { operationId: z.uuid(), expectedRevision: revision };
const request = z.discriminatedUnion("action", [
  z.strictObject({
    ...base,
    action: z.literal("grant"),
    peerId: z.uuid(),
    peerKeyEpoch: revision,
    expiresAt: revision,
  }),
  z.strictObject({
    ...base,
    action: z.literal("revoke"),
    permissionId: z.uuid(),
  }),
  z.strictObject({
    ...base,
    action: z.literal("create"),
    permissionId: z.uuid(),
  }),
  z.strictObject({
    ...base,
    action: z.literal("send"),
    offerId: z.uuid(),
    index: z.number().int().nonnegative(),
    connection: z.strictObject({ id: z.uuid(), expectedRevision: revision }),
  }),
  z.strictObject({ ...base, action: z.literal("stop"), offerId: z.uuid() }),
  z.strictObject({ ...base, action: z.literal("remove"), offerId: z.uuid() }),
]);
type Input = z.infer<typeof request>;
type Prepared = Awaited<ReturnType<PrivateAutoNoteApprovalConsent["prepare"]>>;
type Review = {
  id: string;
  input: Input;
  at: number;
  expiresAt: number;
  mono: number;
  generation: number;
  snapshot: unknown;
  prepared?: Prepared;
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const denied = () => new ApprovalOutboxError("DENIED");
/** Parent holds the shared key operation lock. No credentials or ciphertext cross HTTP. */
export class CompanionAutoNoteApprovals {
  private generation = 0;
  private review?: Review;
  constructor(
    private store: Store,
    private vault: Vault,
    private owner: Owner,
    private keys: (
      current?: () => PrivateBinding | null,
    ) => PrivateKeyLifecycle,
    private approval: AutoNoteApprovalConnector,
    private sources: AutoNoteTasks,
    private remote?: RemoteClient,
    private enabled = false,
    private now = Date.now,
    private mono = () => performance.now(),
  ) {
    this.owner = { ...owner };
  }
  invalidate() {
    this.generation++;
    this.review = undefined;
  }
  private consent(current: () => PrivateBinding | null = () => null) {
    return new PrivateAutoNoteApprovalConsent(
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
      this.approval,
      this.sources,
      this.now,
      this.mono,
    );
  }
  private outbox(consent = this.consent()) {
    return new PrivateAutoNoteApprovalOutbox(
      this.store,
      this.vault,
      this.owner,
      consent,
      this.now,
    );
  }
  status(operationId: string) {
    const saved = this.consent().list(operationId);
    return {
      available: true,
      canSetup: this.enabled && !!this.remote,
      revision: saved.revision,
      permissions: saved.grants.map((g) => ({
        id: g.id,
        peerId: g.peer.peerId,
        fingerprint: g.peer.fingerprint,
        expiresAt: g.expiresAt,
        revoked: g.revoked,
        detailHash: g.detailHash,
      })),
      offers: this.outbox().status(operationId),
    };
  }
  private live() {
    if (!this.enabled || !this.remote) throw denied();
    return this.remote;
  }
  private checkRevision(input: Input) {
    if (
      this.consent().list(input.operationId).revision !== input.expectedRevision
    )
      throw new ApprovalOutboxError("CONFLICT");
  }
  private valid(r: Review) {
    return (
      r.generation === this.generation &&
      this.now() >= r.at &&
      this.now() < r.expiresAt &&
      this.mono() >= r.mono &&
      this.mono() - r.mono < r.expiresAt - r.at
    );
  }
  private box(input: Extract<Input, { action: "send" }>) {
    const box = this.store
      .autoNoteReview(this.owner, input.operationId)
      .approvalOutboxes?.find((b) => b.id === input.offerId);
    if (!box || !box.parts[input.index] || box.state === "stopped")
      throw denied();
    return box;
  }
  async prepare(raw: unknown, relay?: CompanionPrivateRelay) {
    this.invalidate();
    const input = request.parse(raw),
      generation = this.generation,
      at = this.now(),
      mono = this.mono();
    this.checkRevision(input);
    let snapshot: unknown, prepared: Prepared | undefined;
    if (input.action === "grant") {
      prepared = await this.live().withVerifiedDevice((scope) =>
        this.consent(() =>
          generation === this.generation ? scope.current() : null,
        ).prepare(inputWithoutAction(input)),
      );
      snapshot = prepared.grant;
    } else if (input.action === "create") {
      snapshot = await this.live().withVerifiedDevice(async (scope) => {
        const handle = await this.consent(() =>
          generation === this.generation ? scope.current() : null,
        ).resolve(input.operationId, input.permissionId);
        handle.check();
        return handle.grant;
      });
    } else if (input.action === "send") {
      this.live();
      if (!relay) throw denied();
      snapshot = await relay.withTransport(
        input.connection,
        async (client, binding, limit) => {
          const box = this.box(input),
            handle = await this.consent(() =>
              generation === this.generation ? binding() : null,
            ).resolve(input.operationId, box.grant.id);
          const recipient = await client.recipient({
            endpointId: handle.grant.peer.peerId,
          });
          handle.check();
          if (
            !same(box.grant, handle.grant) ||
            box.manifest.expiresAt > Math.min(limit, recipient.expiresAt)
          )
            throw denied();
          return {
            grant: handle.grant,
            recipient,
            messageId: box.parts[input.index]!.header.messageId,
          };
        },
      );
    } else if (input.action === "revoke") {
      snapshot = this.consent()
        .list(input.operationId)
        .grants.find((g) => g.id === input.permissionId);
      if (!snapshot) throw denied();
    } else {
      snapshot = this.outbox()
        .status(input.operationId)
        .find((b) => b.id === input.offerId);
      if (!snapshot) throw denied();
    }
    this.checkRevision(input);
    if (
      generation !== this.generation ||
      this.now() < at ||
      this.now() >= at + 60000 ||
      this.mono() - mono >= 60000
    )
      throw denied();
    const r = {
      id: randomUUID(),
      input,
      at,
      mono,
      generation,
      expiresAt: Math.min(at + 60000, prepared?.expiresAt ?? Infinity),
      snapshot,
      prepared,
    };
    this.review = r;
    return {
      id: r.id,
      action: input.action,
      operationId: input.operationId,
      expiresAt: r.expiresAt,
      summary: structuredClone(snapshot),
      title: prepared?.title ?? null,
      visibility: prepared?.visibility ?? null,
      transportOnly: input.action === "send",
    };
  }
  async confirm(raw: unknown, relay?: CompanionPrivateRelay) {
    const input = z
        .strictObject({
          reviewId: z.uuid(),
          confirmed: z.literal(true),
          acknowledged: z.literal(true),
        })
        .parse(raw),
      r = this.review;
    this.review = undefined;
    if (!r || input.reviewId !== r.id || !this.valid(r)) throw denied();
    const action = r.input;
    this.checkRevision(action);
    if (action.action === "revoke")
      this.consent().revoke({
        operationId: action.operationId,
        permissionId: action.permissionId,
        expectedRevision: action.expectedRevision,
        confirmed: true,
      });
    else if (action.action === "stop")
      this.outbox().stop(action.operationId, action.offerId);
    else if (action.action === "remove")
      this.outbox().remove(action.operationId, action.offerId);
    else if (action.action === "send") {
      this.live();
      if (!relay) throw denied();
      await relay.withTransport(
        action.connection,
        async (client, binding, limit) => {
          const current = () => (this.valid(r) ? binding() : null),
            consent = this.consent(current),
            box = this.box(action);
          const handle = await consent.resolve(
              action.operationId,
              box.grant.id,
            ),
            recipient = await client.recipient({
              endpointId: handle.grant.peer.peerId,
            });
          handle.check();
          this.checkRevision(action);
          if (
            !same(r.snapshot, {
              grant: handle.grant,
              recipient,
              messageId: box.parts[action.index]!.header.messageId,
            }) ||
            box.manifest.expiresAt > Math.min(limit, recipient.expiresAt)
          )
            throw denied();
          const outbox = this.outbox(consent);
          await outbox.encrypt(action.operationId, action.offerId);
          await outbox.dispatch(
            action.operationId,
            action.offerId,
            action.index,
            async (envelope) => {
              const result = await client.submit(
                { version: 1, envelope },
                () => {
                  if (!current()) throw denied();
                  handle.check();
                },
              );
              return result.receipt;
            },
          );
        },
      );
    } else
      await this.live().withVerifiedDevice(async (scope) => {
        const current = () => (this.valid(r) ? scope.current() : null),
          consent = this.consent(current);
        if (action.action === "grant") {
          const fresh = await consent.prepare(inputWithoutAction(action));
          const normalized = (g: Prepared["grant"]) => {
            const { id, approvedAt, ...rest } = g;
            return rest;
          };
          if (
            !same(normalized(fresh.grant), normalized(r.prepared!.grant)) ||
            !current()
          )
            throw denied();
          await consent.approve({
            reviewId: fresh.id,
            expectedRevision: action.expectedRevision,
            confirmed: true,
            acknowledged: true,
          });
        } else {
          const handle = await consent.resolve(
            action.operationId,
            action.permissionId,
          );
          handle.check();
          if (!same(r.snapshot, handle.grant) || !current()) throw denied();
          const outbox = this.outbox(consent);
          const offer = await outbox.prepare({
            operationId: action.operationId,
            permissionId: action.permissionId,
            expectedRevision: action.expectedRevision,
            clientRequestId: r.id,
            confirmed: true,
          });
          await outbox.encrypt(action.operationId, offer.id);
        }
      });
    return this.status(action.operationId);
  }
}
function inputWithoutAction(input: Extract<Input, { action: "grant" }>) {
  const { action, ...rest } = input;
  return rest;
}
