# Reviewed peer-key possession checks

Reviewed public invitations identify the key a user chose to trust. The new `PrivatePeerChecks` layer additionally verifies that a peer can decrypt a fresh challenge and produce the corresponding authenticated encrypted response. **Each endpoint performs its own challenge/response.** Answering another endpoint's challenge does not mark a local check complete and does not grant task permission. The Mac controller exposes authenticated local routes for this exchange, while user-facing exchange controls, browser endpoint keys and live transport remain unfinished. Normal native setup remains off.

## Application protocol

This is an experimental application protocol built on the existing pinned HPKE Auth envelope implementation. It adds no cipher, KDF, nonce derivation or reused HPKE context. Each message uses a fresh one-shot envelope in its own direction. [RFC9180 section9.7.3](https://www.rfc-editor.org/rfc/rfc9180.html#section-9.7.3) leaves application replay protection to the embedding protocol; [section9.8](https://www.rfc-editor.org/rfc/rfc9180.html#section-9.8) describes the unidirectional nature of an HPKE context. This exchange does not reuse a context for reverse encryption and is not itself a standardized or independently reviewed handshake.

1. **Begin:** an explicitly confirmed peer selection and expected local-key/peer-registry revisions resolve the retained local key and previously reviewed peer key under a fresh verified device identity. A transaction reserves a generated challenge/operation UUID and the next shared sender-channel sequence. It stores an encrypted preparation containing a random256-bit challenge, exact local/peer proofs and an expiry capped at five minutes and the current device lease. Its encrypted payload is strictly `{version:1,type:"peer.key.challenge",challenge}`.
2. **Respond:** the other endpoint must already trust the sender's reviewed key and hold its own retained key. It validates current routing/epochs, decrypts and strictly parses the challenge. A transaction reserves a response with a fresh message UUID/shared sequence and the same operation UUID. Its payload is `{version:1,type:"peer.key.response",challenge,requestHash}`, where the hash is SHA256 of the canonical complete incoming envelope. Its expiry cannot exceed the challenge. Exact duplicate requests recover the same response; a changed ciphertext under the same operation conflicts.
3. **Complete:** the original endpoint opens the response using the pinned peer key, matches its original generated nonce and complete challenge-envelope hash, and checks peer/account/key epochs and the original deadline. Under the final write lock it rechecks the captured key/peer/identity proofs before recording verification. Exact response retries return the original result; a different re-encryption cannot replace the accepted response.
4. **Repeat in the other direction** before that endpoint may separately approve task permissions. No endpoint claims the other endpoint completed its independent check, approved tasks or is currently connected.

Only the challenger records successful verification. The completed record remains usable while the same full local key, peer proof and verified identity binding remain valid; the five-minute deadline applies to completing the exchange, not to deleting its history. Rotation, pin revocation/replacement, any peer-registry revision change, identity/lease change, restore or deletion invalidates the recorded proof. A check does not replace the independent full-fingerprint comparison. HPKE Auth evidence is not a transferable signature/non-repudiation proof and does not protect compromised endpoints or provide forward secrecy against recipient-key compromise.

## Permission and local API integration

`PrivateTaskConsent` requires a current completed check both when preparing/approving a new grant and whenever receive/send/response providers are used. It preserves separate incoming/outgoing/receipt/result choices and their original admission revision. Successful verification alone grants no task, source, memory, tool or publication authority.

The Mac parent serializes check operations with key, peer, permission, dispatch and deletion work. Check actions invalidate pending setup reviews. Each cryptographic operation obtains a separate `RemoteClient.withVerifiedDevice` scope; logout fences in-flight native reads/cryptography and later publication. Offline stop needs the exact stored revision. A completed check is not stopped through that route: revoke the peer or key to invalidate its trust. An interrupted preparation is resumed explicitly using its original ID, and delivery returns the stored ciphertext, never a re-encryption of an already published message.

All routes inherit local host/origin, paired-session authentication, no-store headers and the64KiB JSON bound:

| Route | Result |
| --- | --- |
| `GET /v1/private-peer-checks` | Local metadata only: ID, role, revision, restore lock, recorded state, peer ID, exchange expiry and completion time. No network/native-key read; recorded verification is not a current connection check. |
| `POST /v1/private-peer-checks/begin` | Confirmed peer/key/registry selection; preparation metadata. |
| `POST /v1/private-peer-checks/respond` | Confirmed incoming challenge envelope; response metadata. |
| `POST /v1/private-peer-checks/complete` | Confirmed incoming response envelope; recorded verification metadata. |
| `POST /v1/private-peer-checks/resume` | Confirmed stored ID; preparation reconciliation. A stopped record remains stopped. |
| `POST /v1/private-peer-checks/envelope` | Confirmed stored ID; original pending ciphertext. |
| `POST /v1/private-peer-checks/stop` | Confirmed ID/current revision; offline stop of an unfinished check. |

Pending exchanges, nonces, keys and transcript hashes are not exposed by the metadata projection. The separately authenticated user-requested content export includes full encrypted-at-rest check history (public key/proof metadata and challenge content, never private endpoint keys), consistent with retain-until-deletion. A final acknowledgement can be lost after local completion; exact retry reconciles the durable record. No automatic retry or upstream send is performed.

## Storage, upgrade and verification

Task schema19 adds owner-encrypted `private_peer_checks`, bounded to256 records per local owner and16KiB per encrypted record, with at most four concurrent crypto operations per module instance. The parent further serializes mounted operations. Local association, role and operation identities are durable; request/response hashes prevent conflicting replay. Keys remain in their existing separate native storage. Unsupported old engines must refuse schema19.

Upgrading from schema18 preserves task history and saved choices but locks all previous task-consent rows and advances their revisions. New possession evidence alone cannot reactivate those grants; a separate fresh permission review is mandatory. Supported backup restoration locks every proof record, alongside existing key/peer/consent restore locks. Whole-data deletion removes proof records while existing key/peer identity locks prevent reuse of a stale local identity. No restored check or older exported history grants authority. Historical-key recovery, hostile filesystem rollback and fresh device registration remain separate work.

The [compatibility receipt](evidence/private-peer-check-schema-compatibility-2026-09-23.json) records the actual signed prepared PR104 engine preserving a synthetic schema12 task through upgrade to19, refusing the new schema, and restoring its original backup separately. It does not represent personal upgrade/native acceptance.

Seven new tests cover bilateral checks before permission approval, task-envelope type separation, shared sequences, database reopen, changed transcript/nonce/route/epoch/type, conflicting re-encryption, wrong owner, offline revision-bound stop, expiry and key rotation, commit-lock revocation/expiry, logout during native reads, failed publication/resume, lost completion acknowledgement, owner-bound ciphertext copying, restore/deletion, schema18 task preservation and permission lock, and actual authenticated HTTP/export/projection boundaries. Existing consent, Mac controls and full two-endpoint dispatch tests now perform real synthetic proof exchanges before permission approval. Native entries, identity transport and inference remain synthetic. Separate packaged-native/service/browser CI is still required; independent review is still open.

No private remote service, automatic transport, source permission, personal Keychain/app replacement or model change is enabled. Browser persistence/recovery, human exchange UI, relay retention/delivery, encrypted replies/approvals, signed delivery and independent/personal acceptance remain unfinished. Acer-server's current model/runtime/news jobs remain unchanged and independent of Mac inference.
