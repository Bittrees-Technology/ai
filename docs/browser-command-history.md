# Retained pause/cancel command metadata

The current hosted controller loses its command reference on hide or reload. This
module provides a bounded IndexedDB journal for the original reviewed command and
its last explicitly observed server outcome. It is an internal persistence
prerequisite: the controller and visible history/reconciliation controls are not
connected by this package, and durable offline command recovery is not complete.

Before any possible dispatch, the caller saves the original pause/cancel intent.
A saved entry means only that a request was prepared; it does not establish a
server receipt or an applied Mac action. An observation includes the exact server
command, observed state, optional matching receipt and local observation time.
Server-issued timing may be shorter than requested; identifiers, target, action
and reviewed task revision must match. A terminal observation cannot regress to
pending, and an acknowledged outcome cannot be replaced. Nothing resends a command.

The journal contains opaque command/device/task/owner IDs, revisions, timestamps
and allowlisted states. It rejects task text, credentials, private keys, new
commands and arbitrary fields. This is readable local status metadata, not an
encrypted task-content store or an authority grant. It uses a separate versioned
database so status-only users do not require private key enrollment and key-store
migrations remain independent. Future database versions fail closed.

The caller supplies the authenticated owner and a synchronous current-scope check.
Checks run before opening, inside the transaction and before returning data.
Transactions serialize writes and compare the owner history revision. A late
authorized metadata write may commit just before scope loss; callers must still
fence presentation and must never infer authority from persisted records. Clear
requires explicit confirmation and advances a small owner revision tombstone, so
old observations cannot recreate deleted history. No import or restore path exists.

Content is retained until explicit deletion, with no eviction or expiration-based
pruning. Limits are 100 entries per owner, 200,000 serialized bytes per owner and
100 owner documents per browser profile, including revision tombstones. Reaching
a limit fails visibly instead of dropping uncertain commands. The strict read
projection is also the export data; app-level download/deletion controls are a
follow-up. Corrupt records fail closed and require separate recovery handling.

Tests use actual disposable browser IndexedDB across Chromium, Firefox and WebKit:
reload and original-intent retention, owner isolation, terminal receipt binding,
cross-tab deletion and competing writes, invalidated scope, capacity without
eviction and newer-writer denial. No private data, personal browser automation,
model calls, live services or Acer changes are involved.
