# Explicit Mac relay response sending

The native companion can prepare and send a separately permitted task acceptance receipt or completed task result through its active private relay connection. These operations use the existing retained response outbox and the same key/peer/consent exclusion as task receipt. They do not start polling, auto-send results, choose a model, activate the installed app or grant browser result access.

Authenticated loopback routes:

- `POST /v1/private-relay/responses/prepare`: `{ connection: { id, expectedRevision }, response: { operationId, peerId, kind: "accepted" | "result", confirmed: true }, confirmed: true }`.
- `POST /v1/private-relay/responses/send`: `{ connection: { id, expectedRevision }, response: { id, expectedRevision, confirmed: true }, confirmed: true }`.

Both private task setup and relay setup must already be explicitly enabled. Each call verifies the paired Mac status identity, its separate native relay credential and the exact local credential revision. Recipient readiness is read under current relay authorization. Native custody provides its verified delivery deadline separately from the endpoint binding, so task-key/peer proofs retain the exact original binding.

Preparation caps a newly reserved response to the current sending and receiving connection deadlines. The retained authenticated response content still comes exclusively from the admitted task, its original receipt, current matching task consent and verified peer keys. Result content excludes source and memory projections. Receipt and result permissions remain separate. Preparation returns only local routing/state metadata and sends no ciphertext.

Sending checks the selected response revision before network readiness and again in the final SQLite delivery transaction after asynchronous key/consent resolution. The retained envelope must fit both current relay leases. A shorter replacement lease, expired deadline, local stop, changed consent, lost identity or changed revision prevents sending. Existing ciphertext is never rewritten or given a later deadline. A response originally prepared for a longer delivery window cannot be silently resealed for a shorter relay connection.

A send attempt is recorded before handing the immutable envelope to the transport. If the server reply is lost, the caller must refresh the local response metadata and deliberately retry with its latest revision. SQLite reopen retains the same response ID, message ID, sequence, deadline and ciphertext. The server's duplicate receipt reconciles that same message. The return value is marked `transportOnly`; it says the relay stored the envelope, not that the browser authenticated, accepted or displayed it.

No response ciphertext, plaintext, endpoint key or status/relay credential crosses these local routes. Current native callbacks and clients close on scope exit. Browser incoming dispatch/acknowledgement, visible response controls and actual browser-to-native return-path CI remain separate work; full private delivery is not complete.

Seven new engine tests use the actual companion controllers, custody, retained native endpoint crypto, SQLite, task consent, source-free worker, response outbox and loopback API. They cover authenticated acceptance/result opening, capped deadlines, exact retries across restart, stale revisions, shorter/revoked recipient permissions, result-consent separation, stop during readiness, concurrent deletion exclusion and revision/deadline changes during a held key read. Native slots and remote transport are synthetic. All657 local engine tests, typecheck, production/fixture build and unchanged contracts pass. Full existing synthetic HTTPS/PostgreSQL regression is checked separately; it does not by itself prove these new outbound controller routes against real TLS.

No live policy, service, personal Keychain, installed app, Mac model selection or Acer news/runtime/model is changed.

Follow-up integration evidence: the browser/native return path passed all 1,065 browser cases in run35960383875, and the actual Mac controls/authenticated local HTTP/real HTTPS/PostgreSQL flow passed all 1,092 cases in run35964935889. These dependent-branch runs use synthetic inference and credential slots; they do not establish live, personal Keychain or model-quality acceptance. The response package subsequently passed final checks and merged in PR169 (af151a6); later UI and queue recovery integration is covered separately.
