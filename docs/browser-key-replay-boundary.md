# Browser generation boundary for incoming replay

Version12 of the common private database fences older writers before new key
records can contain `incomingReplayBoundary: "from-generation-v1"`. Only actual
new cryptographic generation writes that marker, with the immutable ready record.
Opening, upgrading, resuming an existing ready key or opening a recovery kit does
not insert it. Old active and generated pending keys remain usable by existing
features without acquiring a coverage claim. An empty old reservation can acquire
provenance only after genuinely generating new material. No keys rotate, consent
renews or history disappears automatically.

The provider checks provenance again after asynchronous cryptography. A changed
record cannot return an earlier covered result. The lifecycle verifies agreement
against its current active proof. Logout, expired/changed registration, stale
revision, wrong owner/scope/key, revocation, deletion and locked storage fail the
prerequisite. Missing provenance means unknown history; unknown marker values
fail closed. Recovery exports retain the existing format and never export this
marker as transferable authority.

`validateReplayCoverage` is inspection only. Future content receivers must
resolve the key and authenticate the matching envelope recipient/epoch first,
then call the synchronous `browserReplayCoverageMatches` with lifecycle and slot
records read in the **same** IndexedDB transaction as current independent
consent, shared replay and content/receipt effects. Trusted host context supplies
owner, scope, binding and time; network input or stored metadata cannot select
that authority. Never cache a successful boolean for later admission.

This package does not implement conversation content transport. Mac provenance,
browser provenance and the eventual atomic receiver must all be accepted before
the historical-boundary requirement closes. A new recipient key starts coverage
for that key; it cannot reconstruct unknown old message IDs or prove all-time
global uniqueness across previous keys. Preserve known historical collision
fences and bounded capacity. No replay pruning is introduced.

The compatibility provider is built from pinned commit
`5474f6767e2b7e1a8eb4c5731d6ee47d5e186f4b`, with a verified module archive hash.
New browser scenarios cover actual version11 active, prepared and empty slots,
version12 preservation and older-writer refusal, explicit replacement/reopen,
recovery after clearing, expired/stale identity, invalid/missing provenance and
changes during cryptographic resolution. They run only on disposable GitHub CI;
a built provider is not evidence those scenarios passed. Existing actual earlier
version tests retain their consent/task/replay assertions against version12.

The engine predicate test exercises scope/owner/current-key denial using real
synthetic recovery material. No UI or Mac schema change is included here. No
personal browser/key storage, installed application, model/runtime, relay service
or Acer news processing is modified by this source package.
