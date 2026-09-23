import { randomUUID } from "node:crypto";
import {
  openPrivateEnvelope,
  sealPrivateEnvelope,
  type PrivateEnvelope,
} from "../../modules/remote/private-envelope.js";
import {
  peerChallengeSchema,
  peerEnvelopeHash,
} from "../../modules/remote/private-peer-checks.js";
/** Synthetic remote endpoint owning its actual private key; never writes proof rows. */
export async function peerCheckResponse(
  envelope: PrivateEnvelope,
  remote: CryptoKeyPair,
  local: CryptoKey,
  clock: () => number,
) {
  const opened = await openPrivateEnvelope(
    envelope,
    envelope.header,
    { recipientKey: remote, senderPublicKey: local },
    clock,
  );
  let challenge;
  try {
    challenge = peerChallengeSchema.parse(
      JSON.parse(new TextDecoder().decode(opened.plaintext)),
    );
  } finally {
    opened.plaintext.fill(0);
  }
  const h = envelope.header,
    bytes = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        type: "peer.key.response",
        challenge: challenge.challenge,
        requestHash: peerEnvelopeHash(envelope),
      }),
    );
  try {
    return await sealPrivateEnvelope(
      {
        ...h,
        senderId: h.recipientId,
        recipientId: h.senderId,
        senderKeyEpoch: h.recipientKeyEpoch,
        recipientKeyEpoch: h.senderKeyEpoch,
        messageId: randomUUID(),
        sequence: 1,
        issuedAt: clock(),
      },
      bytes,
      { senderKey: remote, recipientPublicKey: local },
      clock,
    );
  } finally {
    bytes.fill(0);
  }
}
