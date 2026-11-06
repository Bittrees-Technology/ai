# CRM assignment processing over HTTPS

This local candidate follows the ID Agents Manager pattern of dedicated task
resources with explicit claim and completion operations. The routes below are
proposed contracts. The local runner is not registered with the Mac scheduler.

| Method and route | Owner and enforcement |
| --- | --- |
| `POST /api/task-assignments/{assignmentId}/claim` | Workflows validates the assigned device, CRM revision and approved workflow revision. Atomically creates or returns the same run and lease for the same idempotency key and exact payload. |
| `GET /api/automation/tasks/{taskId}` | CRM verifies current read authority and returns the exact assignment and its bounded instruction. |
| `PUT /api/automation/tasks/{taskId}/results/{operationId}` | CRM verifies current write authority and assignment revision in the write transaction. Stores only the reviewed result with its operation ID and digest. Preserves owner fields and status. |
| `GET /api/automation/tasks/{taskId}/results/{operationId}` | CRM returns the durable receipt under current read authority. The runner requires this readback before completing the workflow. |
| `PUT /api/task-runs/{runId}/completions/{operationId}` | Workflows verifies the current lease, exact assignment, and matching CRM result receipt. The first slice has no automatic successor. |
| `GET /api/task-runs/{runId}/completions/{operationId}` | Workflows returns the durable receipt under current read authority. |

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

The fixture tests use synthetic assignment, model, authority and REST responses.
Server routes, native authorization and model adapters, and scheduled execution
must be wired before a staged end-to-end run can validate this integration.
