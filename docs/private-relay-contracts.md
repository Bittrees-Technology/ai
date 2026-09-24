# Private relay ingress and policy contracts

This module prepares the next private-transport implementation. It is not mounted in the remote server, stores no messages, issues no credentials and starts no background delivery. Existing status credentials remain status-only. The Mac companion continues to choose its own local model; Acer news processing is unchanged.

## Separate authority

A transport identity must be authenticated by the server from a separately granted `private:relay` permission. It includes the owner, browser or Mac endpoint, current credential epoch, permission identity and expiry. Request JSON cannot supply trusted identities. The future store must lock and revalidate the session/endpoint/grant rows through commit, including revocation and expiry; schema validation alone does not authenticate anything.

A submission routes between opposite endpoint kinds belonging to the same owner. Its encrypted header must match the authenticated sender and separately authorized recipient. Message validity is bounded by both transport leases, the existing one-day envelope lifetime and the existing 30-second future-clock allowance. Key epochs are preserved for endpoint verification; they are not credential epochs and the relay does not infer key trust or task consent from them.

The structural parser rejects unknown fields, plaintext fields, noncanonical base64url, malformed framing, wrong route/owner and invalid clocks. It accepts the current envelope's full 65,536-byte plaintext capacity after encryption. The future route needs a bounded 96-KiB request parser; existing 32-KiB status routes must keep their smaller limit. Parsed messages are cloned and preserve the original header, encapsulated key and ciphertext.

A relay cannot establish that arbitrary submitted bytes are encrypted, authentic or semantically valid without endpoint keys. The validator deliberately does not open ciphertext or attempt to parse task content. A structurally valid altered ciphertext passes this layer and is rejected by actual endpoint cryptographic verification. Only the retained endpoint providers can authenticate, decrypt, apply replay checks and independently consent to admission/result viewing. No relay acknowledgement can mark a task queued, executed or completed.

## Storage and retention

Storage receipts identify a message and exact envelope hash, revision, storage time and `stored`, `received` or `deleted` state. These are transport states only. Destination acknowledgement requires the exact message/hash/revision and explicit confirmation. Future clients must acknowledge only after durable local processing and reconcile lost responses with the same saved operation; the server cannot infer successful decryption from a download. Explicit deletion has its own expected revision.

Pagination is bounded to 20 records with an explicit stable time/ID cursor. The future store must preserve exact ciphertext on duplicate upload, reject conflicting reuse, isolate owner/endpoints, impose byte/count quotas atomically, prevent deleted-message resurrection and retain bounded replay metadata. Polling, grants, HTTP authentication, durable SQL storage, cleanup, frontend/native connection and integration tests remain to implement.

Policy has no implicit defaults. Received-content handling, unreceived-content handling, operational metadata retention and quotas are all mandatory inputs. The contracts can represent both pending received-content choices and either explicit bounded or until-deleted unreceived retention. Test fixtures are not user decisions. No live policy or service may be enabled until the user's pending choices are resolved. Local task retention remains until user deletion independently of relay policy.

## Verification

Unit tests use actual HPKE sealing/opening with synthetic content, including the maximum-size envelope and reversed Mac-to-browser routing. They test wrong or status-only credentials, owner/route/lease boundaries, invalid framing and unknown fields, malformed policy and the distinction between transport and task receipts. The tampering test demonstrates why structural validation must never replace endpoint authentication. No browser/native automation, personal data, installed app replacement or model changes are involved.
