import {
  privateTaskPayloadSchema,
  privateAcceptedPayloadSchema,
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
  async init() {
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
