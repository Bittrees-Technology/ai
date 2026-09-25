import { randomUUID } from "node:crypto";
import { reservePrivateSequence } from "./private-send-sequence.js";
import {
  privateRelayStorageReceiptSchema,
  privateRelayEnvelopeHash,
} from "./private-relay-contracts.js";
import { z } from "zod";
import type { Store, Owner } from "../storage/store.js";
import type { Vault } from "../storage/vault.js";
import type { AutoNoteApprovalConnector } from "../connectors/autonote-approval.js";
import type { PrivateAutoNoteApprovalConsent } from "./private-autonote-approval-consent.js";
import {
  privateEnvelopeSchema,
  privateEnvelopeSuite,
  sealPrivateEnvelope,
  type PrivateEnvelope,
  openPrivateEnvelope,
} from "./private-envelope.js";
import { autoNoteApprovalDecisionSchema } from "./private-autonote-approval-contracts.js";
import {
  autoNoteRetainedDecisionsSchema,
  autoNoteRetainedDecisionSchema,
  type AutoNoteRetainedDecision as Entry,
} from "./private-autonote-decisions-state.js";
import { privateReplayIdentity } from "./private-replay.js";
import { consumePrivateIncomingReplay } from "./private-incoming-replay.js";
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export class AutoNoteDecisionError extends Error {
  constructor(readonly code: "DENIED" | "CONFLICT") {
    super(code);
  }
}
const denied = () => new AutoNoteDecisionError("DENIED");
/** Internal Mac ledger. Reception never saves. Explicit execution rechecks exact source authority. */
export class PrivateAutoNoteDecisions {
  private active = new Set<string>();
  constructor(
    private store: Store,
    private vault: Vault,
    private owner: Owner,
    private consent: PrivateAutoNoteApprovalConsent,
    private approval: AutoNoteApprovalConnector,
    private now = Date.now,
  ) {
    this.owner = { ...owner };
  }
  get busy() {
    return this.active.size > 0;
  }
  private async exclusive<T>(operationId: string, fn: () => Promise<T>) {
    if (this.active.has(operationId))
      throw new AutoNoteDecisionError("CONFLICT");
    this.active.add(operationId);
    try {
      return await fn();
    } finally {
      this.active.delete(operationId);
    }
  }
  private list(operationId: string) {
    return autoNoteRetainedDecisionsSchema.parse(
      this.store.autoNoteReview(this.owner, operationId).approvalDecisions ??
        [],
    );
  }
  private get(operationId: string, decisionId: string) {
    const entry = this.list(operationId).find(
      (e) => e.command.id === decisionId,
    );
    if (!entry) throw denied();
    return entry;
  }
  private save(operationId: string, entry: Entry, revision: number) {
    const entries = this.list(operationId),
      index = entries.findIndex((e) => e.command.id === entry.command.id);
    if (index < 0) entries.push(entry);
    else entries[index] = entry;
    return this.store.setAutoNoteApprovalDecisions(
      this.owner,
      operationId,
      revision,
      entries,
    );
  }
  status(operationId: string) {
    return this.list(operationId).map((e) => ({
      decisionId: e.command.id,
      offerId: e.command.offerId,
      decision: e.command.decision,
      state: e.state,
      result: e.result,
      resultDeliveries: (e.resultDeliveries ?? []).map((d) => ({
        messageId: d.header.messageId,
        status: d.result.status,
        encrypted: !!d.envelope,
        attempts: d.attempts,
        transport: d.transport,
      })),
    }));
  }
  async receive(raw: unknown, deliveryCheck: () => void = () => {}) {
    const input = z
      .strictObject({
        operationId: z.uuid(),
        permissionId: z.uuid(),
        envelope: privateEnvelopeSchema,
        confirmed: z.literal(true),
      })
      .parse(raw);
    return this.exclusive(input.operationId, async () => {
      const handle = await this.consent.resolvePeer(
          input.operationId,
          input.permissionId,
        ),
        g = handle.grant,
        h = input.envelope.header;
      const check = () => {
        deliveryCheck();
        handle.check();
        if (this.now() < h.issuedAt || this.now() >= h.expiresAt)
          throw denied();
      };
      if (
        h.ownerId !== g.local.binding.ownerId ||
        h.recipientId !== g.local.binding.deviceId ||
        h.senderId !== g.peer.peerId ||
        h.recipientKeyEpoch !== g.local.keyEpoch ||
        h.senderKeyEpoch !== g.peer.keyEpoch
      )
        throw denied();
      const opened = await openPrivateEnvelope(
        input.envelope,
        h,
        {
          recipientKey: handle.localKey,
          senderPublicKey: handle.peerPublicKey,
        },
        this.now,
      );
      let command: z.infer<typeof autoNoteApprovalDecisionSchema>;
      try {
        command = autoNoteApprovalDecisionSchema.parse(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(opened.plaintext),
          ),
        );
      } finally {
        opened.plaintext.fill(0);
      }
      check();
      const replay = await privateReplayIdentity(input.envelope, command.type),
        prior = this.list(input.operationId).find(
          (e) => e.command.id === command.id,
        );
      if (prior) {
        if (!same(prior.envelope, input.envelope) || !same(prior.grant, g))
          throw new AutoNoteDecisionError("CONFLICT");
        return this.store.db
          .transaction(() => {
            check();
            const latest = this.get(input.operationId, command.id);
            if (
              !same(latest, prior) ||
              consumePrivateIncomingReplay(
                this.store,
                this.vault,
                this.owner,
                replay,
                { collection: "autonote_reviews", id: input.operationId },
              ) !== "duplicate"
            )
              throw new AutoNoteDecisionError("CONFLICT");
            return { duplicate: true, state: latest.state };
          })
          .immediate();
      }
      const source = await this.consent.resolve(
        input.operationId,
        input.permissionId,
      );
      source.check();
      check();
      return this.store.db
        .transaction(() => {
          source.check();
          check();
          const item = this.store.autoNoteReview(this.owner, input.operationId),
            box = item.approvalOutboxes?.find((b) => b.id === command.offerId);
          if (
            !box ||
            box.state === "stopped" ||
            !same(box.grant, g) ||
            this.list(input.operationId).some(
              (e) => e.command.offerId === command.offerId,
            )
          )
            throw denied();
          const entry = autoNoteRetainedDecisionSchema.parse({
            command,
            manifest: box.manifest,
            grant: g,
            envelope: input.envelope,
            state: command.decision === "approve" ? "accepted" : "rejected",
            result:
              command.decision === "approve"
                ? null
                : {
                    version: 1,
                    type: "autonote.approval.receipt",
                    decisionId: command.id,
                    offerId: command.offerId,
                    detailHash: command.detailHash,
                    status: "rejected",
                    receipt: null,
                  },
          });
          if (
            consumePrivateIncomingReplay(
              this.store,
              this.vault,
              this.owner,
              replay,
              { collection: "autonote_reviews", id: input.operationId },
            ) !== "new"
          )
            throw new AutoNoteDecisionError("CONFLICT");
          this.save(input.operationId, entry, item.revision);
          return { duplicate: false, state: entry.state };
        })
        .immediate();
    });
  }
  async execute(raw: unknown) {
    const input = z
      .strictObject({
        operationId: z.uuid(),
        decisionId: z.uuid(),
        confirmed: z.literal(true),
      })
      .parse(raw);
    return this.exclusive(input.operationId, async () => {
      const entry = this.get(input.operationId, input.decisionId);
      if (entry.state !== "accepted" || entry.command.decision !== "approve")
        throw denied();
      const handle = await this.consent.resolve(
        input.operationId,
        entry.grant.id,
      );
      const check = () => {
        handle.check();
        if (
          this.now() < entry.envelope.header.issuedAt ||
          this.now() >= entry.envelope.header.expiresAt ||
          !same(handle.grant, entry.grant) ||
          !same(this.get(input.operationId, input.decisionId), entry)
        )
          throw denied();
      };
      check();
      const replay = await privateReplayIdentity(
        entry.envelope,
        entry.command.type,
      );
      const receipt = await this.approval.saveExact(
        entry.grant.grantId,
        entry.grant.sourceApprovalId,
        handle.detail,
        () => {
          this.store.db
            .transaction(() => {
              check();
              if (
                consumePrivateIncomingReplay(
                  this.store,
                  this.vault,
                  this.owner,
                  replay,
                  { collection: "autonote_reviews", id: input.operationId },
                ) !== "duplicate"
              )
                throw denied();
              const item = this.store.autoNoteReview(
                this.owner,
                input.operationId,
              );
              const marked = this.store.markAutoNoteApprovalAttempt(
                this.owner,
                input.operationId,
                item.revision,
                {
                  approvalId: entry.grant.sourceApprovalId,
                  reviewedHash: entry.grant.detailHash,
                  requestedAt: new Date(this.now()).toISOString(),
                },
              );
              this.save(
                input.operationId,
                {
                  ...entry,
                  state: "uncertain",
                  result: {
                    version: 1,
                    type: "autonote.approval.receipt",
                    decisionId: entry.command.id,
                    offerId: entry.command.offerId,
                    detailHash: entry.command.detailHash,
                    status: "uncertain",
                    receipt: null,
                  },
                },
                marked.revision,
              );
            })
            .immediate();
        },
      );
      // A successful source write can change source state or race revocation; retain the receipt.
      this.store.db
        .transaction(() => {
          const item = this.store.autoNoteReview(this.owner, input.operationId),
            current = this.get(input.operationId, input.decisionId);
          if (
            current.state !== "uncertain" ||
            !same(current.envelope, entry.envelope)
          )
            throw new AutoNoteDecisionError("CONFLICT");
          const settled = this.store.settleAutoNoteReview(
            this.owner,
            input.operationId,
            item.revision,
            { response: { ...item.response!, receipt, deleted: false } },
          );
          this.save(
            input.operationId,
            {
              ...current,
              state: "saved",
              result: { ...current.result!, status: "saved", receipt },
            },
            settled.revision,
          );
        })
        .immediate();
      return this.status(input.operationId);
    });
  }
  async prepareResult(raw: unknown) {
    const input = z
      .strictObject({
        operationId: z.uuid(),
        decisionId: z.uuid(),
        confirmed: z.literal(true),
      })
      .parse(raw);
    return this.exclusive(input.operationId, async () => {
      let entry = this.get(input.operationId, input.decisionId);
      if (!entry.result) throw denied();
      const handle = await this.consent.resolvePeer(
        input.operationId,
        entry.grant.id,
      );
      const check = () => {
        handle.check();
        if (
          !same(handle.grant, entry.grant) ||
          !same(this.get(input.operationId, input.decisionId), entry) ||
          this.now() >= entry.manifest.expiresAt
        )
          throw denied();
      };
      check();
      let delivery = entry.resultDeliveries?.find((d) =>
        same(d.result, entry.result),
      );
      if (!delivery) {
        this.store.db
          .transaction(() => {
            check();
            const item = this.store.autoNoteReview(
              this.owner,
              input.operationId,
            );
            const channel = {
              ownerId: entry.grant.local.binding.ownerId,
              senderId: entry.grant.local.binding.deviceId,
              recipientId: entry.grant.peer.peerId,
              senderKeyEpoch: entry.grant.local.keyEpoch,
              recipientKeyEpoch: entry.grant.peer.keyEpoch,
            };
            const id = randomUUID();
            delivery = {
              result: entry.result!,
              header: {
                version: 1,
                suite: privateEnvelopeSuite,
                ...channel,
                messageId: id,
                operationId: id,
                sequence: reservePrivateSequence(
                  this.store,
                  this.vault,
                  this.owner,
                  channel,
                ),
                issuedAt: this.now(),
                expiresAt: entry.manifest.expiresAt,
              },
              envelope: null,
              attempts: 0,
              transport: null,
            };
            this.save(
              input.operationId,
              {
                ...entry,
                resultDeliveries: [...(entry.resultDeliveries ?? []), delivery],
              },
              item.revision,
            );
          })
          .immediate();
        entry = this.get(input.operationId, input.decisionId);
      }
      if (!delivery!.envelope) {
        const bytes = new TextEncoder().encode(
          JSON.stringify(delivery!.result),
        );
        let envelope: PrivateEnvelope;
        try {
          envelope = await sealPrivateEnvelope(
            delivery!.header,
            bytes,
            {
              senderKey: handle.localKey,
              recipientPublicKey: handle.peerPublicKey,
            },
            this.now,
          );
        } finally {
          bytes.fill(0);
        }
        this.store.db
          .transaction(() => {
            check();
            const item = this.store.autoNoteReview(
              this.owner,
              input.operationId,
            );
            this.save(
              input.operationId,
              {
                ...entry,
                resultDeliveries: entry.resultDeliveries!.map((d) =>
                  d.header.messageId === delivery!.header.messageId
                    ? { ...d, envelope }
                    : d,
                ),
              },
              item.revision,
            );
          })
          .immediate();
      }
      return this.status(input.operationId);
    });
  }
  async sendResult(
    raw: unknown,
    upload: (envelope: PrivateEnvelope, check: () => void) => Promise<unknown>,
  ) {
    const input = z
      .strictObject({
        operationId: z.uuid(),
        decisionId: z.uuid(),
        messageId: z.uuid(),
        confirmed: z.literal(true),
      })
      .parse(raw);
    return this.exclusive(input.operationId, async () => {
      let entry = this.get(input.operationId, input.decisionId);
      const delivery = entry.resultDeliveries?.find(
        (d) => d.header.messageId === input.messageId,
      );
      if (!delivery?.envelope || !same(delivery.result, entry.result))
        throw denied();
      const handle = await this.consent.resolvePeer(
        input.operationId,
        entry.grant.id,
      );
      const check = () => {
        handle.check();
        if (
          !same(handle.grant, entry.grant) ||
          !same(this.get(input.operationId, input.decisionId), entry) ||
          this.now() < delivery.header.issuedAt ||
          this.now() >= delivery.header.expiresAt
        )
          throw denied();
      };
      this.store.db
        .transaction(() => {
          check();
          const item = this.store.autoNoteReview(this.owner, input.operationId);
          this.save(
            input.operationId,
            {
              ...entry,
              resultDeliveries: entry.resultDeliveries!.map((d) =>
                d.header.messageId === input.messageId
                  ? { ...d, attempts: d.attempts + 1 }
                  : d,
              ),
            },
            item.revision,
          );
        })
        .immediate();
      entry = this.get(input.operationId, input.decisionId);
      const receipt = privateRelayStorageReceiptSchema.parse(
        await upload(delivery.envelope, check),
      );
      if (
        receipt.messageId !== input.messageId ||
        receipt.envelopeHash !==
          (await privateRelayEnvelopeHash(delivery.envelope)) ||
        receipt.storedAt < delivery.header.issuedAt ||
        receipt.storedAt > this.now() ||
        !["stored", "received"].includes(receipt.state)
      )
        throw denied();
      this.store.db
        .transaction(() => {
          const item = this.store.autoNoteReview(this.owner, input.operationId),
            current = this.get(input.operationId, input.decisionId);
          const retained = current.resultDeliveries?.find(
            (d) => d.header.messageId === input.messageId,
          );
          if (
            !retained ||
            !same(
              retained,
              entry.resultDeliveries!.find(
                (d) => d.header.messageId === input.messageId,
              ),
            )
          )
            throw new AutoNoteDecisionError("CONFLICT");
          this.save(
            input.operationId,
            {
              ...current,
              resultDeliveries: current.resultDeliveries!.map((d) =>
                d.header.messageId === input.messageId
                  ? { ...d, transport: receipt }
                  : d,
              ),
            },
            item.revision,
          );
        })
        .immediate();
      return this.status(input.operationId);
    });
  }
  /** Called after the existing source-owned read-credential reconciliation path. Never retries a write. */
  recordReconciled(operationId: string, decisionId: string) {
    if (this.active.has(operationId))
      throw new AutoNoteDecisionError("CONFLICT");
    return this.store.db
      .transaction(() => {
        const item = this.store.autoNoteReview(this.owner, operationId),
          entry = this.get(operationId, decisionId);
        if (
          entry.state !== "uncertain" ||
          item.state !== "saved" ||
          !item.response?.receipt ||
          item.approvalAttempt?.approvalId !== entry.grant.sourceApprovalId ||
          item.approvalAttempt.reviewedHash !== entry.command.detailHash
        )
          throw denied();
        this.save(
          operationId,
          {
            ...entry,
            state: "saved",
            result: {
              ...entry.result!,
              status: "saved",
              receipt: item.response.receipt,
            },
          },
          item.revision,
        );
        return this.status(operationId);
      })
      .immediate();
  }
}
