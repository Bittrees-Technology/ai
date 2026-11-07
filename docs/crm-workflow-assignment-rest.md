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
