// Actual pinned PR151 providers create all legacy rows. Raw IndexedDB access below
// is limited to disposable failure injection and independently inspecting results.
import {
  BrowserPrivateOutbox,
  type BrowserDeliveryContext,
} from "../../../modules/remote/browser-outbox.js";
import {
  BrowserKeyLifecycle,
  type BrowserKeyProof,
} from "../../../modules/remote/browser-key-lifecycle.js";
import { BrowserPeerEnrollment } from "../../../modules/remote/browser-peers.js";
import {
  newBrowserRecoveryCode,
  browserRecoveryKey,
  openBrowserKeyRecovery,
} from "../../../modules/remote/browser-key-recovery.js";
import {
  inspectPrivateInvitation,
  type PrivateBinding,
} from "../../../modules/remote/private-peer-contracts.js";
import {
  sealPrivateEnvelope,
  openPrivateEnvelope,
} from "../../../modules/remote/private-envelope.js";
import { openBrowserPrivateDatabase } from "../../../modules/remote/browser-outbox-migration.js";
import { browserStorageTransaction as tx } from "../../../modules/remote/browser-storage.js";
import {
  browserPrivateIdentity,
  browserPrivateChannel,
  reserveBrowserSequence,
} from "../../../modules/remote/browser-outbox-state.js";
const keyName = "org.bittrees.ai.browser-endpoint-keys",
  oldName = "org.bittrees.ai.private-outbox";
const legacyUrl = "/legacy-private/index.js";
type Config = {
  owner: string;
  binding: PrivateBinding;
  context: BrowserDeliveryContext;
  now: number;
  peerPublic: string;
  retained: boolean;
};
let active: BrowserPrivateOutbox | undefined,
  keys: BrowserKeyLifecycle | undefined;
const legacyConnections: { close(): void }[] = [];
let legacyOutbox: BrowserPrivateOutbox | undefined;
const b64 = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const importPublic = (s: string) =>
  crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
      c.charCodeAt(0),
    ),
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
async function rawDB(name: string, version: number) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(name, version);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(Error("blocked"));
  });
}
async function inspect(name: string, version: number) {
  const db = await rawDB(name, version);
  try {
    const names = [
      "meta",
      "entries",
      "channels",
      ...(db.objectStoreNames.contains("private_migrations")
        ? ["private_migrations"]
        : []),
    ];
    return await tx<Record<string, unknown[]>>(
      db,
      names,
      "readonly",
      () => {},
      (io) => {
        const rows: Record<string, unknown[]> = {};
        const next = (i: number) => {
          if (i === names.length) {
            io.done(rows);
            return;
          }
          io.request(io.store(names[i]!).getAll(), (v) => {
            rows[names[i]!] = v;
            next(i + 1);
          });
        };
        next(0);
      },
    );
  } finally {
    db.close();
  }
}
async function legacyModule() {
  return (await import(/* @vite-ignore */ legacyUrl)) as {
    BrowserPrivateOutbox: typeof BrowserPrivateOutbox;
    BrowserKeyLifecycle: typeof BrowserKeyLifecycle;
    BrowserPeerEnrollment: typeof BrowserPeerEnrollment;
  };
}
const fixture = {
  async seed(retained = true, locked = false) {
    const legacy = await legacyModule(),
      now = Date.now();
    const binding = {
      ownerId: crypto.randomUUID(),
      deviceId: crypto.randomUUID(),
      credentialEpoch: 1,
      expiresAt: now + 3600000,
    };
    const owner = "synthetic:" + binding.ownerId;
    const remote = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    const peerPublic = b64(
        await crypto.subtle.exportKey("raw", remote.publicKey),
      ),
      peerId = crypto.randomUUID();
    let pair: CryptoKeyPair,
      proof: BrowserKeyProof | undefined,
      code: string | undefined,
      kit: unknown,
      pin: unknown;
    if (retained) {
      const k = await legacy.BrowserKeyLifecycle.open(
        owner,
        () => binding,
        () => true,
        () => now,
      );
      legacyConnections.push(k);
      const slot = await k.begin({ expectedRevision: 0, confirmed: true });
      code = newBrowserRecoveryCode();
      proof = await k.provision(
        {
          keyId: slot.keyId,
          expectedRevision: slot.revision,
          confirmed: true,
          recoverySaved: true,
        },
        code,
      );
      kit = await k.recovery({ keyId: slot.keyId, confirmed: true });
      pair = (await k.resolve()).pair;
      const peers = await legacy.BrowserPeerEnrollment.open(
        owner,
        () => proof!,
        () => now,
        () => 0,
      );
      legacyConnections.push(peers);
      const invitation = {
        version: 1,
        ownerId: binding.ownerId,
        recipientId: binding.deviceId,
        peerId,
        keyEpoch: 1,
        publicKey: peerPublic,
        nonce: crypto.randomUUID(),
        issuedAt: now,
        expiresAt: now + 300000,
      };
      const review = await peers.prepare(invitation);
      pin = await peers.approve({
        reviewId: review.reviewId,
        expectedRevision: review.expectedRevision,
        comparedFingerprint: (await inspectPrivateInvitation(invitation, now))
          .fingerprint,
        confirmed: true,
      });
    } else
      pair = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        false,
        ["deriveBits"],
      );
    const context: BrowserDeliveryContext = {
      binding,
      senderKeyEpoch: proof?.keyEpoch ?? 1,
      peerId,
      peerKeyEpoch: 1,
      peerRevision: 1,
      peerFingerprint: "a".repeat(64),
      permissionRevision: 1,
      sendingEnabled: true,
    };
    const c: Config = { owner, binding, context, now, peerPublic, retained };
    const out = await legacy.BrowserPrivateOutbox.open(
      () => binding,
      () => context,
      () => binding,
      () => now,
      () => ({
        context,
        recipientKey: pair,
        senderPublicKey: remote.publicKey,
        resultsEnabled: true,
      }),
    );
    legacyOutbox = out;
    legacyConnections.push(out);
    await out.initialize({ expectedRevision: 0, confirmed: true });
    // All four states are produced by the old public API, including real HPKE
    // acceptance/result envelopes rather than a handcrafted valid-looking row.
    const reserved = await out.reserve({ peerId, confirmed: true });
    const pending = await out.reserve({ peerId, confirmed: true });
    const seal = async (entry: typeof pending) =>
      sealPrivateEnvelope(
        entry.header,
        new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            type: "task.submit",
            kind: "query",
            prompt: "Synthetic migration question",
          }),
        ),
        { senderKey: pair, recipientPublicKey: remote.publicKey },
        () => now,
      );
    await out.commit({
      id: pending.id,
      expectedRevision: pending.revision,
      envelope: await seal(pending),
    });
    const stopped = await out.reserve({ peerId, confirmed: true });
    await out.stop({
      id: stopped.id,
      expectedRevision: stopped.revision,
      confirmed: true,
    });
    const accepted = await out.reserve({ peerId, confirmed: true });
    await out.commit({
      id: accepted.id,
      expectedRevision: accepted.revision,
      envelope: await seal(accepted),
    });
    const receipt = {
      version: 1,
      id: crypto.randomUUID(),
      taskId: crypto.randomUUID(),
      status: "accepted",
      acceptedAt: now,
      header: accepted.header,
      permissionRevision: 1,
    };
    const responseHeader = {
      ...accepted.header,
      senderId: peerId,
      recipientId: binding.deviceId,
      senderKeyEpoch: 1,
      recipientKeyEpoch: context.senderKeyEpoch,
      messageId: crypto.randomUUID(),
      sequence: 1,
    };
    const result = {
      version: 1,
      type: "task.result",
      receipt,
      task: {
        id: receipt.taskId,
        revision: 2,
        status: "completed",
        updatedAt: now,
        output: "Synthetic retained answer",
      },
    };
    await out.acceptReceipt(
      await sealPrivateEnvelope(
        responseHeader,
        new TextEncoder().encode(
          JSON.stringify({ version: 1, type: "task.accepted", receipt }),
        ),
        { senderKey: remote, recipientPublicKey: pair.publicKey },
        () => now,
      ),
    );
    await out.acceptResult(
      await sealPrivateEnvelope(
        { ...responseHeader, messageId: crypto.randomUUID(), sequence: 2 },
        new TextEncoder().encode(JSON.stringify(result)),
        { senderKey: remote, recipientPublicKey: pair.publicKey },
        () => now,
      ),
    );
    if (locked)
      await out.clear({
        expectedRevision: (await out.export()).meta!.revision,
        confirmed: true,
      });
    return {
      config: c,
      proof,
      code,
      kit,
      pin,
      history: await out.export(),
      result,
      ids: {
        reserved: reserved.id,
        pending: pending.id,
        stopped: stopped.id,
        accepted: accepted.id,
      },
    };
  },
  async open(c: Config) {
    active?.close();
    keys?.close();
    let pair: CryptoKeyPair | undefined;
    if (c.retained) {
      keys = await BrowserKeyLifecycle.open(
        c.owner,
        () => c.binding,
        () => false,
        () => c.now,
      );
      pair = (await keys.resolve()).pair;
    }
    const pub = await importPublic(c.peerPublic);
    active = await BrowserPrivateOutbox.open(
      () => c.binding,
      () => c.context,
      () => c.binding,
      () => c.now,
      () =>
        pair
          ? {
              context: c.context,
              recipientKey: pair,
              senderPublicKey: pub,
              resultsEnabled: true,
            }
          : null,
    );
    return active.export();
  },
  async retained(c: Config, kit: unknown, code: string) {
    const k = await BrowserKeyLifecycle.open(
      c.owner,
      () => c.binding,
      () => false,
      () => c.now,
    );
    try {
      const live = await k.resolve(),
        recovered = await openBrowserKeyRecovery(
          kit,
          await browserRecoveryKey(code),
        );
      const peers = await BrowserPeerEnrollment.open(
        c.owner,
        () => live.proof,
        () => c.now,
        () => 0,
      );
      try {
        const pinned = await peers.resolve(
          c.context.peerId,
          c.context.peerKeyEpoch,
        );
        // Use the recovered key to open ciphertext made with the retained key.
        const header = {
          version: 1 as const,
          suite: "HPKE-Auth-P256-SHA256-AES256GCM" as const,
          ownerId: c.binding.ownerId,
          senderId: c.binding.deviceId,
          recipientId: c.context.peerId,
          senderKeyEpoch: live.proof.keyEpoch,
          recipientKeyEpoch: live.proof.keyEpoch,
          messageId: crypto.randomUUID(),
          operationId: crypto.randomUUID(),
          sequence: 1,
          issuedAt: c.now,
          expiresAt: c.now + 60000,
        };
        const e = await sealPrivateEnvelope(
          header,
          new TextEncoder().encode("recovery correspondence"),
          {
            senderKey: live.pair,
            recipientPublicKey: recovered.pair.publicKey,
          },
          () => c.now,
        );
        const opened = await openPrivateEnvelope(
          e,
          header,
          {
            recipientKey: recovered.pair,
            senderPublicKey: live.pair.publicKey,
          },
          () => c.now,
        );
        try {
          return {
            proof: live.proof,
            pin: pinned.proof,
            kit: await k.recovery({ keyId: live.proof.keyId, confirmed: true }),
            text: new TextDecoder().decode(opened.plaintext),
            extractable: live.pair.privateKey.extractable,
          };
        } finally {
          opened.plaintext.fill(0);
        }
      } finally {
        peers.close();
      }
    } finally {
      k.close();
    }
  },
  reserve: (peerId: string) => active!.reserve({ peerId, confirmed: true }),
  result: (id: string, revision: number) =>
    active!.readResult({ id, expectedRevision: revision, confirmed: true }),
  clear: async () =>
    active!.clear({
      expectedRevision: (await active!.export()).meta!.revision,
      confirmed: true,
    }),
  initialize: (revision: number) =>
    active!.initialize({ expectedRevision: revision, confirmed: true }),
  oldHistory: () => legacyOutbox!.export(),
  async oldOpen(c: Config, key = false) {
    const legacy = await legacyModule();
    const value = key
      ? await legacy.BrowserKeyLifecycle.open(
          c.owner,
          () => c.binding,
          () => false,
          () => c.now,
        )
      : await legacy.BrowserPrivateOutbox.open(
          () => c.binding,
          () => c.context,
        );
    value.close();
    return true;
  },
  close() {
    active?.close();
    keys?.close();
    for (const c of legacyConnections) c.close();
  },
  inspectLegacy: () => inspect(oldName, 2),
  inspectCommon: () => inspect(keyName, 5),
  async concurrentOpen() {
    const list = await Promise.all(
      Array.from({ length: 4 }, () => openBrowserPrivateDatabase()),
    );
    list.forEach((d) => d.close());
    return true;
  },
  async sharedReserve(c: Config, fail = false) {
    const identity = await browserPrivateIdentity(c.binding),
      channel = await browserPrivateChannel(identity, c.context),
      db = await openBrowserPrivateDatabase();
    try {
      return await tx<number>(
        db,
        ["channels"],
        "readwrite",
        () => {},
        (io) =>
          reserveBrowserSequence(io, identity.scope, channel, (n) => {
            if (fail) throw Error("synthetic publication failure");
            io.done(n);
          }),
      );
    } finally {
      db.close();
    }
  },
  fault(phase: "copy" | "cleanup" | "owner-marker" | "final" | "upgrade") {
    if (phase === "upgrade") {
      const original = IDBDatabase.prototype.createObjectStore;
      IDBDatabase.prototype.createObjectStore = function (name, options) {
        if (this.name === keyName && name === "private_migrations") {
          IDBDatabase.prototype.createObjectStore = original;
          throw new DOMException("synthetic quota", "QuotaExceededError");
        }
        return original.call(this, name, options);
      };
      return;
    }
    const method =
      phase === "cleanup" ? "delete" : phase === "owner-marker" ? "put" : "add";
    const original = IDBObjectStore.prototype[method];
    // Test-only one-shot IDB fault; the next real retry runs without interception.
    Reflect.set(
      IDBObjectStore.prototype,
      method,
      function (this: IDBObjectStore, ...args: unknown[]) {
        const v = args[0] as { id?: string; state?: string };
        const match =
          (phase === "copy" &&
            this.transaction.db.name === keyName &&
            this.name === "entries") ||
          (phase === "cleanup" &&
            this.transaction.db.name === oldName &&
            this.name === "entries") ||
          (phase === "owner-marker" &&
            this.transaction.db.name === keyName &&
            this.name === "private_migrations" &&
            v.state === "cleaned") ||
          (phase === "final" &&
            this.transaction.db.name === keyName &&
            this.name === "private_migrations" &&
            v.id === "legacy-outbox-v1");
        if (match) {
          Reflect.set(IDBObjectStore.prototype, method, original);
          throw new DOMException("synthetic quota", "QuotaExceededError");
        }
        return Reflect.apply(original, this, args);
      },
    );
  },
  async tamper(
    which: "counter" | "orphan" | "copied" | "exhausted" | "capacity",
    c: Config,
  ) {
    const legacy = which === "counter" || which === "orphan",
      db = await rawDB(legacy ? oldName : keyName, legacy ? 1 : 5);
    const identity = await browserPrivateIdentity(c.binding),
      channel = await browserPrivateChannel(identity, c.context);
    try {
      await tx<void>(
        db,
        ["meta", "entries", "channels"],
        "readwrite",
        () => {},
        (io) => {
          if (which === "counter" || which === "exhausted")
            io.request(
              io.store("channels").get([identity.scope, channel]),
              (v) => {
                v.next = which === "counter" ? 1 : Number.MAX_SAFE_INTEGER;
                io.store("channels").put(v);
                io.done(undefined);
              },
            );
          else if (which === "capacity") {
            for (let i = 1; i <= 1024; i++)
              io.store("channels").put({
                scope: identity.scope,
                channel: i.toString(16).padStart(64, "0"),
                next: 1,
              });
            io.done(undefined);
          } else if (which === "orphan") {
            io.store("meta").delete(identity.scope);
            io.done(undefined);
          } else
            io.request(io.store("entries").getAll(), (rows) => {
              rows[0].revision++;
              io.store("entries").put(rows[0]);
              io.done(undefined);
            });
        },
      );
    } finally {
      db.close();
    }
  },
};
declare global {
  interface Window {
    privateMigrationTest: typeof fixture;
  }
}
window.privateMigrationTest = fixture;
