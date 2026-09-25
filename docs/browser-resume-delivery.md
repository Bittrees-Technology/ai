# Retained browser resume requests

Work in progress: this internal controller is not exposed through the browser host,
user interface or relay transport. It does not run a model or contact Acer.

`BrowserResumeDelivery` retains one encrypted request per Mac resume permission.
Preparation pins the exact task, revision, model, peer, original permission and
expiry. Creating the original envelope reserves a shared sequence and retains the
same ciphertext across reloads. A new command ID cannot create a second request
under the same retained permission.

An authenticated Mac receipt records one accepted task transition, not completed
inference. The controller validates its exact command, route, task revision and
original permission before atomically storing it with shared replay admission.
The receipt may use the Mac offer's longer expiry, but every acceptance commit
still requires current browser consent. A duplicate must match the retained
receipt and ciphertext exactly.

## Offline maintenance

- `history()` returns owner-local metadata, without envelope or key material.
- `export({ confirmed: true })` produces that metadata with `restoreAuthority:false`.
  It is not an authority backup and cannot restore permission.
- `stop(...)` uses the exact grant, command and saved revision. It retains the
  original request and any receipt, prevents further envelope access, and cannot
  withdraw a request already sent. A receipt for that earlier request can still
  be reconciled while current consent remains valid.
- `clear(...)` checks the expected consent revision, deletes local requests and
  locks browser resume consent in the same transaction. It retains shared replay
  and sequence records. Resuming work requires fresh device setup; deletion does
  not make an old offer new or revoke an independent Mac permission.

These operations do not require a live connection or unexpired permission.
Generation and time checks fence asynchronous work; writes compare the exact
retained revision before committing. Corrupt encrypted history is not exported.
Explicit deletion can remove corrupt request rows while locking consent.

## Verification boundary

The common browser database advances from version 16 to 17 with a new
`resume_delivery` store. An actual pinned version-16 provider bundle and migration
regression are prepared. Node tests cover storage format, strict cross-field
validation, authenticated encryption metadata, key properties and tampering.
Browser tests are written for original-wire recovery, actual synthetic Mac
transition and duplicate receipt, offline stop/export/delete, stale revisions,
revocation and stop-before-receipt behavior. They must run on disposable GitHub
runners; local Node/build success is not proof of browser transactions.

Browser regression cases also cover corruption, a concurrent-window stop and
receipt/deletion transaction rollback. Before integration, execute these and the
migration/controller browser tests, expose reviewed host/UI/relay actions,
and resolve the existing shared browser delivery integration blocker. No live
activation or change to the Acer news model is part of this package.
