# Private conversations — implementation in progress

The Mac companion owns the selected local thread. Acer's model, runtime and news
briefings remain independent. This work does not install or activate any service.

The current implementation provides strict encrypted message framing and a Mac
consent boundary. It does not yet deliver conversations. The Mac review controls and authenticated local API are implemented; their
browser acceptance is pending. Independent browser consent now has an internal
implementation with authenticated offer validation, pending browser tests. Reviewed local offer export routes are implemented. Visible offer
controls/exchange, durable transport, shared incoming replay coordination
and end-to-end reconnect acceptance remain unfinished.

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
schema28, retained by schema29. Fresh/updated stores start with no grants. Local export includes saved
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
database's separate `conversation_consents` store (version8). The upgrade adds
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
This module is not yet wired to browser review UI or message transport.

Eight new browser cases (24 across three engines) cover authenticated/narrowed
offers, independent possession, immutable review, ciphertext retention/reload,
renewal, invalidation, clock bounds, offline revocation/clear, corruption and
current identity/peer revocation. A pinned build of the actual preceding version7
providers verifies preserved task consent/ciphertext, empty conversation consent
and old-writer refusal. These checks are authored and build successfully; their
GitHub browser execution remains pending.

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
is pending. Visible offer review/exchange controls and durable message delivery are
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
All761 engine tests pass. Visible controls and browser offer import/relay exchange
are still required before this becomes a complete user flow.

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
