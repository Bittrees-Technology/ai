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
  privateEnvelopeSchema,
  openPrivateEnvelope,
} from "./private-envelope.js";
import type { PrivateBinding } from "./private-peer-contracts.js";
import {
  autoNoteApprovalManifestSchema,
  autoNoteApprovalChunkSchema,
} from "./private-autonote-approval-contracts.js";
import { assembleAutoNoteApproval } from "./private-autonote-approval-content.js";
const name = "autonote_approval_inbox";
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
  }
  close() {
    this.closed = true;
    this.invalidate();
    this.db.close();
  }
  private async exclusive<T>(fn: (check: () => void) => Promise<T>) {
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
        !binding ||
        !same(binding, this.current()) ||
        this.now() < at ||
        this.now() >= binding.expiresAt ||
        this.mono() < mono ||
        this.mono() - mono >= Math.min(120000, binding.expiresAt - at)
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
  async receive(raw: unknown) {
    const input = z
      .strictObject({
        envelope: privateEnvelopeSchema,
        confirmed: z.literal(true),
      })
      .parse(raw);
    return this.exclusive(async (check) => {
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
  async reveal(raw: unknown) {
    const input = z
      .strictObject({ offerId: z.uuid(), confirmed: z.literal(true) })
      .parse(raw);
    return this.exclusive(async (check) => {
      const offer = await browserPrivateDigest([
        "autonote-offer:v1",
        input.offerId,
      ]);
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
      if (manifest.offerId !== input.offerId) throw fail();
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
      return browserStorageTransaction<{
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
    });
  }
  async export(raw: unknown) {
    const input = z
      .strictObject({ offerId: z.uuid(), confirmed: z.literal(true) })
      .parse(raw);
    return this.exclusive(async (check) => {
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
    return this.exclusive(async (check) => {
      const offer = await browserPrivateDigest([
        "autonote-offer:v1",
        input.offerId,
      ]);
      return browserStorageTransaction<{ removed: number }>(
        this.db,
        [name],
        "readwrite",
        check,
        (io) =>
          this.rows(io, offer, (rows) => {
            for (const row of rows) io.store(name).delete([this.scope, row.id]);
            io.done({ removed: rows.length });
          }),
      );
    });
  }
}
