# CRM assignment processing over HTTPS

This inactive integration follows the ID Agents Manager pattern of dedicated
task resources with explicit claim and completion operations. Normal companion
startup includes an assignment service. It does no storage, network or model
work without a separately approved native capability.

| Method and route                                           | Owner and enforcement                                                                                                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/task-assignments/{assignmentId}/intake`         | Workflows creates or returns one run for the exact current CRM assignment and approved workflow version.                                                                                    |
| `POST /api/task-assignments/{assignmentId}/claim`          | Workflows validates the assigned device, CRM revision and approved workflow revision. Atomically creates or returns the same run and lease for the same idempotency key and exact payload.  |
| `GET /api/automation/tasks/{taskId}`                       | CRM verifies current read authority and returns the exact assignment and its bounded instruction.                                                                                           |
| `PUT /api/automation/tasks/{taskId}/results/{operationId}` | CRM verifies current write authority and assignment revision in the write transaction. Stores only the reviewed result with its operation ID and digest. Preserves owner fields and status. |
| `GET /api/automation/tasks/{taskId}/results/{operationId}` | CRM returns the durable receipt under current read authority. The runner requires this readback before completing the workflow.                                                             |
| `PUT /api/task-runs/{runId}/completions/{operationId}`     | Workflows verifies the current lease, exact assignment, and matching CRM result receipt. The first slice has no automatic successor.                                                        |
| `GET /api/task-runs/{runId}/completions/{operationId}`     | Workflows returns the durable receipt under current read authority.                                                                                                                         |

The native host must provide current action authorization and a protected
HTTPS transport. Authorization sees the exact method, URL, body digest and
operation ID or the inference input digest. The service still authorizes the
action at commit time. The transport must enforce the reviewed destinations,
credential custody, TLS/DNS policy and a durable request budget. Task text is
untrusted model input. The local assignment model adapter frames that text as
data and requests a structured result from a pinned Ollama model. Ollama checks
the assembled prompt and schema against the context budget. When supplied with
the shared model queue, the runner reads the task and checks inference authority
inside the turn, after waiting for the model.

The encrypted runner journal retains stable claim, result and completion IDs.
A claim can be attempted twice with the original key. An interrupted inference
holds on restart. After a possibly committed result or completion the runner
reads the original receipt and sends no second write. A missing receipt requires
reconciliation. A resumed run requires current authority and an unexpired lease.
The local status projection reports the assignment revision, run, last confirmed
receipt, phase and typed block reason without returning task or result text.

The service checks admitted assignments every 30 seconds, shares the local
model queue, and pins the approved model digest. Pause and a three-attempt limit
persist across restarts and new review epochs. The Workflows page shows the
phase, task/workflow revisions, attempts and confirmed receipt without task or
result contents. The local status and pause/resume routes require the normal
companion authentication boundary. Resume never grants source access or resets
attempts.

The native bootstrap can use `launchNativeAssignmentService`. It requires an
already reviewed batch, current enrolled worker identity and nonrenewable Roles
lease, exact connection ID, matching public key, protected credential provider,
native signer/attester, durable request budget and current source/cost verifier.
It provides only the typed loopback capability to the model core. No default
bootstrap discovers or creates these bindings.

The review must additionally pin an independent validator ID and code/rule
revision for the exact workflow. Without it the service holds before intake or
inference. The validator is a trusted native/source implementation or independent
review process; it is never the generating model or a caller-supplied pass flag.
It must read the current source itself and verify task-specific acceptance
criteria. Unsupported workflows remain held rather than using schema validation
as a substitute for task fulfilment.

After inference the runner refreshes the task and requests independent validation
of the exact assignment/revision, workflow, input digest, result digest, source
result operation and work lease. An accepted receipt lasts at most 30 seconds
and cannot outlive the lease or native review. The encrypted journal retains
the receipt and exposes only validator identity/revision/time in status. The
native broker independently rechecks authorization and refuses write/completion
calls without a current accepted result. A core caller cannot bypass this gate
by omitting the separate authorization call or changing the result/operation.

Rejected validation retains the existing model result. Recovery revalidates it
under current authority without repeating inference. Old completed records
without validation evidence are labelled `completed-unvalidated` and never
silently promoted or replayed.

`AssignmentNativeHTTPS` accepts only canonical typed POST operations to
`https://mcp.bittrees.org/v1/crm-assignments`. The existing task-sync HTTPS profile
does not accept that route. The adapter pins a validated public IPv4 address,
verifies the canonical TLS hostname and chain, refuses redirects and unexpected
headers, bounds bodies and time, and checks native admission before and after
DNS and response receipt. Gateway bearer credentials stay outside the core and
the admission projection. CRM source credentials stay at the source/gateway.

Before signing, the native gateway checks the exact worker/runtime lease,
connection, assignment revision, workflow, claim/completion operation ID, source
result operation ID, result digest and gateway parameter digest. At most one
signed challenge continuation is sent. Revocation while signing blocks it.
Request and response budgets remain durable, including challenge exchanges;
the native gate consumes response bodies before releasing them to the caller.
An uncertain operation is reconciled by the runner under its original ID.

The coordinator's registration attester recognizes only the two assignment
decision actions, `workflow:claim` and `workflow:complete`, with an exact
`workflow:<id>` resource and execute stage. It uses the existing registered key,
current device authority, signature and freshness checks; decision attestation
does not insert a runtime key, grant permission, create a lease or write a task.
The native gate binds the returned short-lived attestation to the challenge,
worker credential and CRM source workspace. Roles still verifies its trusted
issuer and current execution authority independently.

Staged native acceptance uses actual local CRM/MCP/Workflows handlers with
temporary isolated databases, synthetic enrollment/authority and an actual
pinned local model. It verifies lost CRM response reconciliation and revocation
before writeback. This does not establish production enrollment, source consent,
current Roles authority, runtime cost coverage, release or live synchronization.
The original CryptoDirectory nine-item retry scope and exhausted budgets are
separate and remain unchanged.

## Coordinator receipt retention

A full 10,000-row working queue no longer prevents new tasks solely because
terminal history exists. Before admitting the next task, the coordinator
atomically retains terminal receipts in an encrypted history table, preserving
the exact original ciphertext and IDs. Running and queued callbacks stay in the
working table; their serialization, cancellation and uncertain-result rules do
not change. Recent status includes retained receipts across restarts. This is
history retention, not a retry-budget reset or source-operation replay.

Retention fails closed on a transaction conflict, below the 20 GiB free-space
reserve or at the 256 MiB queue database limit. Those conditions require a
verified history export rather than automatic deletion of evidence. No original
receipt is discarded by retention.

## Separate source status finalization

An assignment review may explicitly set `completeTask: true`. Omitted/false
keeps source status unchanged. The native runner pins this choice when creating
its encrypted journal; enabling it later cannot promote a previous completed
assignment into a status write. It is admission scope, not a CRM permission or
Roles grant. CRM and Workflows still independently verify current authority.

The runner durably distinguishes central completion, source finalization started,
and source finalization confirmed. Central completion is saved before status work.
The original central completion ID also correlates its separately approved CRM
status transition; the result note retains its distinct original CRM operation ID.
A successful status write is confirmed through a readback of the exact task ID,
expected next revision, Done status and original operation. The native transport
uses typed `finalize`/`finalization` aliases; the source receives strict mutating
complete/read-only completion operations under fresh exact Roles parameters.

A lost central reply recovers only the original central receipt. Once central
completion is confirmed, recovery skips task-input reads, inference, validation
and result-note writes. It can reconcile a confirmed completion after the old
work lease or validation receipt expires, but still requires current native
review, runtime identity, Roles and source authorization. It does not renew a
work lease or authorize another generation/write. Expiry before an unconfirmed
protected effect continues to fail closed.

An uncertain status write can only use its read-only original-operation lookup.
Both central completion/reconciliation and source finalization/readback are
bounded to two dispatched operations each, including across restart. No new IDs,
mutation replay or counter reset is used to escape a hold. Revoked status approval,
changed/edited source revisions and missing receipts remain held. Operator status
separates central completion, source confirmation and exhausted recovery budgets.
The service skips redundant intake when a durable original run is already known.

Native challenge validation covers exact intake/task/result-write/result-read and
completion/finalization parameters. Source status operations require the separate
review flag before any gateway dispatch. Runtime registration still recognizes
only workflow:claim/complete; these signatures do not enroll or grant a worker.
Local failure tests are synthetic evidence, not a live production acceptance run.

## Normal native launcher setup

The normal Mac launcher now invokes `launchAssignments` with its shared native
vault unlocker. Without `native-assignments.json` it returns without a vault
read, socket, model action or assignment budget database. Invalid setup logs a
hold and leaves the capability disabled; it never falls back to task-sync or
an investor dataset. The installed app is not configured by adding this code.

The protected, current owner setup binds the existing central state and gateway
credential digests, exact workflow connection, profile/model, reviewed assignments,
separate status scope, source workspace, signed Roles activation receipt, trusted
Roles/Workflows/registration signer pins, explicit device/authority/owner identity,
source approval and finite request budget. It is paired with protected evidence
covering MCP, Roles, Workflows, CRM and the AI registration service, current
account/plan/resource bounds and either verified included usage or an explicit
bounded aggregate spending approval. Older
central/release evidence omitting these services is insufficient. Configuration
files pin admission and do not create grants or establish billing facts themselves.
No production setup file or activation receipt is generated by the implementation.

Explicit spending admission requires `runtimeApproval` in the protected cost
evidence. This pins the actual owner approval ID/reference, independent pricing
evidence reference, existing Neon/Vercel provider scope, one nonrenewable window
of at most four hours, maximum aggregate microdollars (at most US$10), request
count, and full downstream worst-case price ceilings for enrollment, central,
assignment and attestation attempts. These values must be independently verified;
an estimate, existing plan or this schema is not spending authorization. An included
usage proof cannot carry a positive allowance or an explicit paid approval.

These are maximum supported funding-review bounds, not default spending approval.
Use the owner's actual amount and deadline, which may be smaller. A longer
funding window does not extend native consent, a work lease, a task's finite
execution limits or an original retry budget. It permits separately approved
setup and task operations to share the same immutable allowance across that
window. Increasing a limit in software does not reprice or renew an existing
ledger approval; a changed review under the same reference still fails closed.

All three native launchers use the same encrypted `native-runtime-cost.db` under
the existing personal vault. Each outbound attempt reserves its whole reviewed
ceiling before DNS, in an immediate durable transaction. Failed/uncertain attempts
retain that reservation. Helper restart, a new run or replacement review epoch
cannot replace the approval or restore its allowance. Exhaustion and clock
continuity failures stay held. Existing request/byte/work limits, one-use model
admission and current source/Role checks still apply independently. No runtime
approval is generated, enabled or inferred by installing this code.

A review may additionally specify one `sharedResourceReservation` for an
independently verified physical Neon resource shared by every covered wire. It
pins the provider, exact resource/evidence reference, full fixed interval and
maximum microdollars. The interval must cover the entire funding window; at
most fifteen additional minutes may be priced for already dispatched downstream
work and idle suspension. That priced tail never permits another request after
the original funding expiry. Resource identity, CU limit, current price, service
bindings, time bounds, storage and transfer coverage must be verified separately;
the optional schema itself is not admission or a price calculator.

The full shared amount is durably reserved in the same transaction as the first
wire, even if a helper starts late. Other helpers and restarted processes retain
that exact reservation. Per-wire ceilings still cover every resource not already
covered by the fixed amount. Reviews without this optional field retain their
original full per-wire accounting. No used approval can be repriced to add or
remove a shared reservation, change its resource/interval, recover funds, shift
the financial window or reset attempts. Aggregate exhaustion, clock discontinuity
and revocation continue to stop dispatch before DNS.

Only the existing central signing key is used, with the exact native challenge,
workflow and credential scope. The separate existing coordinator control bearer
can request a signed decision attestation for that registered principal. It is
never copied into the gateway store or core. The dedicated attestation HTTPS
profile permits only the fixed AI decision route, verifies public DNS/TLS and
refuses enrollment, activation, device registration, cookies and redirects.

After the actual pinned local model is checked, the core must obtain a one-use
native model-start admission. The native helper checks the current protected CRM
input and obtains a signed read-only Workflows proof of the actual running
assignment/run/lease. This uses the original future result-operation ID; it never
claims, renews or writes a result. The proof is bound to the exact locally signed
Roles challenge, connection, runtime credential and expected result digest. A
terminal/expired/forged/replaced proof blocks generation. The start permit cannot
outlive that proof, the native review or one second. Generation is separately
bounded by the review expiry, including during model pinning.

Model admission is saved before release, with an assignment-bound durable no-repeat
record that survives restart and changed review epochs. Aggregate encrypted request
and byte reservations also survive restart; a new review cannot reset an original
assignment's model admission. Existing original-nine budgets remain separate and
untouched. No server grant, key, lease activation or network call occurs on setup.

### Independent acceptance coverage

The concrete `owner-pinned-outcome-v1` validator accepts only separately reviewed
exact assignment, source instruction and expected result digests. Its revision
includes the acceptance criteria and reviewed evidence references. Expected result
criteria are not supplied by the model or exposed through core IPC. A fresh source
and Workflows lease check precedes validation; model output remains a candidate.
This is a real exact-outcome verifier, not an independent verifier for arbitrary
research or claimed external actions. Such work needs an appropriate domain
validator and remains held. Never substitute fixture criteria for actual business
acceptance or describe this limited validator as full live coverage.

Local tests exercise real encrypted central custody, signature verification,
protected native IPC, the complete native challenge/registered-attestation/lease
proof exchange with synthetic service responses, one-use model admission, source
and operation pinning, denied setup, wrong acceptance and exhausted reservations.
They do not establish production source consent, enrollment, current live billing
coverage or successful staged/installed business task processing. Full shipped
staged handler/model rehearsal and separately approved live acceptance remain.
