# Finite central workflow safeguards

Installing these safeguards does not create an identity, enroll a device,
configure a connection, enable execution, grant source permissions or establish
spending coverage. A spending quote is not execution
approval. All tests use synthetic identities, a fake model and fake gateway
responses; no real model turn or production workflow is run.

## One reviewed run, at most fifteen minutes

The optional `finitePilot` configuration contains version 1, an actual reviewed
`reviewId` and `runId`, `approvedAt` and `expiresAt`. The interval cannot exceed
900,000 milliseconds. These are required source/native review values, not
generated substitutes for missing production IDs. The existing connection,
workflow, delegation, owner/source scope and local model profile stay mandatory.
There is no default pilot package or new activation route.

Finite configuration requires an existing central-purpose identity and never
calls key initialization. A missing identity at dispatch holds work rather than
generating a replacement. Native saved-state binding now includes the finite
review: adding, removing or changing it invalidates an older native approval.
The native read-only identity review remains separate from configuration and
grants no enrollment or runtime authority.

An encrypted ledger in the existing central state database binds the exact
review and configuration, including credential digest. It persists counters
before dispatch with immediate SQLite transactions:

| Operation              | Maximum | Logical identity                        |
| ---------------------- | ------- | --------------------------------------- |
| Claim                  | 1       | Saved claim operation UUID              |
| Renewal                | 1       | Saved renewal operation UUID            |
| Model turn reservation | 1       | Saved generation operation UUID         |
| Completion             | 2       | Same completion UUID and saved evidence |

The normal path uses three gateway actions. Only a lost/uncertain completion can
leave one bounded reconciliation opportunity. That reconciliation uses a fresh
Roles proof but the original completion operation and cached evidence, without
claiming, renewing or generating again. After another failure or a confirmed
completion, the worker disables itself. Calls are never refunded. No budget
reset, review replacement, deadline extension or remove-the-finite-flag escape
is provided. Existing native transport attempt/cost reservations remain separate
and must also be limited to the independently reviewed four-attempt pilot.

The claimed job must match the approved run and its first step. No work, a
different run/step, an expired lease, a failed claim/renewal, unexpected successor,
exhaustion, scope change, clock rollback or deadline stops the finite worker.
It does not poll for another job or automatically reclaim an expired lease.
Successful completion disables the finite connection even if the source reports
a successor; an unexpected successor is held for source reconciliation, not run.

Deadline and clock checks happen before admission checks too, so a busy local
model cannot leave an expired pilot enabled forever. Observed time is persisted
without moving the original deadline. A shared cancellation deadline covers the
task queue and work; existing tighter admission windows and per-request bounds
remain in force. Waiting for headers, streamed responses, model pinning and the
model turn is cancellable even if an injected provider ignores cancellation.
That cannot prove that an unresponsive provider stopped computing: its result is
held, late output is not committed, and no replacement turn is started.

## Generation uncertainty survives restart

Before submitting a model turn, the worker atomically saves a reserved/started
generation marker, input hash, model/digest and operation UUID. Output is marked
recorded only after it passes the existing result limits and is stored as
completion evidence. A crash, thrown/lost inference result, interruption or
invalid output leaves the marker and job intact. Subsequent ticks, restart and
Resume cannot silently generate again. Concurrent workers cannot reserve a
second turn.

This uncertainty guard also applies to ordinary central workers. Their normal
continuous listening behavior after a confirmed job is preserved. Existing
cached completion evidence remains usable without regeneration. Legacy pending
jobs with neither evidence nor a generation marker are conservatively held:
older state cannot prove whether a model turn already ran. New operations carry
`journalVersion: 2`, allowing known pre-generation renewal recovery to retain its
existing behavior. No old job, evidence, key or database is deleted to reset it.
There is no automatic model-result reconstruction or manual-clear API in this
change; uncertain state requires independent reconciliation.

## Remaining native/source approval gates

The pilot still requires an actual purpose-correct public identity, current
Roles/source binding and delegation, the exact one-step text-only source run,
native owner consent, reviewed transport admission and independently verified
cost controls. A review UUID, `confirmed: true`, local counter or quote is not
authority or proof of zero cost. The native configuration/evidence files remain
operator-only and unprovisioned here; no numeric zero cost evidence is invented.

Before execution approval, the owners must review the combined identity UI and
guard release, pass the required exact-head release checks, verify the actual
source/native bindings, and confirm that the source
connection has only the intended run. Do not reuse the CRM task-sync key or
treat the text-generation pilot as the original-nine directory research bridge.
All nine directory receipt IDs, exhausted budgets, research runs and unrelated
workflow permissions remain separate. No new schedule, clock manipulation,
source request, model call or wallet action is authorized by installing these
safeguards. Software installation is separate from pilot execution approval.
