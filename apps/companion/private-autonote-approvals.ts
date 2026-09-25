import { PrivateAutoNoteDecisions } from "../../modules/remote/private-autonote-decisions.js";
import { AutoNoteReviews } from "../../modules/connectors/autonote-reviews.js";
import { privateRelayPageSchema } from "../../modules/remote/private-relay-contracts.js";
import {
  relayQueueReview,
  relaySelectionMatches,
} from "../../modules/remote/private-relay-queue.js";
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
import type { AutoNoteConnector } from "../../modules/connectors/autonote.js";
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
    index: z.number().int().nonnegative().optional(),
    connection: z.strictObject({ id: z.uuid(), expectedRevision: revision }),
  }),
  z.strictObject({
    ...base,
    action: z.literal("receive"),
    permissionId: z.uuid(),
    connection: z.strictObject({ id: z.uuid(), expectedRevision: revision }),
    after: privateRelayPageSchema.shape.after,
  }),
  z.strictObject({
    ...base,
    action: z.literal("execute"),
    decisionId: z.uuid(),
  }),
  z.strictObject({
    ...base,
    action: z.literal("reconcile"),
    decisionId: z.uuid(),
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
    private source?: AutoNoteConnector,
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
  private decisions(consent = this.consent()) {
    return new PrivateAutoNoteDecisions(
      this.store,
      this.vault,
      this.owner,
      consent,
      this.approval,
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
      decisions: this.decisions().status(operationId),
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
    if (
      !box ||
      (input.index !== undefined && !box.parts[input.index]) ||
      box.state === "stopped"
    )
      throw denied();
    return box;
  }
  private parts(
    box: NonNullable<
      ReturnType<Store["autoNoteReview"]>["approvalOutboxes"]
    >[number],
    index?: number,
  ) {
    const parts =
      index === undefined
        ? box.parts.filter((p) => !p.receipt)
        : [box.parts[index]!];
    if (!parts.length) throw denied();
    return parts;
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
    } else if (input.action === "receive") {
      this.live();
      if (!relay) throw denied();
      snapshot = await relay.withTransport(
        input.connection,
        async (client, binding) => {
          const handle = await this.consent(() =>
            generation === this.generation ? binding() : null,
          ).resolvePeer(input.operationId, input.permissionId);
          const page = await client.poll({ after: input.after, limit: 1 });
          handle.check();
          const item = relayQueueReview(page.items[0]);
          if (!item) throw denied();
          return { grant: handle.grant, item, nextCursor: page.nextCursor };
        },
      );
    } else if (input.action === "execute") {
      snapshot = await this.live().withVerifiedDevice(async (scope) => {
        const consent = this.consent(() =>
          generation === this.generation ? scope.current() : null,
        );
        const decision = this.decisions(consent)
          .status(input.operationId)
          .find((d) => d.decisionId === input.decisionId);
        const entry = this.store
          .autoNoteReview(this.owner, input.operationId)
          .approvalDecisions?.find((d) => d.command.id === input.decisionId);
        if (!decision || !entry || decision.state !== "accepted")
          throw denied();
        const handle = await consent.resolve(input.operationId, entry.grant.id);
        handle.check();
        return { decision, grant: handle.grant };
      });
    } else if (input.action === "reconcile") {
      snapshot = this.decisions()
        .status(input.operationId)
        .find(
          (d) => d.decisionId === input.decisionId && d.state === "uncertain",
        );
      if (!snapshot) throw denied();
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
            messageIds: this.parts(box, input.index).map(
              (p) => p.header.messageId,
            ),
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
    else if (action.action === "reconcile") {
      if (
        !same(
          r.snapshot,
          this.decisions()
            .status(action.operationId)
            .find((d) => d.decisionId === action.decisionId),
        )
      )
        throw denied();
      if (!this.source) throw denied();
      const ledger = new AutoNoteReviews(
        this.store,
        this.owner,
        this.source,
        this.sources,
        this.approval,
      );
      await ledger.reconcile(action.operationId);
      this.decisions().recordReconciled(action.operationId, action.decisionId);
    } else if (action.action === "execute") {
      await this.live().withVerifiedDevice(async (scope) => {
        const consent = this.consent(() =>
          this.valid(r) ? scope.current() : null,
        );
        const decision = this.decisions(consent)
          .status(action.operationId)
          .find((d) => d.decisionId === action.decisionId);
        if (!same(decision, (r.snapshot as any).decision)) throw denied();
        await this.decisions(consent).execute({
          operationId: action.operationId,
          decisionId: action.decisionId,
          confirmed: true,
        });
      });
    } else if (action.action === "receive") {
      this.live();
      if (!relay) throw denied();
      await relay.withTransport(action.connection, async (client, binding) => {
        const current = () => (this.valid(r) ? binding() : null);
        const page = await client.poll({ after: action.after, limit: 1 });
        const item = page.items[0],
          snapshot = r.snapshot as any;
        this.checkRevision(action);
        if (
          !current() ||
          !item ||
          !relaySelectionMatches(item, snapshot.item.selection)
        )
          throw denied();
        await this.decisions(this.consent(current)).receive(
          {
            operationId: action.operationId,
            permissionId: action.permissionId,
            envelope: item.envelope,
            confirmed: true,
          },
          () => {
            if (!current()) throw denied();
          },
        );
        if (!current()) throw denied();
        await client.acknowledge({
          messageId: item.receipt.messageId,
          envelopeHash: item.receipt.envelopeHash,
          expectedRevision: item.receipt.revision,
          confirmed: true,
        });
      });
    } else if (action.action === "send") {
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
              messageIds: this.parts(box, action.index).map(
                (p) => p.header.messageId,
              ),
            }) ||
            box.manifest.expiresAt > Math.min(limit, recipient.expiresAt)
          )
            throw denied();
          const outbox = this.outbox(consent);
          await outbox.encrypt(action.operationId, action.offerId);
          for (const part of this.parts(box, action.index)) {
            const index = box.parts.findIndex(
              (p) => p.header.messageId === part.header.messageId,
            );
            await outbox.dispatch(
              action.operationId,
              action.offerId,
              index,
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
          }
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
