# Native private-relay credential custody

This inactive library lets the Mac host review its own pending relay permission, explicitly accept it once, and retain the returned relay credential separately from its status credential. It adds no setup UI, startup hook, relay polling loop or live host configuration. Host integration and native acceptance remain required before activation. It does not select or change any model, contact Acer, or provide an inference fallback.

`RemoteClient.withPrivateRelayEnrollment` first verifies the current status identity. Its short-lived callback can inspect only the current Mac's permission metadata, accept once, identify a separate relay credential, or revoke it. Credential/identity changes, closed callbacks, unexpected origins, redirects, response types and oversized bodies deny the operation. This bridge is internal to the trusted native host: its acceptance result must never be returned to the browser/UI. Inspection never reissues a secret after an uncertain acceptance.

`PrivateRelayCustody` keeps encrypted permission metadata in the task database and the credential in an independent native slot. `macPrivateRelayEntries` reuses the bundled add-only Keychain helper with a distinct account domain that includes the local owner, profile and random slot ID. Constructors perform no native I/O. Tests use synthetic secret slots; the helper has not accessed a personal Keychain as part of this work.

## Review and interrupted setup

Review records a short-lived, one-use confirmation tied to the exact grant, device epoch and local generation. Confirmation re-inspects that metadata, reserves an encrypted SQLite journal row, records an add-only attempt marker, accepts the remote permission once, saves its separate credential, verifies native readback, then activates the exact journal revision. Per-owner uniqueness prevents two handles from reserving the same permission or creating concurrent unlocked setups.

A lost acceptance response or interrupted native write leaves the record in `accepting` or `storing`. Explicit reconciliation can report the current server metadata but never promotes an interrupted, stopped or restored record into active use. Repair requires revoking the uncertain remote permission through its owner's controls and reviewing a new permission. The library never retries one-use acceptance.

## Use, stop and deletion

Each `withClient` operation requires a fresh verified status identity, the exact unlocked active journal revision, a matching native secret, and a separate relay identity inspection. The scoped client rechecks journal state around network responses. Escaped clients become unusable when the callback closes. This transport permission does not grant permission to decrypt or execute tasks; endpoint keys, peer checks and task consent remain separate.

Local stop immediately persists a locked record before any network revocation. If remote revocation fails or its reply is lost, the local stop remains in force. A subsequent explicit revoke can inspect the metadata and confirm an already completed revocation without reissuing a secret. Local deletion reports only observed native credential absence, not remote revocation or guaranteed physical erasure.

Local deletion first erases encrypted metadata and fences late callbacks in SQLite, then persists an add-only native deletion marker and removes the credential. Failed native cleanup stays queued. Global content deletion uses the same database fence; the native host must explicitly drain cleanup through the bounded cleanup API. Opaque slot IDs and keyed permission fingerprints are retained to prevent replay and permit repeated cleanup if an in-flight native write finishes late. Native attempt/deletion markers are also retained. The pilot caps these records at 1,000 per local owner and cleanup pages at 20; reaching capacity fails closed. These minimal authority/cleanup records are not task content.

## Storage and verification

Task schema 24 adds only the credential journal and its uniqueness constraint. JSON export includes permission metadata and `restoreAuthority: false`, never relay secrets or their fingerprints. Encrypted backups contain no relay credential; restored journal rows are locked with an advanced revision even when a native entry still exists. Old task23 writers reject the new schema, and an original task23 backup remains available for rollback to the older engine.

Tests cover actual SQLite reopen, concurrent handles, one-use expiry, lost acceptance/revocation replies, interrupted native storage, delayed writes after stop/deletion, global deletion during a held response, identity mismatch, metadata replacement/rollback, credential corruption, cleanup retry and backup restore. The full synthetic HTTPS/PostgreSQL integration exercises the real native enrollment bridge, journal, relay client and revocation endpoints. `scripts/check-private-relay-custody-upgrade.mjs` verifies an actual compiled task23 engine against task24 with disposable data; recorded evidence lives under `docs/evidence/`.

Visible controls, host wiring, native helper acceptance in a disposable environment, durable encrypted delivery, live retention/hosting choices and independent acceptance are still separate work. No installed app or production service is changed by this library.
