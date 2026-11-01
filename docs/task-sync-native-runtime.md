# Disabled native CRM transport candidate

This is local implementation and review preparation. It is not installed,
enrolled, granted, network approved, or ready to run against production.
`taskSyncNativeTransport` is deliberately not imported by native startup. Its
disabled branch returns before reading scope, keys, credentials or authority.
There is no configuration loader or automatic fallback to direct source access.
The installed offline policy is unchanged.

The candidate accepts typed operations, derives destinations itself, rejects
caller URLs/headers, obtains gateway/coordinator credentials only from the
native owner, and never returns those credentials. It neither creates keys nor
substitutes a task-sync identity for a central or other purpose identity.

| Method | Host               | Exact path and operation                                                                                                       |
| ------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| GET    | agent.bittrees.org | `/tasks.json`, no credentials                                                                                                  |
| POST   | mcp.bittrees.org   | `/v1/task-sync/connect`, signed activation receipt, no bearer                                                                  |
| POST   | mcp.bittrees.org   | `/mcp?mode=selected&projects=<exact reviewed ordered projects including crm>`, only `task_sync_preview` or `task_sync_execute` |
| POST   | roles.bittrees.org | `/api/mcp/runtime/start`, `/poll`, `/complete`, exact owner handoff                                                            |
| POST   | ai.bittrees.org    | `/api/workflows`, only `runtime-attestation` with typed purpose                                                                |

HTTPS port 443 only, redirects rejected. No arbitrary tool, URL, shell, direct
CRM access, source bearer, model call, heartbeat or catalogue operation is added
to this connector. Host and path admission must both be enforced by a future
native helper. The core stays loopback only. An OS IP/port allowance cannot
enforce HTTP paths, prove TLS/DNS trust or supply source authorization; no broad
network sandbox exception is proposed as a substitute.

## Durable run limits

`TaskSyncRunBudget` requires a separate exact scope digest and finite review:
run UUID, issued/deadline times (at most one hour), work attempts, aggregate and
per-kind requests, cumulative request bytes and response bytes. No default
allowance exists. The runner stores this in its existing encrypted SQLite state
with an immediate transaction. Reservations precede every wrapped request or
callback, including failures. Source attempts are charged before the source
fetch, closing the previous uncounted retry loop. Completed last imports finish
without another source fetch. Restart, resume, explicit connection retry and
rebinding the same review do not replenish the budget; replacement is denied.
Expiry, clock rollback, corrupt state, changed scope and exhaustion hold work.
There is intentionally no reset API.

The HTTP wrapper accounts request URL/headers/body and response headers/chunks
before release, bounds waiting and streams, propagates abort and rechecks scope
while reading. The runner's existing opaque attestation/enrollment callbacks
charge one invocation and serialized payload/result, not their hidden internal
HTTP bytes. Their current implementations have one outbound operation per call;
the parent abort is now propagated into the AI attestation HTTP/IPC path. They
must be routed through the native per-wire wrapper, or conservatively accounted
with independently enforced bounds, before claiming a whole transport byte cap.
Unrelated UI heartbeat/catalogue calls and downstream gateway/Roles/CRM database
or RPC work are outside this client run ledger. This is not an account spending
cap or proof of a zero-cost full sync.

## Remaining activation gates

The native owner must supply independently verified exact existing-purpose
identity, tenant/workspace/source bindings, actual source revision/tasks/mappings,
current policy and signed source permission, explicit native consent and a
nonrenewable budget. No IDs or budgets have been populated from a review bundle.
The synchronous `authorize` dependency is an offline verifier, performs no I/O,
and must verify current signed Roles/source evidence, proof signatures, fresh
request and operation/lease/task binding against the exact prepared request
digest. A hash alone is not authorization. It must not be replaced by a flag,
model response or identity inspection result. Any future remote authorization
request needs its own reservation through the same native ledger.

The production verifier, protected IPC listener, credential custody assembly,
TLS/DNS admission, actual source bindings and signed consent remain unwired.
Owner enrollment, activation and attestation are different typed operations;
permitting one must not permit the others. No native configuration, enrollment,
grant, source request or signature has been performed by this candidate.
Cost coverage and all exact-head release checks are separate gates. Local tests
use only synthetic identities, in-memory stores and fake transports.
