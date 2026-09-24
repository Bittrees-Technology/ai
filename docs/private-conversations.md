# Private conversations — implementation in progress

The Mac companion owns the selected local thread. Acer's model, runtime and news
briefings remain independent. This work does not install or activate any service.

The current implementation provides encrypted framing, separate Mac/browser
consent, reviewed Mac offer export and a browser file/paste offer review. Focused
built-browser consent checks passed in Chromium, Firefox and WebKit at commit
0514a768; full current-head browser and visual acceptance remain pending. Relay
offer exchange, durable conversation transport and reconnect acceptance are not
implemented. Shared incoming replay storage now participates in all current Mac receivers;
browser task/check and reviewed-offer integration are implemented with current-head
CI acceptance pending. Content receivers and historical coverage remain unfinished.

## Separate Mac consent

`PrivateConversationConsent` requires one explicitly selected existing local
conversation and personal user Inbox, one currently paired browser key, verified
possession of both endpoint keys, and the current account/device binding.
Approval is separate from private task, relay, model and source permissions.
Ordinary messages to the Mac, ordinary messages to the browser, questions to the
browser and answers to the Mac are separate choices. Answers require the
question direction; they do not grant task creation, publication, sending or
resumption permission.

A one-use review expires after five minutes or the chosen grant deadline,
whichever is earlier. Both wall and monotonic time bound the review. Approval
rechecks the current revision, identity proofs, Inbox definition and thread.
The returned review is a copy; editing it cannot expand authority. Grants last
at most 24 hours and never outlive the verified device binding.

Each peer/thread/Inbox tuple has an opaque conversation reference. Renewal keeps
that reference but issues a new permission ID. Previously resolved handles
recheck current permission, identity, possession and scope state on every use;
revocation or replacement denies them. Changing the selected Inbox definition,
even to an identical newly encrypted definition, requires another review.
There are at most 64 retained grants per local owner, bounded to 256 KiB encrypted.
Renewal of an existing tuple remains possible at capacity. Revoked entries remain
inspectable until content deletion; individual removal controls remain unfinished.

Saved grants use a separate encrypted `private_conversation_consents` row at task
schema28, retained by schema30. Fresh/updated stores start with no grants. Local export includes saved
conversation choices; deleting local content clears them and increments the
revision tombstone. Restoring a backup locks them. Reviewing one restored grant
revokes the others rather than silently restoring their access. Corrupt storage
denies access, preparation and export rather than silently resetting permission.

## Mac review controls

The existing Inbox shows conversation-sharing controls for the selected populated
thread. Loading saved choices is explicit; all new directions start unchecked.
Choose one paired browser and 15 minutes or one hour, inspect the exact thread,
Inbox, browser fingerprint, directions and expiry, then acknowledge and save.
The normal launcher keeps new private setup disabled. Saving does not send any
messages or enable delivery.

The authenticated local API provides `GET /v1/private-conversation-permissions`,
`POST /v1/private-conversation-permissions/review` and
`POST /v1/private-conversation-permissions/confirm`. Reviews share the existing
key/peer operation lock and are invalidated by competing permission/key reviews,
logout and local deletion. Confirmation checks fresh identity and the original
scope again. Saved access can be explicitly revoked offline.

Changing threads, leaving the window, hiding the page or pressing Escape clears
pending UI review. Late responses cannot reinstate a discarded review. Expiry is
bounded by wall and monotonic clocks; a lost confirmation requires refreshing the
saved choices, without an automatic retry. Revoking future access does not erase
messages or copies already shared.

## Independent browser consent

`BrowserConversationConsent` decrypts and authenticates an offer from the selected
Mac before preparing a review. The browser chooses a subset of the offered
message/question/answer directions, with expiry bounded by the offer and current
verified identity. The Mac-issued permission identity and opaque thread reference
are fixed by the offer. Separate local browser grant IDs cannot expand Mac access.
Task consent does not grant conversation access.

Choices are encrypted under a nonextractable browser key in the common private
database's separate `conversation_consents` store (introduced in version8, retained in version10). The upgrade adds
no grants and fences older writers. Each owner can retain at most64 grants;
renewing one peer/thread tuple replaces that grant and leaves other threads
unchanged. Explicit offline revocation preserves the record. Clearing choices
retains a revision tombstone and requires a fresh device identity before reset.
Status/export does not import authority.

Reviews are one use, bounded to two minutes by wall and monotonic clocks.
Confirmation rechecks current identity, both stored key/peer proofs and completed
possession checks in the same IndexedDB transaction as consent. Operation-scoped
access supplies a guard that a future content/replay transaction must run against
the current consent row. Resolving keys alone is not delivery authorization.
The module is wired to browser review UI; message transport remains unfinished.

Eight new browser cases (24 across three engines) cover authenticated/narrowed
offers, independent possession, immutable review, ciphertext retention/reload,
renewal, invalidation, clock bounds, offline revocation/clear, corruption and
current identity/peer revocation. A pinned build of the actual preceding version7
providers verifies preserved task consent/ciphertext, empty conversation consent
and old-writer refusal. The original 24-case focused browser preflight passed; current full-suite acceptance remains pending.

## Browser host and authenticated offer inspection

`BrowserConversationConsent.inspectOffer` authenticates a selected Mac's encrypted
offer and rechecks the current stored key/peer/possession proofs before returning
public scope, supported directions and deadlines. Inspection selects no permission,
creates no pending approval and writes no consent row. Opening another offer
invalidates any previous consent review. Prepare independently reopens/authenticates
the original envelope, and approval retains its existing one-use transactional checks.

`BrowserKeyHost.conversationAPI` now lazily opens this separate store and exposes
inspection, prepare/approve, owner-local history, offline revoke/clear and reset for
a fresh device. Online operations obtain their own verified device/peer context.
No private key or content-authority handle leaves the host. Logout, account/scope
change, device change, key cancellation and host close invalidate conversation work.
Task consent remains separate and cannot be widened by a conversation offer.

One additional three-engine module scenario verifies authenticated inspection
without grants or stored rows. Two host scenarios use an actual Mac offer and the
real browser identity service with synthetic registrations: narrowed approval,
reload retention, unchanged task consent, offline revocation and cancellation/account
fences. These host/inspection cases passed focused preflight at commit589258e; current full-suite acceptance remains pending.

## Independent browser review controls

The built browser setup page now includes conversation access alongside the
existing task permissions. Import a bounded encrypted JSON file or paste an offer,
select its already verified Mac, and explicitly open it. Only authenticated scope,
directions and deadlines are shown; all browser choices remain unchecked. File
selection replaces previous inspection, and late file reads cannot restore a
closed review. Browser choices may narrow the offered directions and last one,
fifteen or sixty minutes, capped by Mac permission and browser identity expiry.
Answers require question access. Saving reauthenticates the original offer and
shows exact conversation/Mac/fingerprint/choices before a one-use acknowledgement.

History, JSON export, exact-grant revocation and deletion remain available offline;
reset requires a different fresh browser device. Deleted choices cannot be imported
as authority. Mac grants, task permission/history and exported copies are separate.
Logout, other device/task reviews, blur, hiding the page, Escape and either clock's
expiry discard pending choices. Failed or late responses require explicit refresh.
No automatic offer opening, approval, message sending or retry occurs.

Three built-page scenarios (nine across all browser engines) use actual Mac offers,
independent possession checks and real browser identity/storage. They cover file
import with initially unchecked/narrowed choices, reload/export, offline revoke
and deletion, tampered offers, changed selection, expiry and competing task review.
Thirty desktop/phone previews cover opened offer, review, history, revoke and delete.
765 engine tests, typecheck and both builds pass; these new browser/visual checks
are authored but not yet accepted. Relay offer exchange and conversation content
transport remain unfinished.

## Retained Mac offers

`PrivateConversationOffers` prepares an offer only for a current, explicitly
approved Mac conversation grant. The encrypted local journal reserves the
operation/message identity and shared outgoing sequence before encryption. Resume
keeps that original identity; competing encryptors retain only the winning
ciphertext. Reveal requires current consent again. New preparation does not send
anything or approve the browser's independent choices.

An offer carries the opaque thread reference, current Mac permission ID,
directions and consent deadline; local thread/Inbox IDs and message content never
enter the offer. Its encrypted envelope can be opened for at most five minutes
and never after Mac permission expiry. Revocation, changed Inbox/key/peer/binding,
missing identity or expiry prevents preparing/resuming/revealing it. Offline stop
keeps history while preventing future reveal; copies already exported may remain
readable to their intended recipient until expiry, but cannot override current
Mac consent. The encrypted database export includes the journal and local deletion
clears it. Backup restoration locks both offers and consent.

Task schema29 adds the retained-offer journal and fences task28 writers. The
actual compiled task28 engine was used to verify preserved waiting tasks and
conversation consent, wrong-key isolation, empty offer state, old-writer refusal,
encrypted backup/restore and original-backup rollback. Seven offer tests cover
real authenticated decryption, exact retries/restart, competing encryption,
revocation/scope/expiry, offline stop, native-resolution invalidation, restoration,
owner deletion and corrupt storage. All755 engine tests pass. A browser consent
case now consumes an offer from this actual Mac module; fresh GitHub acceptance
is pending. Browser offer review/exchange and durable message delivery are
still unfinished.

## Reviewed local offer export

The authenticated local API now exposes `GET /v1/private-conversation-offers`
(history metadata), `POST /v1/private-conversation-offers/review` and
`POST /v1/private-conversation-offers/confirm`. Review supports creating a new
offer for an exact saved permission, revealing one retained original, or stopping
future reveal. It returns the local thread/Inbox, browser fingerprint, directions,
permission deadline and exact offer-opening deadline. Review creates no journal
entry and never returns ciphertext. History is owner-local and excludes ciphertext.

Confirmation consumes a two-minute review with wall/monotonic bounds and fresh
binding/key/peer/permission checks. The opening deadline shown at review is fixed;
a delayed confirmation cannot extend it. Create/reveal returns the original
recipient-encrypted offer after a separate acknowledgement. There is no network
upload or implicit browser approval. The shared key/peer operation lock prevents
local deletion during native resolution; logout and competing reviews invalidate
pending confirmation. A lost response requires refreshing history and reviewing
the retained offer, without an automatic retry. Stop works offline and does not
revoke copies already exported; current Mac consent still governs future content.

Five controller/API tests cover real recipient decryption, exact retry after
restart, scope and permission changes, expiry on both clocks, consumed reviews,
late identity responses, competing reviews, offline stop, authentication/origin,
delete/logout races, export/deletion and owner isolation. An additional journal
test verifies fixed opening deadlines and rejects expired/expanded windows.
All761 engine tests pass. Browser offer import/relay exchange
is still required before this becomes a complete user flow.

## Mac offer controls

The selected conversation now includes explicitly refreshed offer history and
reviewed create/download/stop controls. Only that thread's saved permissions and
offers are shown. One exact review shows browser identity/fingerprint, directions,
access expiry and the fixed opening deadline; its acknowledgement starts unchecked.
New offers download recipient-encrypted JSON. Reopening history downloads the
original retained ciphertext after fresh authority checks. No relay upload,
implicit browser approval or message delivery occurs.

Downloaded ciphertext is not kept in UI state or browser storage. Blob URLs are
revoked after download, on blur or unmount. Changing thread, hiding the page,
blur, Escape, expired review or late/lost responses prevents download. A lost
confirmation requires explicit history refresh and another review. Offline stop
clearly preserves already exported copies and points to separate consent revocation.
Permission review replaces the offer panel, preventing simultaneous confirmations.

Four panel-state tests cover one-shot confirmation, scope/destination checks,
monotonic expiry, offline stop and late/lost responses. Three actual-API browser
scenarios (nine across Chromium/Firefox/WebKit) cover recipient decryption of
downloaded bytes, exact retained retry, offline stop, lost-response reconciliation,
discarded reviews and thread changes. Twenty-four desktop/phone offer previews are
authored for CI review. Current browser and visual acceptance remain pending.

## Content boundary

Ordinary messages, questions and confirmed exact answers are distinct schemas.
Questions include task/question identity, task revision and deadline; answers
name that exact question and expected revision. These schemas only validate
framing. A receiver still must verify authenticated endpoint keys, both current
consents, the selected thread/Inbox, parent identity, current task and source
access, and consume replay state atomically with acceptance. An ordinary reply
must never unblock a waiting task. A delivery receipt means Inbox acceptance,
not execution, completion or reading.

Text preserves exact whitespace while rejecting blank content. Encoded messages
must fit the existing 64 KiB authenticated-encryption payload bound, including
UTF-8 and JSON overhead. Tests exercise real HPKE encryption/decryption and header
tampering. No new cryptographic primitive is introduced.

## Verified so far

Nine consent tests cover exact scope/directions, authority separation, foreign and
nonpersonal targets, review clocks/concurrency, native-resolution invalidation,
key-peer revocation, expiry, renewal, restore locks, export/deletion, corrupt
storage and capacity. Four contract tests cover strict message roles, bounds,
authenticated encryption and receipt semantics. Existing task and source checks
remain required. The compiled task27 engine is used by
`check-conversation-upgrade.mjs` to verify real upgrade, old-writer refusal,
wrong-key isolation and original-backup rollback. Synthetic test stores only.

Five Mac controller/API tests verify proof requirements, exact review, competing
reviews, changed Inbox definitions, rejected identity, offline revocation,
authentication/origin restrictions, deletion exclusion, logout fencing and local
export/deletion. Four UI-state tests exercise selected scope, acknowledgement,
one-shot confirmation, late responses, expiry, lost-response reconciliation and
offline revocation. All 748 engine tests and the production build pass locally.
Six browser cases and twelve desktop/phone review previews are authored for
Chromium, Firefox and WebKit acceptance on disposable GitHub runners; they are
not yet accepted evidence.

The overall private-content requirement remains open. Passing these module tests
does not establish conversation delivery, browser consent, source authorization,
independent cryptographic review, model quality or live deployment acceptance.


## Shared incoming replay: current Mac receivers integrated

`private-replay.ts` derives portable identities only after authenticated decryption
and strict payload parsing. The authenticated type distinguishes operation roles;
`task.accepted` and `task.result` can share an operation without sharing a message
or a directed epoch-channel sequence. Changed ciphertext under an existing identity
conflicts even when its decrypted text is identical. This helper is not authority.

Task schema30 adds `private_incoming_replay`. Its owner-scoped unique operation,
message and sequence indexes retain an encrypted identity and outcome reference.
The store is bounded to 4,096 records per owner, refuses new records at capacity
without eviction, exports with local content and is removed by owner deletion.
Backup retains replay records while existing restore rules lock endpoint authority.
The helper requires the caller's existing SQLite transaction; it never opens a
second transaction around Inbox or task effects.

Mac task admission, device-check challenge/response and acceptance-receipt receivers now consume that shared identity with fresh permission/key checks and their task, check or receipt effects in one transaction. An exact retained task retry
preserves its original receipt and task. Collision, corrupt evidence or capacity
failure rolls back any new work. All current Mac receivers recheck live authority and deadlines after replay bookkeeping and before commit; expiry during ledger sealing rolls back the complete transaction. Actual receiver tests reseal authenticated messages with IDs or sequences already accepted by a different family. Task/check and receipt/check collisions are rejected without new work, outgoing sequence reservations or verification changes. Exact original receipt ciphertext is required; equivalent plaintext in a newly encrypted envelope cannot replace it.

All 781 engine tests pass, including sixteen new identity/storage/integration tests.
The actual compiled schema29 engine verifies preservation of tasks, receipts,
completed device checks and permission history; authenticated legacy retries add
one shared record without new work. Actual compiled legacy challenge, response and acceptance retries preserve their original check/outbox outcomes while adding shared replay evidence. Wrong-key isolation, schema29 writer refusal,
encrypted backup/restore and original schema29 rollback are verified in
`evidence/incoming-replay-schema-compatibility-2026-09-24.json`.

Before conversation activation, verify the matching browser IndexedDB transaction and complete content integration and legacy coverage. Older peer-check records retain incoming envelope hashes but lack incoming IDs and sequence headers; older Mac outboxes retain the acceptance payload without its incoming envelope.
An empty new ledger cannot prove those identities were unused. Preserve that
history and establish explicit reconciliation or a fresh-key epoch boundary before
a broader cross-family replay guarantee. Offer inspection still neither consumes
replay evidence nor acknowledges a relay message. Missing parents and denied task
answers must remain unacknowledged and consume no final replay record.


## Shared browser replay (version9; CI acceptance pending)

The existing common database now has `incoming_replay`, with unique indexes on
owner-scoped operation/role, message identity and directed epoch-channel sequence.
Every browser task acceptance/result and device-check challenge/response writes
this ledger in the same IndexedDB transaction as its retained outcome and any
outgoing counter change. Cryptography and hashing finish before the write lock;
current key, peer, consent and deadline guards run inside it. Exact original
ciphertext retries preserve the prior outcome. Newly encrypted replacements
conflict even if the plaintext is equivalent. Acceptance and result are separate
roles of one operation, so both may be received in either order.

This is hash-only metadata, not an encrypted content record: it stores the
protocol type, owner hash, four identity/transcript hashes and an existing-store
record reference. It contains no private text, key material or plaintext receipt.
Linked outcomes retain their existing encrypted storage and remain subject to
current permission. The ledger cannot authorize anything by itself, and missing
or mismatched linked outcomes cannot be recreated as duplicates. The namespace
uses `browserPrivateIdentity.scope`, shared across all receiver families; the
distinct local key scope is only part of device-check outcome references.

The bound is 4,096 records per owner, with no eviction at capacity. Targeted task
or check deletion preserves these minimal replay fences and shared counters;
removing all site storage removes them and requires fresh device setup. Broader
owner export/maintenance and fresh-key historical reconciliation still need
acceptance before conversation transport is enabled.

Version9 preserves existing rows and fences version8 writers. The pinned actual
version8 providers from `96c7172f7d3fec5132ce4dcd346e08466e94b257` are built by
`scripts/prepare-legacy-browser-replay.mjs`; the module archive SHA256 is
`6f4cc07df5dd940a5baf1cb81157fd22992637db45074165feddbc4a9bdf6078`.
The authored browser upgrade test checks preservation of tasks/keys and populates
one replay row only after authenticating a retained original receipt. No automatic
backfill or complete historical coverage is claimed. Ten new browser cases (30
across the three engines) exercise current receivers, cross-family collisions,
concurrent/reloaded retries, transaction rollback, expiry, corruption, capacity,
targeted deletion and actual previous-provider migration. Run those on disposable
GitHub runners; local compilation is not browser acceptance.


## Reviewed offer replay (version10; current-head CI pending)

Offer inspection and preparation remain read-only: neither consumes replay state,
accepts relay delivery nor saves consent. Only explicit approval admits the
original authenticated offer into the shared ledger and writes its encrypted
consent record, in one transaction. The encrypted grant retains the authenticated
offer identity; the ledger links to its local consent row and offer-operation
hash. This stable offer reference is separate from the browser consent ID.

A fresh explicit review of the same original offer may narrow or change choices
within its offered directions and expiry. It replaces the browser consent ID,
invalidates prior access and retains the one original offer replay record. This
is a reviewed consent change, never automatic approval on duplicate delivery.
Changed ciphertext under the original operation, message or sequence conflicts.
After a replacement offer supersedes the original grant, retrying the older
consumed offer cannot recreate its missing outcome or restore old consent.
Task receipts/results and device checks share the same identity namespace.

All hashing/encryption finishes before the write transaction. Current account,
key/peer proofs, possession, exact consent revision and review deadline are
checked again inside it. A quota error, changed identity or expiry during replay
insertion aborts consent and replay together. Targeted consent deletion preserves
the shared replay fence; it does not erase other protocol families' history.

Version10 adds no grants or replay records on upgrade. The optional `offerReplay`
field is absent from genuine old grants, and no historical IDs are inferred from
their plaintext offer. A fresh authenticated original-offer review can record
known evidence; complete historical coverage still requires reconciliation or a
fresh-key boundary before message transport. Older writers are fenced before
new grant metadata is written. The actual version9 provider module archive at
`ae3fa90eba1ea2b08febe21dae221ea51b63c0c1` is pinned with SHA256
`ae6439697861e6f83cbacf23ae18b7ffa9095658308d9cfb37a3b15cbbee26b6`.
Five new scenarios (15 cases across three browser engines) cover fresh narrowed
reviews and superseded offers, bidirectional task/offer conflicts, rollback and
late authority loss, competing reviews and actual version9→10 preservation.
Those new cases and the refreshed complete suite require CI acceptance.
