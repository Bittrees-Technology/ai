# Mac private message connection controls

The Connections view now separates the Mac's private relay permission from status pairing, endpoint keys, browser trust and task consent. It can review a pending approval, save its separate credential, inspect permission metadata, stop locally, revoke remotely, remove a native credential, and check bounded cleanup batches. It does not send or receive encrypted messages or change local model settings. Acer inference and briefing jobs are outside this feature.

The packaged Mac host constructs `CompanionPrivateRelay` only when the bundled `PrivateKeyInstall` helper is present. Construction and saved-state inspection perform no Keychain or network requests. New acceptance is disabled unless the host explicitly sets `BITTREES_PRIVATE_RELAY=1` and supplies its separate status client. This is not a live hosting switch: remote private routes still require their own complete explicit policy. Existing local stop/removal/cleanup remain available when setup is disabled or the status connection is offline. No flag, installed app or service is changed by this implementation.

## Local API and exact reviews

The authenticated loopback API exposes saved metadata at `GET /v1/private-relay`, preparation at `POST /v1/private-relay/review`, one-use confirmation at `POST /v1/private-relay/confirm`, and immediate review invalidation at `POST /v1/private-relay/cancel-review`. It inherits the local API's Host, Origin and bearer checks. No route returns native or status credentials. Error responses use bounded codes, never native error details or request contents.

Acceptance takes the pending approval ID for this Mac. Other record changes bind its exact local ID and revision; cleanup reviews bind a cursor for at most 20 already requested removals. A review expires after two minutes or the remote approval expiry, whichever comes first. Wall-clock rollback, invalid monotonic time, another action, logout or review cancellation invalidates it. Confirmation requires explicit acknowledgement, consumes the review before validation or execution, and never retries automatically.

The visible panel distinguishes local stop/removal from confirmed remote revocation. A lost revoke reply leaves the Mac stopped; only a later authenticated permission check/revoke reconciliation can confirm the server state. Interrupted or restored setup is never promoted by reconciliation. If acceptance lost its one-use credential, revoke that permission in the owner's ai.bittrees.org controls before reviewing a new approval. Removing the local credential does not remove remote encrypted history or recover a lost credential.

## Deletion and lifetime

Blur, visibility changes, Escape, panel exit and local dashboard logout clear visible reviews and fence native enrollment callbacks. A UI fence request can fail when the local session has already closed; the server also enforces its own deadline and exact revisions. Successful user actions may have completed before a focus change, so refreshing saved state is the reconciliation path.

Global data deletion refuses to overlap active relay enrollment and refuses to skip saved credentials when a native provider is unavailable. It drains native removals first, rechecks all journal rows at the actual deletion transaction, then erases task data. Failed native removal leaves an explicit cleanup record. Previously deleted rows remain minimal locked tombstones; global deletion does not turn them back into pending cleanup. Tombstones and add-only OS deletion markers continue to deny late writes and replay. No startup or background cleanup loop is installed.

## Validation and remaining acceptance

Local tests exercise the real controller, custody journal, status identity client and authenticated loopback routes with synthetic secret slots. They cover explicit opt-in, one-use/expired/stale reviews, cancellation during a native write, offline stop/removal, failed cleanup, lost revoke replies, secret/error redaction, concurrent deletion denial and missing-provider denial. Frontend state tests cover late reviews, malformed responses and no automatic confirmation retry.

Three browser scenarios, each for Chromium/Firefox/WebKit, cover the actual React panel with a synthetic API: reviewed setup through removal, delayed review and uncertain revocation, and a 390px keyboard-cancellable review. They retain six screenshots per browser. These require disposable GitHub CI; no local GUI automation is used. Browser/visual acceptance and native helper acceptance must be completed before this feature is considered verified. Actual relay polling, replay/receipt coordination, browser permission setup, live retention/hosting and independent acceptance remain separate work.
