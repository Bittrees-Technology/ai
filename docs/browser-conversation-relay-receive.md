# Explicit browser conversation relay receipt

`BrowserKeyHost.relayConversationContentAPI.inspect` takes `{ after, confirmed: true }` and inspects one encrypted queue item. It returns transport selection/expiry/cursor metadata, never plaintext or an envelope. Inspection does not admit content, grant consent or acknowledge transport. Cursors are navigation positions; a new pass starts at `after: null`.

`receive` requires that same query, the exact inspected `selection`, and one explicit target:

- `{ action: "receive", grantId }` admits an incoming message or question through the existing browser content engine.
- `{ action: "reconcile", grantId, id, expectedRevision }` authenticates a storage receipt for the exact retained outgoing original.

The target selects a retained grant/copy; it does not confer authority. The host obtains current device/key/peer proof and relay permission, then polls one item and rejects any changed selection before decryption. The content engine verifies the directed keys, independent conversation consent, current generation provenance, scope, parent and shared replay identity. Other protocol families are denied without acknowledgement. Conversation access remains independent of private-task grants.

The relay's trusted synchronous lifetime check also runs inside content storage transactions, alongside identity, key and consent checks. Cancellation, expiry or lost authority during asynchronous crypto cannot bypass the final transaction guard. The host's shared operation excludes concurrent content/key/permission work.

Only a successful durable admission or receipt reconciliation permits transport acknowledgement. A reply whose parent is absent remains queued without content/replay effects. The caller can explicitly navigate to the parent and retry the original reply afterwards. A changed selection or omitted selection is never accepted implicitly.

If acknowledgement fails before server persistence, accepted content remains local and an explicit retry authenticates the retained duplicate. If the server saved the acknowledgement but its response was lost, the queue may be empty while local history contains the accepted original. Receipt reconciliation changes the retained row revision: after an uncertain result, refresh history and use the current revision. Retrying with the stale revision remains a conflict. Reconciliation never replaces the outgoing ciphertext or creates an incoming message.

Responses contain content metadata and a separate `transportOnly` acknowledgement. Admission does not prepare or upload an encrypted storage receipt automatically. Reading, sealing a receipt and uploading it remain separate actions. A received question alone does not answer or resume its Mac task; an exact explicit browser answer travels through the existing Mac admission/input-wait path.

Eight new synthetic browser scenarios exercise real browser storage, a PostgreSQL test relay and native companion code: acknowledgement loss before/after persistence and reload, exact receipt reconciliation and stale-revision retry, reply-before-parent navigation, changed/missing selection, failed-write rollback and revocation, cancellation during crypto/concurrent exclusion, another protocol family, and a real worker question/answer round trip through authenticated Mac HTTP. Disposable Chromium, Firefox and WebKit checks are required before merge. No schema or visible UI changes are introduced; reviewed receive controls and full offline/recovery/personal/live acceptance remain open.

Acer news processing, model/runtime choices, installed apps, personal keys/data and live services remain unchanged. The Mac companion keeps its independent literal-loopback inference path.
