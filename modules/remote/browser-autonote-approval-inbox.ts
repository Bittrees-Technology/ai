import {
  privateRelayStorageReceiptSchema,
  privateRelayEnvelopeHash,
} from "./private-relay-contracts.js";
import {
  openBrowserAutoNoteDecisionRow,
  readBrowserAutoNoteDecisionRow,
  type BrowserAutoNoteDecisionEntry,
  sealBrowserAutoNoteDecisionRow,
} from "./browser-autonote-decision-state.js";
import { z } from "zod";
import {
  BrowserKeyLifecycle,
  browserKeyProofSchema,
} from "./browser-key-lifecycle.js";
import { BrowserPeerEnrollment } from "./browser-peers.js";
import { browserPeerProofSchema } from "./browser-peer-state.js";
import { browserKeyScope } from "./browser-key-state.js";
import { openBrowserPrivateDatabase } from "./browser-outbox-migration.js";
import {
  browserStorageTransaction,
  type BrowserStorageIO,
} from "./browser-storage.js";
import {
  browserStoredKeyMatches,
  browserStoredPeerMatches,
} from "./browser-private-authority.js";
import { browserStoredCheckMatches } from "./browser-peer-checks.js";
import {
  browserPrivateChannel,
  browserOutboxChannelSchema,
  reserveBrowserSequence,
  browserPrivateDigest,
  browserPrivateIdentity,
  BrowserOutboxError,
} from "./browser-outbox-state.js";
import {
  consumeBrowserIncomingReplay,
  browserIncomingReplaySchema,
} from "./browser-incoming-replay.js";
import { privateReplayIdentity } from "./private-replay.js";
import {
  type PrivateEnvelope,
  privateEnvelopeSuite,
  sealPrivateEnvelope,
  privateEnvelopeSchema,
  openPrivateEnvelope,
} from "./private-envelope.js";
import type { PrivateBinding } from "./private-peer-contracts.js";
import {
  autoNoteApprovalDecisionSchema,
  autoNoteApprovalManifestSchema,
  autoNoteApprovalChunkSchema,
} from "./private-autonote-approval-contracts.js";
import { assembleAutoNoteApproval } from "./private-autonote-approval-content.js";
const name = "autonote_approval_inbox";
const decisionStore = "autonote_approval_decisions";
const stores = [
  name,
  "lifecycle",
  "slots",
  "peers",
  "peer_checks",
  "incoming_replay",
];
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const rowSchema = z.strictObject({
  scope: hex,
  id: hex,
  offer: hex,
  index: z.number().int().min(-1).max(122),
  local: browserKeyProofSchema,
  peer: browserPeerProofSchema,
  envelope: privateEnvelopeSchema,
});
type Row = z.infer<typeof rowSchema>;
const packetSchema = z.union([
  autoNoteApprovalManifestSchema,
  autoNoteApprovalChunkSchema,
]);
type Packet = z.infer<typeof packetSchema>;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const fail = () => new BrowserOutboxError("DENIED");
/** Internal explicitly requested receiver. Retains only ciphertext and public proof metadata.
 * Receiving/revealing is not approval and never emits a source-write decision. */
export class BrowserAutoNoteApprovalInbox {
  private closed = false;
  private busy = false;
  private generation = 0;
  private constructor(
    private db: IDBDatabase,
    private owner: string,
    private scope: string,
    private current: () => PrivateBinding | null,
    private keys: BrowserKeyLifecycle,
    private peers: BrowserPeerEnrollment,
    private now: () => number,
    private mono: () => number,
  ) {
    db.onversionchange = () => this.close();
    db.onclose = () => {
      this.closed = true;
      this.invalidate();
    };
  }
  static async open(
    owner: string,
    current: () => PrivateBinding | null,
    keys: BrowserKeyLifecycle,
    peers: BrowserPeerEnrollment,
    now = Date.now,
    mono = () => performance.now(),
  ) {
    const scope = await browserKeyScope(owner),
      db = await openBrowserPrivateDatabase();
    if (!db.objectStoreNames.contains(name)) {
      db.close();
      throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
    }
    return new BrowserAutoNoteApprovalInbox(
      db,
      owner,
      scope,
      current,
      keys,
      peers,
      now,
      mono,
    );
  }
  invalidate() {
    this.generation++;
    this.decisionReview = undefined;
  }
  close() {
    this.closed = true;
    this.invalidate();
    this.db.close();
  }
  private async exclusive<T>(
    fn: (check: () => void) => Promise<T>,
    requireIdentity = true,
  ) {
    if (this.busy) throw new BrowserOutboxError("CONFLICT");
    this.busy = true;
    const generation = this.generation,
      at = this.now(),
      mono = this.mono(),
      binding = this.current();
    const check = () => {
      if (
        this.closed ||
        generation !== this.generation ||
        (requireIdentity &&
          (!binding ||
            !same(binding, this.current()) ||
            this.now() >= binding.expiresAt)) ||
        this.now() < at ||
        this.mono() < mono ||
        this.mono() - mono >=
          Math.min(
            120000,
            requireIdentity && binding ? binding.expiresAt - at : 120000,
          )
      )
        throw fail();
    };
    try {
      check();
      return await fn(check);
    } finally {
      this.busy = false;
    }
  }
  private maintenance<T>(fn: (check: () => void) => Promise<T>) {
    return this.exclusive(fn, false);
  }
  private async proof(peerId: string, epoch: number, check: () => void) {
    const local = await this.keys.resolve(),
      peer = await this.peers.resolve(peerId, epoch);
    check();
    if (
      !same(local.proof.binding, this.current()) ||
      !same(local.proof, peer.proof.key)
    )
      throw fail();
    const identity = await browserPrivateIdentity(local.proof.binding);
    check();
    return { local, peer, identity };
  }
  private validate<T>(
    io: BrowserStorageIO<T>,
    p: Awaited<ReturnType<BrowserAutoNoteApprovalInbox["proof"]>>,
    next: () => void,
  ) {
    io.request(io.store("lifecycle").get(this.scope), (metadata) =>
      io.request(
        io.store("slots").get([this.scope, p.local.proof.keyId]),
        (slot) => {
          if (
            !browserStoredKeyMatches(
              metadata,
              slot,
              this.owner,
              this.scope,
              p.local.proof,
            )
          )
            throw fail();
          io.request(io.store("peers").get(this.scope), (peer) => {
            if (!browserStoredPeerMatches(peer, this.scope, p.peer.proof))
              throw fail();
            io.request(
              io.store("peer_checks").index("scope").getAll(this.scope, 258),
              (rows) => {
                if (
                  !browserStoredCheckMatches(
                    rows,
                    this.scope,
                    p.identity.deviceHash,
                    p.local.proof,
                    p.peer.proof,
                    this.now(),
                  )
                )
                  throw fail();
                next();
              },
            );
          });
        },
      ),
    );
  }
  private rows<T>(
    io: BrowserStorageIO<T>,
    offer: string,
    done: (rows: Row[]) => void,
  ) {
    io.request(
      io.store(name).index("offer").getAll([this.scope, offer], 125),
      (raw) => {
        const rows = raw.map((v) => rowSchema.parse(v));
        if (
          rows.length > 124 ||
          rows.some((r) => r.scope !== this.scope || r.offer !== offer)
        )
          throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
        done(rows.sort((a, b) => a.index - b.index));
      },
    );
  }
  private async replayRows(rows: Row[], scope: string) {
    return Promise.all(
      rows.map(async (row) => ({
        scope,
        ...(await privateReplayIdentity(
          row.envelope,
          row.index === -1
            ? "autonote.approval.offer"
            : "autonote.approval.chunk",
        )),
        outcome: { store: name, key: [this.scope, row.id] },
      })),
    );
  }
  private retained<T>(
    io: BrowserStorageIO<T>,
    rows: Awaited<ReturnType<BrowserAutoNoteApprovalInbox["replayRows"]>>,
    next: () => void,
  ) {
    const read = (i: number) => {
      const row = rows[i];
      if (!row) return next();
      io.request(
        io.store("incoming_replay").get([row.scope, row.operation]),
        (raw) => {
          if (!same(browserIncomingReplaySchema.parse(raw), row)) throw fail();
          read(i + 1);
        },
      );
    };
    read(0);
  }
  private async openPacket(
    envelope: z.infer<typeof privateEnvelopeSchema>,
    p: Awaited<ReturnType<BrowserAutoNoteApprovalInbox["proof"]>>,
    check: () => void,
  ): Promise<Packet> {
    const h = envelope.header,
      b = p.local.proof.binding;
    if (
      h.ownerId !== b.ownerId ||
      h.recipientId !== b.deviceId ||
      h.recipientKeyEpoch !== p.local.proof.keyEpoch ||
      h.senderId !== p.peer.proof.peerId ||
      h.senderKeyEpoch !== p.peer.proof.keyEpoch
    )
      throw fail();
    const opened = await openPrivateEnvelope(
      envelope,
      h,
      { recipientKey: p.local.pair, senderPublicKey: p.peer.publicKey },
      this.now,
    );
    try {
      const packet = packetSchema.parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(opened.plaintext),
        ),
      );
      if (
        h.operationId !==
        (packet.type === "autonote.approval.offer" ? packet.offerId : packet.id)
      )
        throw fail();
      check();
      return packet;
    } finally {
      opened.plaintext.fill(0);
    }
  }
  async receive(raw: unknown, deliveryCheck: () => void = () => {}) {
    const input = z
      .strictObject({
        envelope: privateEnvelopeSchema,
        confirmed: z.literal(true),
      })
      .parse(raw);
    return this.exclusive(async (localCheck) => {
      const check = () => {
        localCheck();
        deliveryCheck();
      };
      check();
      const h = input.envelope.header,
        p = await this.proof(h.senderId, h.senderKeyEpoch, check);
      const packet = await this.openPacket(input.envelope, p, check),
        offer = await browserPrivateDigest([
          "autonote-offer:v1",
          packet.offerId,
        ]);
      const replay = await privateReplayIdentity(input.envelope, packet.type);
      const row = rowSchema.parse({
        scope: this.scope,
        id: replay.message,
        offer,
        index: packet.type === "autonote.approval.offer" ? -1 : packet.index,
        local: p.local.proof,
        peer: p.peer.proof,
        envelope: input.envelope,
      });
      const prior = await browserStorageTransaction<Row[]>(
        this.db,
        stores,
        "readonly",
        check,
        (io) => this.validate(io, p, () => this.rows(io, offer, io.done)),
      );
      const manifestRow = prior.find((r) => r.index === -1);
      const manifest =
        packet.type === "autonote.approval.offer"
          ? packet
          : manifestRow
            ? await this.openPacket(manifestRow.envelope, p, check)
            : null;
      if (
        !manifest ||
        manifest.type !== "autonote.approval.offer" ||
        manifest.offerId !== packet.offerId ||
        manifest.detailHash !== packet.detailHash ||
        manifest.expiresAt <= this.now() ||
        h.issuedAt !== manifest.issuedAt ||
        h.expiresAt !== manifest.expiresAt ||
        (packet.type === "autonote.approval.chunk" &&
          packet.index >= manifest.chunkCount)
      )
        throw fail();
      if (
        prior.some((r) => !same(r.local, row.local) || !same(r.peer, row.peer))
      )
        throw fail();
      const retained = await this.replayRows(prior, p.identity.scope);
      return browserStorageTransaction<{
        offerId: string;
        received: number;
        total: number;
        duplicate: boolean;
      }>(
        this.db,
        stores,
        "readwrite",
        () => {
          check();
          if (this.now() >= manifest.expiresAt) throw fail();
        },
        (io) =>
          this.validate(io, p, () =>
            this.retained(io, retained, () =>
              this.rows(io, offer, (rows) => {
                if (!same(rows, prior))
                  throw new BrowserOutboxError("CONFLICT");
                const old = rows.find((r) => r.index === row.index);
                if (old && !same(old, row))
                  throw new BrowserOutboxError("CONFLICT");
                io.request(
                  io.store(name).index("scope").count(this.scope),
                  (count) =>
                    io.request(io.store(name).count(), (total) => {
                      if (!old && (count >= 512 || total >= 2048))
                        throw new BrowserOutboxError("CAPACITY");
                      consumeBrowserIncomingReplay(
                        io,
                        p.identity.scope,
                        replay,
                        { store: name, key: [this.scope, row.id] },
                        !!old,
                        (state) => {
                          if (state === "new") io.store(name).add(row);
                          io.done({
                            offerId: packet.offerId,
                            received: rows.length + (old ? 0 : 1),
                            total: manifest.chunkCount + 1,
                            duplicate: state === "duplicate",
                          });
                        },
                      );
                    }),
                );
              }),
            ),
          ),
      );
    });
  }
  private async inspectOffer(offerId: string, check: () => void) {
    const offer = await browserPrivateDigest(["autonote-offer:v1", offerId]);
    const rows = await browserStorageTransaction<Row[]>(
      this.db,
      [name],
      "readonly",
      check,
      (io) => this.rows(io, offer, io.done),
    );
    const first = rows.find((r) => r.index === -1);
    if (!first) throw fail();
    const p = await this.proof(first.peer.peerId, first.peer.keyEpoch, check);
    if (
      rows.some(
        (r) => !same(r.local, p.local.proof) || !same(r.peer, p.peer.proof),
      )
    )
      throw fail();
    const manifest = autoNoteApprovalManifestSchema.parse(
      await this.openPacket(first.envelope, p, check),
    );
    if (manifest.offerId !== offerId) throw fail();
    const chunks = [];
    for (const row of rows.filter((r) => r.index !== -1)) {
      const chunk = autoNoteApprovalChunkSchema.parse(
        await this.openPacket(row.envelope, p, check),
      );
      if (
        chunk.index !== row.index ||
        chunk.offerId !== manifest.offerId ||
        row.envelope.header.issuedAt !== manifest.issuedAt ||
        row.envelope.header.expiresAt !== manifest.expiresAt
      )
        throw fail();
      chunks.push(chunk);
    }
    const retained = await this.replayRows(rows, p.identity.scope);
    const detail = await assembleAutoNoteApproval(manifest, chunks, this.now);
    await browserStorageTransaction<{
      manifest: z.infer<typeof autoNoteApprovalManifestSchema>;
      detail: Awaited<ReturnType<typeof assembleAutoNoteApproval>>;
    }>(
      this.db,
      stores,
      "readonly",
      () => {
        check();
        if (this.now() >= manifest.expiresAt) throw fail();
      },
      (io) =>
        this.validate(io, p, () =>
          this.retained(io, retained, () =>
            this.rows(io, offer, (current) => {
              if (!same(current, rows))
                throw new BrowserOutboxError("CONFLICT");
              io.done({ manifest, detail });
            }),
          ),
        ),
    );
    return { manifest, detail, p, rows, retained, offer };
  }
  async reveal(raw: unknown) {
    const input = z
      .strictObject({ offerId: z.uuid(), confirmed: z.literal(true) })
      .parse(raw);
    return this.exclusive(async (check) => {
      const { manifest, detail } = await this.inspectOffer(
        input.offerId,
        check,
      );
      return { manifest, detail };
    });
  }
  private decisionReview?: {
    id: string;
    decision: "approve" | "reject";
    at: number;
    mono: number;
    expiresAt: number;
    inspected: Awaited<
      ReturnType<BrowserAutoNoteApprovalInbox["inspectOffer"]>
    >;
  };
  async prepareDecision(raw: unknown) {
    const input = z
      .strictObject({
        offerId: z.uuid(),
        decision: z.enum(["approve", "reject"]),
        confirmed: z.literal(true),
      })
      .parse(raw);
    this.decisionReview = undefined;
    return this.exclusive(async (check) => {
      const inspected = await this.inspectOffer(input.offerId, check);
      const review = {
        id: crypto.randomUUID(),
        decision: input.decision,
        at: this.now(),
        mono: this.mono(),
        expiresAt: Math.min(this.now() + 60000, inspected.manifest.expiresAt),
        inspected,
      };
      check();
      this.decisionReview = review;
      return {
        id: review.id,
        decision: review.decision,
        expiresAt: review.expiresAt,
        manifest: inspected.manifest,
        detail: inspected.detail,
      };
    });
  }
  async confirmDecision(raw: unknown) {
    const input = z
      .strictObject({
        reviewId: z.uuid(),
        confirmed: z.literal(true),
        acknowledged: z.literal(true),
      })
      .parse(raw);
    const review = this.decisionReview;
    this.decisionReview = undefined;
    if (!review || review.id !== input.reviewId) throw fail();
    return this.exclusive(async (operationCheck) => {
      const check = () => {
        operationCheck();
        if (
          this.now() < review.at ||
          this.now() >= review.expiresAt ||
          this.mono() < review.mono ||
          this.mono() - review.mono >= review.expiresAt - review.at
        )
          throw fail();
      };
      const inspected = await this.inspectOffer(
          review.inspected.manifest.offerId,
          check,
        ),
        { p, manifest, offer } = inspected;
      if (
        !same(manifest, review.inspected.manifest) ||
        !same(inspected.detail, review.inspected.detail) ||
        !same(p.local.proof, review.inspected.p.local.proof) ||
        !same(p.peer.proof, review.inspected.p.peer.proof)
      )
        throw fail();
      const channel = await browserPrivateChannel(p.identity, {
        senderKeyEpoch: p.local.proof.keyEpoch,
        peerId: p.peer.proof.peerId,
        peerKeyEpoch: p.peer.proof.keyEpoch,
      });
      const sequence = await browserStorageTransaction<number>(
        this.db,
        ["channels"],
        "readonly",
        check,
        (io) => {
          io.request(
            io.store("channels").get([p.identity.scope, channel]),
            (raw) => {
              const value =
                raw === undefined
                  ? { scope: p.identity.scope, channel, next: 1 }
                  : browserOutboxChannelSchema.parse(raw);
              if (value.scope !== p.identity.scope || value.channel !== channel)
                throw fail();
              io.done(value.next);
            },
          );
        },
      );
      const command = autoNoteApprovalDecisionSchema.parse({
        version: 1,
        type: "autonote.approval.decision",
        id: crypto.randomUUID(),
        offerId: manifest.offerId,
        permissionId: manifest.permissionId,
        detailHash: manifest.detailHash,
        proposalDigest: manifest.proposalDigest,
        decision: review.decision,
        confirmed: true,
        issuedAt: this.now(),
      });
      const plaintext = new TextEncoder().encode(JSON.stringify(command));
      let envelope;
      try {
        envelope = await sealPrivateEnvelope(
          {
            version: 1,
            suite: privateEnvelopeSuite,
            ownerId: p.local.proof.binding.ownerId,
            senderId: p.local.proof.binding.deviceId,
            recipientId: p.peer.proof.peerId,
            senderKeyEpoch: p.local.proof.keyEpoch,
            recipientKeyEpoch: p.peer.proof.keyEpoch,
            operationId: command.id,
            messageId: crypto.randomUUID(),
            sequence,
            issuedAt: command.issuedAt,
            expiresAt: Math.min(
              manifest.expiresAt,
              p.local.proof.binding.expiresAt,
            ),
          },
          plaintext,
          { senderKey: p.local.pair, recipientPublicKey: p.peer.publicKey },
          this.now,
        );
      } finally {
        plaintext.fill(0);
      }
      const row = await sealBrowserAutoNoteDecisionRow(
        {
          scope: this.scope,
          id: offer,
          deviceHash: p.identity.deviceHash,
          revision: 1,
        },
        {
          manifest,
          command,
          local: p.local.proof,
          peer: p.peer.proof,
          envelope,
          attempts: 0,
          transport: null,
          result: null,
          resultEnvelope: null,
          stopped: false,
        },
      );
      return browserStorageTransaction(
        this.db,
        [...stores, decisionStore, "channels"],
        "readwrite",
        check,
        (io) => {
          this.validate(io, p, () =>
            this.retained(io, inspected.retained, () =>
              this.rows(io, offer, (rows) => {
                if (!same(rows, inspected.rows))
                  throw new BrowserOutboxError("CONFLICT");
                io.request(
                  io.store(decisionStore).get([this.scope, offer]),
                  (old) => {
                    if (old !== undefined)
                      throw new BrowserOutboxError("CONFLICT");
                    io.request(
                      io.store(decisionStore).index("scope").count(this.scope),
                      (count) => {
                        if (count >= 64)
                          throw new BrowserOutboxError("CAPACITY");
                        io.request(io.store(decisionStore).count(), (total) => {
                          if (total >= 512)
                            throw new BrowserOutboxError("CAPACITY");
                          reserveBrowserSequence(
                            io,
                            p.identity.scope,
                            channel,
                            (actual) => {
                              if (actual !== sequence)
                                throw new BrowserOutboxError("CONFLICT");
                              io.store(decisionStore).add(row);
                              io.done({
                                decisionId: command.id,
                                offerId: manifest.offerId,
                                decision: command.decision,
                                state: "retained" as const,
                              });
                            },
                          );
                        });
                      },
                    );
                  },
                );
              }),
            ),
          );
        },
      );
    });
  }
  private async savedDecision(offerId: string, check: () => void) {
    const id = await browserPrivateDigest(["autonote-offer:v1", offerId]);
    const raw = await browserStorageTransaction<unknown>(
      this.db,
      [decisionStore],
      "readonly",
      check,
      (io) =>
        io.request(io.store(decisionStore).get([this.scope, id]), io.done),
    );
    const entry = await openBrowserAutoNoteDecisionRow(raw);
    check();
    if (
      entry.row.scope !== this.scope ||
      entry.row.id !== id ||
      entry.value.manifest.offerId !== offerId
    )
      throw fail();
    return entry;
  }
  private decisionSummary(entry: BrowserAutoNoteDecisionEntry) {
    const v = entry.value;
    return {
      decisionId: v.command.id,
      offerId: v.manifest.offerId,
      decision: v.command.decision,
      attempts: v.attempts,
      transport: v.transport,
      result: v.result,
      stopped: v.stopped,
    };
  }
  decisionHistory() {
    return this.maintenance(async (check) => {
      const rows = await browserStorageTransaction<unknown[]>(
        this.db,
        [decisionStore],
        "readonly",
        check,
        (io) =>
          io.request(
            io.store(decisionStore).index("scope").getAll(this.scope, 65),
            io.done,
          ),
      );
      if (rows.length > 64) throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
      const entries = await Promise.all(
        rows.map(openBrowserAutoNoteDecisionRow),
      );
      check();
      if (entries.some((e) => e.row.scope !== this.scope)) throw fail();
      return entries.map((e) => this.decisionSummary(e));
    });
  }
  async exportDecision(raw: unknown) {
    const input = z
      .strictObject({ offerId: z.uuid(), confirmed: z.literal(true) })
      .parse(raw);
    return this.maintenance(async (check) => {
      const entry = await this.savedDecision(input.offerId, check);
      return {
        version: 1,
        envelope: entry.value.envelope,
        resultEnvelope: entry.value.resultEnvelope,
        restoreAuthority: false,
      };
    });
  }
  async decisionStatus(raw: unknown) {
    const input = z.strictObject({ offerId: z.uuid() }).parse(raw);
    return this.maintenance(async (check) =>
      this.decisionSummary(await this.savedDecision(input.offerId, check)),
    );
  }
  async dispatchDecision(
    raw: unknown,
    upload: (
      envelope: PrivateEnvelope,
      check: () => Promise<void>,
    ) => Promise<unknown>,
  ) {
    const input = z
      .strictObject({ offerId: z.uuid(), confirmed: z.literal(true) })
      .parse(raw);
    return this.exclusive(async (check) => {
      const inspected = await this.inspectOffer(input.offerId, check),
        { p } = inspected;
      let entry = await this.savedDecision(input.offerId, check);
      const value = entry.value;
      if (
        value.stopped ||
        value.result ||
        !same(value.manifest, inspected.manifest) ||
        !same(value.local, p.local.proof) ||
        !same(value.peer, p.peer.proof) ||
        entry.row.deviceHash !== p.identity.deviceHash
      )
        throw fail();
      const channel = await browserPrivateChannel(p.identity, {
        senderKeyEpoch: p.local.proof.keyEpoch,
        peerId: p.peer.proof.peerId,
        peerKeyEpoch: p.peer.proof.keyEpoch,
      });
      const live = () => {
        check();
        if (
          this.now() < value.envelope.header.issuedAt ||
          this.now() >= value.envelope.header.expiresAt
        )
          throw fail();
      };
      const current = (
        mode: IDBTransactionMode,
        update?: BrowserAutoNoteDecisionEntry["row"],
      ) =>
        browserStorageTransaction<void>(
          this.db,
          [...stores, decisionStore, "channels"],
          mode,
          live,
          (io) =>
            this.validate(io, p, () =>
              this.retained(io, inspected.retained, () =>
                this.rows(io, inspected.offer, (rows) => {
                  if (!same(rows, inspected.rows)) throw fail();
                  io.request(
                    io.store("channels").get([p.identity.scope, channel]),
                    (raw) => {
                      const sequence = browserOutboxChannelSchema.parse(raw);
                      if (
                        sequence.scope !== p.identity.scope ||
                        sequence.channel !== channel ||
                        sequence.next <= value.envelope.header.sequence
                      )
                        throw fail();
                      io.request(
                        io.store(decisionStore).get([this.scope, entry.row.id]),
                        (saved) => {
                          if (
                            !same(
                              readBrowserAutoNoteDecisionRow(saved),
                              entry.row,
                            )
                          )
                            throw new BrowserOutboxError("CONFLICT");
                          if (update) io.store(decisionStore).put(update);
                          io.done(undefined);
                        },
                      );
                    },
                  );
                }),
              ),
            ),
        );
      const attempted = { ...value, attempts: value.attempts + 1 };
      const row = await sealBrowserAutoNoteDecisionRow(
        { ...entry.row, revision: entry.row.revision + 1 },
        attempted,
        entry.row.key,
      );
      await current("readwrite", row);
      entry = { row, value: attempted };
      const transport = privateRelayStorageReceiptSchema.parse(
        await upload(value.envelope, () => current("readonly")),
      );
      if (
        transport.messageId !== value.envelope.header.messageId ||
        transport.envelopeHash !==
          (await privateRelayEnvelopeHash(value.envelope)) ||
        transport.storedAt < value.envelope.header.issuedAt ||
        transport.storedAt > this.now() ||
        !["stored", "received"].includes(transport.state)
      )
        throw fail();
      const settled = { ...attempted, transport };
      const receiptRow = await sealBrowserAutoNoteDecisionRow(
        { ...row, revision: row.revision + 1 },
        settled,
        row.key,
      );
      // Preserve a matching storage receipt after upload even if its authority has expired.
      // A removed/replaced row is never recreated by a late network response.
      await browserStorageTransaction<void>(
        this.db,
        [decisionStore],
        "readwrite",
        () => {
          if (this.closed) throw fail();
        },
        (io) =>
          io.request(
            io.store(decisionStore).get([this.scope, row.id]),
            (saved) => {
              if (!same(readBrowserAutoNoteDecisionRow(saved), row))
                throw new BrowserOutboxError("CONFLICT");
              io.store(decisionStore).put(receiptRow);
              io.done(undefined);
            },
          ),
      );
      return this.decisionSummary({ row: receiptRow, value: settled });
    });
  }
  status() {
    return this.maintenance(async (check) =>
      browserStorageTransaction<
        { offerId: string; received: number; expiresAt: number }[]
      >(this.db, [name], "readonly", check, (io) => {
        io.request(
          io.store(name).index("scope").getAll(this.scope, 513),
          (raw) => {
            const rows = raw.map((v) => rowSchema.parse(v));
            if (rows.length > 512 || rows.some((r) => r.scope !== this.scope))
              throw new BrowserOutboxError("STORAGE_UNAVAILABLE");
            io.done(
              rows
                .filter((r) => r.index === -1)
                .map((r) => ({
                  offerId: r.envelope.header.operationId,
                  received: rows.filter((p) => p.offer === r.offer).length,
                  expiresAt: r.envelope.header.expiresAt,
                })),
            );
          },
        );
      }),
    );
  }
  async export(raw: unknown) {
    const input = z
      .strictObject({ offerId: z.uuid(), confirmed: z.literal(true) })
      .parse(raw);
    return this.maintenance(async (check) => {
      const offer = await browserPrivateDigest([
        "autonote-offer:v1",
        input.offerId,
      ]);
      return browserStorageTransaction<{
        version: number;
        envelopes: Row["envelope"][];
        restoreAuthority: boolean;
      }>(this.db, [name], "readonly", check, (io) =>
        this.rows(io, offer, (rows) =>
          io.done({
            version: 1,
            envelopes: rows.map((r) => r.envelope),
            restoreAuthority: false,
          }),
        ),
      );
    });
  }
  async remove(raw: unknown) {
    const input = z
      .strictObject({ offerId: z.uuid(), confirmed: z.literal(true) })
      .parse(raw);
    return this.maintenance(async (check) => {
      const offer = await browserPrivateDigest([
        "autonote-offer:v1",
        input.offerId,
      ]);
      return browserStorageTransaction<{ removed: number }>(
        this.db,
        [name, decisionStore],
        "readwrite",
        check,
        (io) =>
          this.rows(io, offer, (rows) => {
            for (const row of rows) io.store(name).delete([this.scope, row.id]);
            io.store(decisionStore).delete([this.scope, offer]);
            io.done({ removed: rows.length });
          }),
      );
    });
  }
}
