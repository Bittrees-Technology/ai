import { mountPrivateResults } from "../../../apps/remote-web/private-results.js";
import {
  privateTaskPayloadSchema,
  privateAcceptedPayloadSchema,
  privateResultPayloadSchema,
} from "../../../modules/remote/private-task-contracts.js";
import {
  openPrivateEnvelope,
  sealPrivateEnvelope,
  type PrivateHeader,
} from "../../../modules/remote/private-envelope.js";
import { inspectPrivateInvitation } from "../../../modules/remote/private-peer-contracts.js";
let keys: CryptoKeyPair | undefined;
let peer: Awaited<ReturnType<typeof inspectPrivateInvitation>> | undefined;
const harness = {
  async init(testKeys?: { privateKey: string; publicKey: string }) {
    if (testKeys) {
      const bytes = (value: string) =>
        Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
      keys = {
        privateKey: await crypto.subtle.importKey(
          "pkcs8",
          bytes(testKeys.privateKey),
          { name: "ECDH", namedCurve: "P-256" },
          false,
          ["deriveBits"],
        ),
        publicKey: await crypto.subtle.importKey(
          "raw",
          bytes(testKeys.publicKey),
          { name: "ECDH", namedCurve: "P-256" },
          true,
          [],
        ),
      };
    } else
      keys = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        false,
        ["deriveBits"],
      );
    const raw = new Uint8Array(
      await crypto.subtle.exportKey("raw", keys.publicKey),
    );
    let privateExportDenied = false;
    try {
      await crypto.subtle.exportKey("pkcs8", keys.privateKey);
    } catch {
      privateExportDenied = true;
    }
    return {
      publicKey: btoa(String.fromCharCode(...raw))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, ""),
      privateExtractable: keys.privateKey.extractable,
      privateExportDenied,
      secureContext: isSecureContext,
    };
  },
  async inspect(raw: unknown, now: number) {
    peer = await inspectPrivateInvitation(raw, now);
    return {
      fingerprint: peer.fingerprint,
      keyHash: peer.keyHash,
      invitation: peer.invitation,
    };
  },
  async seal(header: PrivateHeader, payload: unknown, now: number) {
    if (!keys || !peer) throw Error("FIXTURE_NOT_READY");
    const parsed = privateTaskPayloadSchema.parse(payload);
    return sealPrivateEnvelope(
      header,
      new TextEncoder().encode(JSON.stringify(parsed)),
      { senderKey: keys, recipientPublicKey: peer.publicKey },
      () => now,
    );
  },
  async open(envelope: unknown, expected: unknown, now: number) {
    if (!keys || !peer) throw Error("FIXTURE_NOT_READY");
    const opened = await openPrivateEnvelope(
      envelope,
      expected,
      { recipientKey: keys, senderPublicKey: peer.publicKey },
      () => now,
    );
    try {
      return privateAcceptedPayloadSchema.parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(opened.plaintext),
        ),
      );
    } finally {
      opened.plaintext.fill(0);
    }
  },
  async openResult(envelope: unknown, expected: unknown, now: number) {
    if (!keys || !peer) throw Error("FIXTURE_NOT_READY");
    const opened = await openPrivateEnvelope(
      envelope,
      expected,
      { recipientKey: keys, senderPublicKey: peer.publicKey },
      () => now,
    );
    try {
      return privateResultPayloadSchema.parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(opened.plaintext),
        ),
      );
    } finally {
      opened.plaintext.fill(0);
    }
  },
  async denied(envelope: unknown, expected: unknown, now: number) {
    try {
      await harness.open(envelope, expected, now);
      return false;
    } catch {
      return true;
    }
  },
};
declare global {
  interface Window {
    privateProtocolTest: typeof harness;
  }
}
window.privateProtocolTest = harness;

// Disposable storage harness; trusted providers are synthetic test inputs only.
import {
  BrowserPrivateOutbox,
  type BrowserDeliveryContext,
} from "../../../modules/remote/browser-outbox.js";
import type { PrivateBinding } from "../../../modules/remote/private-peer-contracts.js";
let browserStore: BrowserPrivateOutbox | undefined;
let panel: ReturnType<typeof mountPrivateResults> | undefined;
let releaseRead: (() => void) | undefined,
  holdRead = false;
let currentBinding: PrivateBinding | null = null,
  deliveryContext: BrowserDeliveryContext | null = null,
  registration: PrivateBinding | null = null,
  storageNow = 0;
let revokeAt = 0,
  permissionReads = 0,
  receiptKeyReads = 0,
  rotateReceiptKey = false,
  resultPermission = true;
const storageHarness = {
  async open(
    binding: PrivateBinding,
    context: BrowserDeliveryContext,
    now: number,
    fresh = false,
  ) {
    panel?.invalidate();
    browserStore?.close();
    currentBinding = structuredClone(binding);
    deliveryContext = structuredClone(context);
    registration = fresh ? structuredClone(binding) : null;
    storageNow = now;
    permissionReads = 0;
    revokeAt = 0;
    receiptKeyReads = 0;
    rotateReceiptKey = false;
    resultPermission = true;
    browserStore = await BrowserPrivateOutbox.open(
      () => currentBinding,
      () => {
        permissionReads++;
        if (revokeAt && permissionReads >= revokeAt) deliveryContext = null;
        return deliveryContext;
      },
      () => registration,
      () => storageNow,
      () => {
        receiptKeyReads++;
        return keys && peer && deliveryContext
          ? {
              resultsEnabled: resultPermission,
              context: deliveryContext,
              recipientKey: keys,
              senderPublicKey:
                rotateReceiptKey && receiptKeyReads >= 2
                  ? keys.publicKey
                  : peer.publicKey,
            }
          : null;
      },
    );
  },
  initialize(revision = 0) {
    return browserStore!.initialize({
      expectedRevision: revision,
      confirmed: true,
    });
  },
  reserve(peerId: string) {
    return browserStore!.reserve({ peerId, confirmed: true });
  },
  commit(raw: unknown) {
    return browserStore!.commit(raw);
  },
  acceptReceipt(raw: unknown) {
    return browserStore!.acceptReceipt(raw);
  },
  acceptResult(raw: unknown) {
    return browserStore!.acceptResult(raw);
  },
  readResult(raw: unknown) {
    return browserStore!.readResult(raw);
  },
  resultPermission(value: boolean) {
    resultPermission = value;
  },
  delivery(id: string) {
    return browserStore!.delivery(id);
  },
  snapshot() {
    return browserStore!.export();
  },
  stop(raw: unknown) {
    return browserStore!.stop(raw);
  },
  clear(raw: unknown) {
    return browserStore!.clear(raw);
  },
  close() {
    browserStore!.close();
  },
  permission(value: BrowserDeliveryContext | null) {
    panel?.invalidate();
    deliveryContext = value;
    permissionReads = 0;
  },
  revokeDuringCommit() {
    permissionReads = 0;
    revokeAt = 2;
  },
  rotateKeyDuringReceipt() {
    receiptKeyReads = 0;
    rotateReceiptKey = true;
  },
  advance(ms: number) {
    storageNow += ms;
  },
};
declare global {
  interface Window {
    privateStorageTest: typeof storageHarness;
  }
}
window.privateStorageTest = storageHarness;

const panelHarness = {
  mount() {
    panel?.destroy();
    let root = document.getElementById("private-results-root");
    if (!root) {
      root = document.createElement("main");
      root.id = "private-results-root";
      document.body.append(root);
    }
    panel = mountPrivateResults(
      root,
      {
        export: () => browserStore!.export(),
        readResult: async (input) => {
          const result = await browserStore!.readResult(input);
          if (holdRead) {
            holdRead = false;
            await new Promise<void>((resolve) => {
              releaseRead = resolve;
            });
          }
          return result;
        },
        stop: (input) => browserStore!.stop(input),
        clear: (input) => browserStore!.clear(input),
      },
      () =>
        currentBinding && currentBinding.expiresAt > storageNow
          ? JSON.stringify([
              currentBinding,
              deliveryContext,
              resultPermission,
              !!keys,
              peer?.fingerprint,
            ])
          : null,
    );
  },
  invalidate() {
    panel?.invalidate();
  },
  silentRevoke() {
    resultPermission = false;
  },
  hold() {
    holdRead = true;
  },
  held() {
    return !!releaseRead;
  },
  release() {
    releaseRead?.();
    releaseRead = undefined;
  },
  destroy() {
    panel?.destroy();
    panel = undefined;
  },
};
declare global {
  interface Window {
    privateResultsUI: typeof panelHarness;
  }
}
window.privateResultsUI = panelHarness;

if (new URLSearchParams(location.search).has("keys")) void import("./keys.js");

if (new URLSearchParams(location.search).has("peers"))
  void import("./peers.js");

if (new URLSearchParams(location.search).has("permissions"))
  void import("./permissions.js");

if (new URLSearchParams(location.search).has("checks"))
  void import("./checks.js");

if (new URLSearchParams(location.search).has("dependencies"))
  void import("./dependencies.js");

if (new URLSearchParams(location.search).has("workspace"))
  void import("./workspace.js");

if (new URLSearchParams(location.search).has("browser-endpoint-keys"))
  void import("./browser-endpoint-keys.js");

if (new URLSearchParams(location.search).has("browser-key-lifecycle"))
  void import("./browser-key-lifecycle.js");

if (new URLSearchParams(location.search).has("browser-key-controls"))
  void import("./browser-key-controls.js");

if (new URLSearchParams(location.search).has("browser-device-identity"))
  void import("./browser-device-identity.js");

if (new URLSearchParams(location.search).has("browser-setup"))
  void import("./browser-setup.js");

if (new URLSearchParams(location.search).has("browser-peers"))
  void import("./browser-peers.js");

if (new URLSearchParams(location.search).has("private-migration"))
  void import("./private-migration.js");
