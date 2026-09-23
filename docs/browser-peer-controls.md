# Browser device identity controls

The signed-in recovery surface now includes public device identity exchange through `BrowserKeyHost.peerAPI`. Registration and saved-code/backup activation remain prerequisites for online invitations. The page creates no private task permission and does not yet complete reciprocal possession checks or private task transport.

## Exchange

Refresh saved devices reads owner-local public peer history and browser key metadata. It does not supply online authority. A saved key proof must match the observed local lifecycle revision and active key before new incoming invitations are offered. A changed key needs an explicit list reset. Every online action still performs the host's server identity checks and the registry's atomic active-key validation.

An outgoing invitation starts with the intended Mac device ID and an unchecked review. Confirmation produces a five-minute public invitation, the full fingerprint, selectable text and a public JSON download. No private key or recovery code is displayed by this view. The Mac must independently review this invitation.

An incoming invitation is parsed by the actual registry. Review displays the exact account, browser recipient, Mac identity, key version, prior identity if replaced and original fingerprint. The independent comparison field starts empty; its exact 64-character fingerprint and an unchecked acknowledgement are required. Confirmation submits the original review ID and list revision, never a reconstructed or silently refreshed review. Each review is single-use.

## Local maintenance

Public history export contains only the owner-local typed public snapshot. It is not a backup of private keys, a restore capability or a task grant. Revoke, reset and delete have distinct unchecked confirmations:

- Revoke works offline and reports local revocation only.
- Reset requires current online identity and keys, clears active pins and retains retired public-key history without pruning. After deletion it requires a different verified registration.
- Delete works offline, removes public pin/history payload and leaves the existing hashed device fence. It does not delete downloaded copies or remote devices.

## Cancellation and uncertain outcomes

Leaving the window, scope changes, another key/registration action, Escape, another peer action, destruction, clock reversal and wall/monotonic review expiry discard transient inputs. A host cancellation counter is a view coordination signal only, never authority. Before confirmation the UI checks the original local key snapshot; the backend separately checks atomic current state.

The UI requires a fresh history read after success or failure. A response can fail after a local commit; the error explicitly requires checking the saved list version and forbids replaying the consumed review. No rollback is promised. Pending UI operations have the original review deadline (or a two-minute read/prepare deadline) and discard late results.

## Validation and boundary

Disposable CI tests drive the actual built page with SIWE, HTTPS cookies, PostgreSQL and IndexedDB. They use actual retained Mac lifecycle/peer modules with disposable encrypted SQLite and simulated native slots, never personal Keychain access. Cases cover actual invitation exchange and reload/export, independent comparison, owner/recipient/expiry rejection, focus and key-control loss, review expiry, offline maintenance, cross-account display isolation, same-registration deletion fence, retired-key refusal, logout during verification and a dropped post-commit response. Desktop/phone previews are retained separately for visual inspection.

Browser database3, Mac task23, remote8 and browser outbox1 are unchanged. No model/default, installed application, public deployment, personal data, native interaction or Acer news-processing change is part of this work.
