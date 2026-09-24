# Mac generation boundary for incoming replay

New Mac endpoint keys retain `incomingReplayBoundary: "from-generation-v1"`
inside their immutable native record. Only cryptographic generation writes this
field. Loading or resuming an existing record never inserts it. Provisioning
copies verified provenance into the encrypted lifecycle slot and checks the exact
key identity, public key, current registration and lifecycle revision before
activation. Runtime resolution verifies agreement between the native record and
lifecycle slot. Unknown marker values fail closed.

Existing active keys and generated-but-preparing keys remain usable by current
features, without this coverage claim. An empty old reservation can obtain the
marker only if it actually generates a new key under the current provider. An
interrupted new generation resumes its original stored key and provenance. A
missing attempted key still requires explicit replacement; it is never silently
regenerated. No migration changes native bytes, rotates keys, grants permissions
or clears historical messages/replay records.

Schema32 fences older lifecycle writers before this state can be stored. Restore
preserves provenance as history while locking runtime authority. Logout,
revocation, deletion, changed owner/device, stale revision or retired key makes
the current-proof prerequisite fail. Native deletion tombstones and pending
cleanup retain their existing behavior.

## Required caller contract

`PrivateKeyLifecycle.validateReplayCoverage(proof)` is a synchronous prerequisite
for future conversation content admission. First resolve the current key through
the lifecycle, authenticate the envelope with it and bind the authenticated
recipient/device/epoch to the same proof. Recheck coverage, current independent
consent, exact parent/task/source rights and replay state inside the **same**
SQLite write transaction that appends Inbox content and saves its receipt. Abort
all effects if any check fails. No callback or HTTP input may supply provenance.
A previously returned boolean or proof must not stand in for the transaction-time
check. The current proof shape and existing task/check permissions are unchanged.

This package does **not** wire a conversation content receiver or implement the
browser boundary. It cannot establish that the eventual content transaction is
correct. Keep full A8/R2 and historical-boundary acceptance open until both ends
and their real message paths are verified. Existing receivers continue recording
shared incoming identities; metadata capacity remains bounded and no pruning is
introduced.

## What the boundary means

It establishes a starting point for history for the newly generated recipient
key. Old ciphertext cannot authenticate with that key or its new epoch. It does
not reconstruct unknown old message IDs or promise all-time global ID uniqueness
across earlier keys. Keep known historical fences: later cross-family collisions
with retained evidence must still fail. Never use an empty replay table, software
upgrade, recent timestamp, new consent or successful device check as proof that
an old key had no prior traffic. Exported/recovered key material must not acquire
this provenance through any future import implementation.

## Verification

Engine tests cover current-proof identity, owner/logout/revocation/deletion,
interrupted generation, preserved legacy bytes, unsupported markers and locked
backup restoration. The pinned actual schema31 compiled engine rehearsal creates
old active keys, generated pending keys and empty reservations, verifies schema32
preservation and older-writer refusal, checks old ciphertext against replacement
keys, and exercises encrypted backup/restore and untouched-original rollback.
See [recorded migration evidence](evidence/key-replay-boundary-schema-compatibility-2026-09-24.json).

The rehearsal uses temporary synthetic stores and in-memory key slots. Packaged
native CI, browser regression and final integration checks are separate gates.
This source change does not modify the installed companion, personal Keychain,
Mac model/runtime, Acer server or live relay.
