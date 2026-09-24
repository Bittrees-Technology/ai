import { BrowserConversationConsent } from "../../../modules/remote/browser-conversation-consent.js";
import { openBrowserPrivateDatabase } from "../../../modules/remote/browser-outbox-migration.js";
import { browserStorageTransaction } from "../../../modules/remote/browser-storage.js";
import { BrowserRelayPermissionsClient } from "../../../modules/remote/private-relay-client.js";
import { BrowserTaskComposition } from "../../../modules/remote/browser-task-composition.js";
import { BrowserTaskHistory } from "../../../modules/remote/browser-task-history.js";
import { BrowserTaskConsent } from "../../../modules/remote/browser-task-consent.js";
import { BrowserPrivateOutbox } from "../../../modules/remote/browser-outbox.js";
import { BrowserPeerChecks } from "../../../modules/remote/browser-peer-checks.js";
import { BrowserPeerEnrollment } from "../../../modules/remote/browser-peers.js";
import {
  BrowserKeyLifecycle,
  type BrowserKeyProof,
} from "../../../modules/remote/browser-key-lifecycle.js";
import { BrowserKeyHost } from "../../../modules/remote/browser-key-host.js";
import {
  newBrowserRecoveryCode,
  browserRecoveryKey,
  openBrowserKeyRecovery,
} from "../../../modules/remote/browser-key-recovery.js";
import type { PrivateBinding } from "../../../modules/remote/private-peer-contracts.js";
import {
  sealPrivateEnvelope,
  openPrivateEnvelope,
  type PrivateHeader,
} from "../../../modules/remote/private-envelope.js";
let keys: BrowserKeyLifecycle,
  peers: BrowserPeerEnrollment,
  host: BrowserKeyHost | null = null;
let checks: BrowserPeerChecks | undefined;
let consents: BrowserTaskConsent | undefined;
let conversations: BrowserConversationConsent | undefined;
let conversationAccess:
  Awaited<ReturnType<BrowserConversationConsent["authorize"]>> | undefined;
async function conversationStore() {
  return (conversations ??= await BrowserConversationConsent.open(
    owner,
    () => binding,
    keys,
    peers,
    () => now,
    () => mono,
  ));
}
let composition: BrowserTaskComposition | undefined;
let history: BrowserTaskHistory | undefined;
let historyOwner: string | null = null;
let consentProvider = BrowserTaskConsent;
let compositionProvider = BrowserTaskComposition;
let historyProvider = BrowserTaskHistory;
let sender: Awaited<ReturnType<BrowserTaskConsent["authorize"]>> | undefined;
let previousOutbox: typeof BrowserPrivateOutbox | undefined;
async function consentStore() {
  return (consents ??= await consentProvider.open(
    owner,
    () => binding,
    keys,
    peers,
    () => now,
    () => mono,
  ));
}
async function compositionStore() {
  return (composition ??= new compositionProvider(
    await consentStore(),
    () => binding,
    () => binding,
    () => now,
    () => mono,
  ));
}
async function historyStore() {
  return (history ??= await historyProvider.open(
    historyOwner!,
    () => historyOwner,
    () => now,
    () => mono,
  ));
}
async function checkStore() {
  return (checks ??= await BrowserPeerChecks.open(
    owner,
    () => binding,
    keys,
    peers,
    () => now,
    () => mono,
  ));
}
let owner = "",
  binding: PrivateBinding | null = null,
  current: BrowserKeyProof | null = null,
  now = Date.now(),
  mono = 0;
let hostOwner: string | null = null,
  hostScope = 0;
let release: (() => void) | undefined,
  held = false;
let identityCountdown = 0;
const context = () =>
  hostOwner ? { ownerId: hostOwner, scope: String(hostScope) } : null;
async function withKey<T>(fn: () => Promise<T>) {
  current = (await keys.resolve()).proof;
  try {
    return await fn();
  } finally {
    current = null;
  }
}
async function api(path: string, body: unknown) {
  const r = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "X-Bittrees-Request": "1",
      ...(hostOwner ? { "X-Bittrees-Account": hostOwner } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw Error("DENIED");
  return r.json();
}
async function mount(id: string) {
  host?.close();
  hostOwner = id;
  hostScope++;
  host = await BrowserKeyHost.open(context, async (...args) => {
    if (
      new URL(String(args[0]), location.origin).pathname ===
        "/browser/registration/identity" &&
      identityCountdown > 0 &&
      --identityCountdown === 0
    ) {
      held = true;
      await new Promise<void>((r) => (release = r));
    }
    return globalThis.fetch(...args);
  });
  await host.inspect();
}
const legacyUrl = "/legacy-lifecycle.js";
const fixture = {
  async init(
    o: string,
    b: PrivateBinding,
    time: number,
    previous: boolean | "task" | "delivery" | "conversation" | "replay" = false,
  ) {
    sender?.outbox.close();
    sender = undefined;
    consents?.close();
    consents = undefined;
    conversations?.close();
    conversations = undefined;
    conversationAccess = undefined;
    composition?.close();
    composition = undefined;
    history?.close();
    history = undefined;
    historyOwner = b.ownerId;
    checks?.close();
    checks = undefined;
    keys?.close();
    peers?.close();
    host?.close();
    host = null;
    owner = o;
    binding = b;
    now = time;
    mono = 0;
    current = null;
    const previousUrl =
      previous === "replay"
        ? "/legacy-replay/index.js"
        : previous === "conversation"
          ? "/legacy-conversation/index.js"
          : previous === "delivery"
            ? "/legacy-delivery/index.js"
            : previous === "task"
              ? "/legacy-composition/index.js"
              : "/legacy-consent/index.js";
    const providers = previous
      ? await import(/* @vite-ignore */ previousUrl)
      : { BrowserKeyLifecycle, BrowserPeerEnrollment, BrowserPeerChecks };
    previousOutbox = previous ? providers.BrowserPrivateOutbox : undefined;
    consentProvider =
      previous === "task" ||
      previous === "delivery" ||
      previous === "conversation" ||
      previous === "replay"
        ? providers.BrowserTaskConsent
        : BrowserTaskConsent;
    compositionProvider =
      previous === "delivery" ||
      previous === "conversation" ||
      previous === "replay"
        ? providers.BrowserTaskComposition
        : BrowserTaskComposition;
    historyProvider =
      previous === "delivery" ||
      previous === "conversation" ||
      previous === "replay"
        ? providers.BrowserTaskHistory
        : BrowserTaskHistory;
    keys = await providers.BrowserKeyLifecycle.open(
      owner,
      () => binding,
      () => true,
      () => now,
    );
    peers = await providers.BrowserPeerEnrollment.open(
      owner,
      () => current,
      () => now,
      () => mono,
    );
    if (previous)
      checks = await providers.BrowserPeerChecks.open(
        owner,
        () => binding,
        keys,
        peers,
        () => now,
        () => mono,
      );
  },
  async activate() {
    const slot = await keys.begin({
      expectedRevision: (await keys.status()).revision,
      confirmed: true,
    });
    const code = newBrowserRecoveryCode();
    const proof = await keys.provision(
      {
        keyId: slot.keyId,
        expectedRevision: slot.revision,
        confirmed: true,
        recoverySaved: true,
      },
      code,
    );
    return proof;
  },
  keyStatus: () => (host ? host.keyAPI.status() : keys.status()),
  recovery: (keyId: string) => keys.recovery({ keyId, confirmed: true }),
  async checkRecovery(kit: unknown, code: string) {
    const r = await openBrowserKeyRecovery(kit, await browserRecoveryKey(code));
    return {
      identity: r.identity,
      publicKey: r.publicKey,
      privateExtractable: r.pair.privateKey.extractable,
    };
  },
  async key() {
    const k = await keys.resolve();
    return {
      proof: k.proof,
      privateExtractable: k.pair.privateKey.extractable,
    };
  },
  keyRevoke: (raw: unknown) => keys.revoke(raw),
  keyReset: (raw: unknown) => keys.reset(raw),
  set(b: PrivateBinding | null) {
    binding = b;
    checks?.invalidate();
    consents?.invalidate();
    conversations?.invalidate();
    keys.invalidate();
    peers.invalidate();
    current = null;
  },
  time(wall: number, monotonic: number) {
    now = wall;
    mono = monotonic;
  },
  status: () => (host ? host.peerAPI.status() : peers.status()),
  invitation: (raw: unknown) =>
    host ? host.peerAPI.invitation(raw) : keys.invitation(raw),
  prepare: (raw: unknown) =>
    host ? host.peerAPI.prepare(raw) : withKey(() => peers.prepare(raw)),
  approve: (raw: unknown) =>
    host ? host.peerAPI.approve(raw) : withKey(() => peers.approve(raw)),
  reset: (raw: unknown) =>
    host ? host.peerAPI.reset(raw) : withKey(() => peers.reset(raw)),
  revoke: (raw: unknown) =>
    host ? host.peerAPI.revoke(raw) : peers.revoke(raw),
  clear: (raw: unknown) => (host ? host.peerAPI.clear(raw) : peers.clear(raw)),
  resolve: (id: string, epoch: number) =>
    withKey(async () => (await peers.resolve(id, epoch)).proof),
  async validate(proof: unknown) {
    try {
      return await withKey(() => peers.validate(proof));
    } catch {
      return false;
    }
  },
  invalidate() {
    checks?.invalidate();
    consents?.invalidate();
    conversations?.invalidate();
    peers?.invalidate();
    host?.peerAPI.invalidate();
  },
  async seal(id: string, epoch: number, header: PrivateHeader, text: string) {
    const k = await keys.resolve();
    current = k.proof;
    try {
      const p = await peers.resolve(id, epoch);
      return await sealPrivateEnvelope(
        header,
        new TextEncoder().encode(text),
        { senderKey: k.pair, recipientPublicKey: p.publicKey },
        () => now,
      );
    } finally {
      current = null;
    }
  },
  async open(id: string, epoch: number, envelope: unknown, expected: unknown) {
    const k = await keys.resolve();
    current = k.proof;
    try {
      const p = await peers.resolve(id, epoch);
      const result = await openPrivateEnvelope(
        envelope,
        expected,
        { recipientKey: k.pair, senderPublicKey: p.publicKey },
        () => now,
      );
      try {
        return new TextDecoder().decode(result.plaintext);
      } finally {
        result.plaintext.fill(0);
      }
    } finally {
      current = null;
    }
  },
  holdDigest() {
    const original = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = (async (
      ...args: Parameters<SubtleCrypto["digest"]>
    ) => {
      crypto.subtle.digest = original;
      held = true;
      await new Promise<void>((r) => (release = r));
      return original(...args);
    }) as SubtleCrypto["digest"];
  },
  holdImport() {
    const original = crypto.subtle.importKey.bind(crypto.subtle);
    crypto.subtle.importKey = (async (
      ...args: Parameters<SubtleCrypto["importKey"]>
    ) => {
      crypto.subtle.importKey = original;
      held = true;
      await new Promise<void>((r) => (release = r));
      return original(...args);
    }) as SubtleCrypto["importKey"];
  },
  holdSecondIdentity() {
    identityCountdown = 2;
  },
  held: () => held,
  release() {
    release?.();
    release = undefined;
    held = false;
  },
  async legacySeed(o: string, b: PrivateBinding, time: number) {
    const legacy = await import(/* @vite-ignore */ legacyUrl);
    const k = await legacy.BrowserKeyLifecycle.open(
      o,
      () => b,
      () => true,
      () => time,
    );
    try {
      const slot = await k.begin({ expectedRevision: 0, confirmed: true });
      const code = newBrowserRecoveryCode();
      const proof = await k.provision(
        {
          keyId: slot.keyId,
          expectedRevision: slot.revision,
          confirmed: true,
          recoverySaved: true,
        },
        code,
      );
      const kit = await k.recovery({ keyId: slot.keyId, confirmed: true });
      return { proof, code, kit };
    } finally {
      k.close();
    }
  },
  async legacyOpen(o: string, b: PrivateBinding, time: number) {
    const legacy = await import(/* @vite-ignore */ legacyUrl);
    const k = await legacy.BrowserKeyLifecycle.open(
      o,
      () => b,
      () => false,
      () => time,
    );
    try {
      return (await k.resolve()).proof;
    } finally {
      k.close();
    }
  },
  checkStatus: () =>
    host ? host.checkAPI.status() : checkStore().then((c) => c.status()),
  checkBegin: (raw: unknown) =>
    host
      ? host.checkAPI.begin(raw)
      : withKey(async () => (await checkStore()).begin(raw)),
  checkRespond: (raw: unknown) =>
    host
      ? host.checkAPI.respond(raw)
      : withKey(async () => (await checkStore()).respond(raw)),
  checkComplete: (raw: unknown) =>
    host
      ? host.checkAPI.complete(raw)
      : withKey(async () => (await checkStore()).complete(raw)),
  checkResume: (raw: unknown) =>
    host
      ? host.checkAPI.resume(raw)
      : withKey(async () => (await checkStore()).resume(raw)),
  checkEnvelope: (raw: unknown) =>
    host
      ? host.checkAPI.envelope(raw)
      : withKey(async () => (await checkStore()).delivery(raw)),
  checkStop: (raw: unknown) =>
    host ? host.checkAPI.stop(raw) : checkStore().then((c) => c.stop(raw)),
  checkClear: (raw: unknown) =>
    host ? host.checkAPI.clear(raw) : checkStore().then((c) => c.clear(raw)),
  checkReset: (raw: unknown) =>
    host
      ? host.checkAPI.reset(raw)
      : withKey(async () => (await checkStore()).reset(raw)),
  checkValid: (id: string, epoch: number) =>
    withKey(async () => {
      const k = await keys.resolve(),
        p = await peers.resolve(id, epoch);
      return (await checkStore()).validFor(k.proof, p.proof);
    }),
  holdEncryption(skip = 1) {
    const original = crypto.subtle.encrypt.bind(crypto.subtle);
    crypto.subtle.encrypt = (async (
      ...args: Parameters<SubtleCrypto["encrypt"]>
    ) => {
      if (skip-- === 0) {
        crypto.subtle.encrypt = original;
        held = true;
        await new Promise<void>((r) => (release = r));
      }
      return original(...args);
    }) as SubtleCrypto["encrypt"];
  },
  failCheckPublication(state = "pending") {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const row = args[0];
      if (
        this.name === "peer_checks" &&
        row.kind === "check" &&
        row.state === state
      ) {
        IDBObjectStore.prototype.put = original;
        throw new DOMException(
          "Synthetic publication quota",
          "QuotaExceededError",
        );
      }
      return original.apply(this, args);
    };
  },
  async removeCheckMarker() {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("org.bittrees.ai.browser-endpoint-keys");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("peer_checks", "readwrite"),
          store = tx.objectStore("peer_checks"),
          r = store.openCursor();
        r.onsuccess = () => {
          const c = r.result;
          if (c) {
            if (c.value.kind === "meta") c.delete();
            c.continue();
          }
        };
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  },
  async inspectChecks() {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("org.bittrees.ai.browser-endpoint-keys");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      const rows = await new Promise<any[]>((resolve, reject) => {
        const r = db
          .transaction("peer_checks", "readonly")
          .objectStore("peer_checks")
          .getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      let denied = true;
      for (const row of rows.filter((r) => r.kind === "check"))
        try {
          await crypto.subtle.exportKey("raw", row.preparationKey);
          denied = false;
        } catch {}
      return {
        json: JSON.stringify(rows),
        privatePreparationExportDenied: denied,
      };
    } finally {
      db.close();
    }
  },
  conversationStatus: () =>
    host
      ? host.conversationAPI.status()
      : conversationStore().then((c) => c.status()),
  conversationOpenOffer: (raw: unknown) =>
    host
      ? host.conversationAPI.inspectOffer(raw)
      : withKey(async () => (await conversationStore()).inspectOffer(raw)),
  conversationPrepare: (raw: unknown) =>
    host
      ? host.conversationAPI.prepare(raw)
      : withKey(async () => (await conversationStore()).prepare(raw)),
  conversationApprove: (raw: unknown) =>
    host
      ? host.conversationAPI.approve(raw)
      : withKey(async () => (await conversationStore()).approve(raw)),
  conversationRevoke: (raw: unknown) =>
    host
      ? host.conversationAPI.revoke(raw)
      : conversationStore().then((c) => c.revoke(raw)),
  conversationClear: (raw: unknown) =>
    host
      ? host.conversationAPI.clear(raw)
      : conversationStore().then((c) => c.clear(raw)),
  conversationReset: (raw: unknown) =>
    host
      ? host.conversationAPI.reset(raw)
      : withKey(async () => (await conversationStore()).reset(raw)),
  conversationAuthorize: (
    id: string,
    scope: unknown,
    direction:
      | "messagesToMac"
      | "messagesToBrowser"
      | "questionsToBrowser"
      | "answersToMac",
  ) =>
    withKey(async () => {
      conversationAccess = await (
        await conversationStore()
      ).authorize(id, scope, direction);
      return conversationAccess.grant;
    }),
  conversationUse: () =>
    withKey(async () => {
      const a = conversationAccess!,
        db = await openBrowserPrivateDatabase();
      try {
        return await browserStorageTransaction(
          db,
          a.stores,
          "readonly",
          a.check,
          (io) => a.validate(io, () => io.done(true)),
        );
      } finally {
        db.close();
      }
    }),
  async conversationInspect(corrupt = false) {
    const db = await openBrowserPrivateDatabase();
    try {
      const rows = await browserStorageTransaction<any[]>(
        db,
        ["conversation_consents"],
        corrupt ? "readwrite" : "readonly",
        () => {},
        (io) =>
          io.request(io.store("conversation_consents").getAll(), (rows) => {
            if (corrupt)
              for (const row of rows) {
                row.ciphertext =
                  (row.ciphertext[0] === "A" ? "B" : "A") +
                  row.ciphertext.slice(1);
                io.store("conversation_consents").put(row);
              }
            io.done(rows);
          }),
      );
      let exportDenied = true;
      for (const row of rows)
        if (row.key)
          try {
            await crypto.subtle.exportKey("raw", row.key);
            exportDenied = false;
          } catch {}
      return {
        version: db.version,
        rows: rows.length,
        json: JSON.stringify(rows),
        exportDenied,
      };
    } finally {
      db.close();
    }
  },
  consentStatus: () =>
    host ? host.consentAPI.status() : consentStore().then((c) => c.status()),
  consentPrepare: (raw: unknown) =>
    host
      ? host.consentAPI.prepare(raw)
      : withKey(async () => (await consentStore()).prepare(raw)),
  consentApprove: (raw: unknown) =>
    host
      ? host.consentAPI.approve(raw)
      : withKey(async () => (await consentStore()).approve(raw)),
  consentRevoke: (raw: unknown) =>
    host
      ? host.consentAPI.revoke(raw)
      : consentStore().then((c) => c.revoke(raw)),
  consentClear: (raw: unknown) =>
    host
      ? host.consentAPI.clear(raw)
      : consentStore().then((c) => c.clear(raw)),
  consentReset: (raw: unknown) =>
    host
      ? host.consentAPI.reset(raw)
      : withKey(async () => (await consentStore()).reset(raw)),
  async authorize(id: string, epoch: number) {
    sender?.outbox.close();
    sender = await withKey(async () =>
      (await consentStore()).authorize(id, epoch, () => binding),
    );
    return sender.context;
  },
  taskInitialize: (raw: unknown) => sender!.outbox.initialize(raw),
  taskCreate: (raw: unknown) => sender!.prepareTask(raw),
  taskReserve: (raw: unknown) => sender!.reserveTask(raw),
  taskResume: (raw: unknown) => sender!.resumeTask(raw),
  composeInitialize: (raw: unknown) =>
    host
      ? host.taskAPI.initialize(raw)
      : BrowserPrivateOutbox.initializeVerified(
          raw,
          {
            current: () => binding,
            freshRegistration: (b) =>
              !!binding && JSON.stringify(b) === JSON.stringify(binding),
          },
          () => now,
        ),
  relayEnable: (raw: unknown) =>
    new BrowserRelayPermissionsClient(context).enableBrowser(raw),
  relayApprove: (raw: unknown) =>
    new BrowserRelayPermissionsClient(context).approveMac(raw),
  relayPrepare: (raw: unknown) => host!.relayTaskAPI.prepare(raw),
  relaySend: (raw: unknown) => host!.relayTaskAPI.send(raw),
  relayInspect: (raw: unknown) => host!.relayTaskAPI.inspect(raw),
  relayCheck: (raw: unknown) => host!.relayTaskAPI.check(raw),
  composePrepare: (raw: unknown) =>
    host
      ? host.taskAPI.prepare(raw)
      : withKey(async () => (await compositionStore()).prepare(raw)),
  composeConfirm: (raw: unknown) =>
    host
      ? host.taskAPI.confirm(raw)
      : withKey(async () => (await compositionStore()).confirm(raw)),
  composeResume: (raw: unknown) =>
    host
      ? host.taskAPI.resume(raw)
      : withKey(async () => (await compositionStore()).resume(raw)),
  composeEnvelope: (raw: unknown) =>
    host
      ? host.taskAPI.envelope(raw)
      : withKey(async () => (await compositionStore()).envelope(raw)),
  composeReceive: (raw: unknown) =>
    host
      ? host.taskAPI.receive(raw)
      : withKey(async () => (await compositionStore()).receive(raw)),
  composeReadResult: (raw: unknown) =>
    host
      ? host.taskAPI.readResult(raw)
      : withKey(async () => (await compositionStore()).readResult(raw)),
  composeInvalidate: () => {
    composition?.invalidate();
    host?.taskAPI.invalidate();
  },
  async recordRelayHistory(raw: any, valid = true, suppliedOwner?: string) {
    const owner = suppliedOwner ?? raw.envelope.header.ownerId;
    const history = await BrowserTaskHistory.open(owner, () => owner);
    try {
      return await history.recordRelayDelivery(raw, () => {
        if (!valid) throw Error("DENIED");
      });
    } finally {
      history.close();
    }
  },
  historyStatus: () =>
    host ? host.taskAPI.status() : historyStore().then((h) => h.status()),
  historyExport: (raw: unknown) =>
    host ? host.taskAPI.export(raw) : historyStore().then((h) => h.export(raw)),
  historyStop: (raw: unknown) =>
    host ? host.taskAPI.stop(raw) : historyStore().then((h) => h.stop(raw)),
  historyClear: (raw: unknown) =>
    host ? host.taskAPI.clear(raw) : historyStore().then((h) => h.clear(raw)),
  historyOwnerChange: (id: string | null) => {
    historyOwner = id;
  },
  taskDelivery: (id: string) => sender!.outbox.delivery(id),
  taskReceipt: (raw: unknown) => sender!.outbox.acceptReceipt(raw),
  taskResult: (raw: unknown) => sender!.outbox.acceptResult(raw),
  taskRead: (raw: unknown) => sender!.outbox.readResult(raw),
  taskExport: () => sender!.outbox.export(),
  async inspectConsent() {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("org.bittrees.ai.browser-endpoint-keys");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      const rows = await new Promise<any[]>((resolve, reject) => {
        const r = db
          .transaction("task_consents")
          .objectStore("task_consents")
          .getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      let exportDenied = true;
      for (const r of rows)
        if (r.key)
          try {
            await crypto.subtle.exportKey("raw", r.key);
            exportDenied = false;
          } catch {}
      return { json: JSON.stringify(rows), exportDenied };
    } finally {
      db.close();
    }
  },
  async dropConsentRow() {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("org.bittrees.ai.browser-endpoint-keys");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("task_consents", "readwrite");
        tx.objectStore("task_consents").clear();
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  },
  async seedPreviousTask(id: string, epoch: number) {
    if (!previousOutbox) throw Error("Not a previous-provider fixture");
    return withKey(async () => {
      const p = await peers.resolve(id, epoch);
      const context = {
        binding: binding!,
        senderKeyEpoch: current!.keyEpoch,
        peerId: id,
        peerKeyEpoch: epoch,
        peerRevision: p.proof.revision,
        peerFingerprint: p.proof.fingerprint,
        permissionRevision: 7,
        sendingEnabled: true as const,
      };
      const outbox = await previousOutbox!.open(
        () => binding,
        () => context,
        () => binding,
        () => now,
      );
      try {
        await outbox.initialize({ expectedRevision: 0, confirmed: true });
        const reserved = await outbox.reserve({ peerId: id, confirmed: true });
        const k = await keys.resolve();
        const envelope = await sealPrivateEnvelope(
          reserved.header,
          new TextEncoder().encode(
            JSON.stringify({
              version: 1,
              type: "task.submit",
              kind: "query",
              prompt: "synthetic previous task",
            }),
          ),
          { senderKey: k.pair, recipientPublicKey: p.publicKey },
          () => now,
        );
        return await outbox.commit({
          id: reserved.id,
          expectedRevision: reserved.revision,
          envelope,
        });
      } finally {
        outbox.close();
      }
    });
  },
  challenge: (address: string) => api("/browser/login/challenge", { address }),
  async login(message: string, signature: string) {
    const r = await api("/browser/login/verify", { message, signature });
    await mount(r.ownerId);
    return r.ownerId as string;
  },
  async resume() {
    const r = await api("/browser/session", {});
    await mount(r.ownerId);
  },
  register: (raw: unknown) => host!.register(raw),
  async hostActivate() {
    const slot = await host!.keyAPI.begin({
      expectedRevision: (await host!.keyAPI.status()).revision,
      confirmed: true,
    });
    const code = newBrowserRecoveryCode(),
      raw = {
        keyId: slot.keyId,
        expectedRevision: slot.revision,
        confirmed: true,
      };
    const prepared = await host!.keyAPI.prepareRecovery(raw, code);
    return host!.keyAPI.activatePrepared(
      { ...raw, recoverySaved: true },
      code,
      prepared.recovery,
    );
  },
  async logout() {
    await api("/browser/logout", {});
    hostOwner = null;
    hostScope++;
    host?.invalidate();
  },
  scopeChange() {
    hostScope++;
    host?.invalidate();
  },
  registerRevoke: (raw: unknown) => host!.revoke(raw),
  hostKeyRevoke: (raw: unknown) => host!.keyAPI.revoke(raw),
};
declare global {
  interface Window {
    browserPeersTest: typeof fixture;
  }
}
window.browserPeersTest = fixture;
