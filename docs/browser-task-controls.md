# Reviewed browser task controls

The signed-in recovery page mounts task controls over `BrowserKeyHost.taskAPI`. This is repository integration for explicit encrypted handoff with the Mac. It does not connect a relay or enable automatic remote delivery. Mac model choices and independent receiving/result permissions remain on the Mac; Acer-server news processing is unchanged and is never a fallback.

## Setup before pairing

Immediately after explicit browser registration, the user can refresh tasks and review local task-storage setup. The narrow verified initializer needs that actual fresh registration, its exact owner/scope and the expected history revision. It does not require a task grant or active key and cannot reserve/send tasks, create keys or allow a peer. This lets storage setup happen before the longer manual key and Mac-pairing sequence.

Missing storage is never automatically initialized. A deleted marker requires a different freshly registered browser identity; same-device reset is refused. Shared sequence counters remain intact. Expiry, reload, failed online work and scope loss invalidate freshness. Lost final verification may follow an initialized marker, so the user inspects saved history instead of replaying setup. Setup itself does not solve historical key recovery or renewal.

## Exact content and explicit handoff

The form offers question, summarize and draft tasks containing supplied text only. It has no model, app/source, tool, memory or approval selector. The full serialized payload byte limit is checked before opening a review; oversized input stays editable and consumes no task/sequence. The review shows the exact prompt, type, selected Mac, fingerprint, permission identity and original delivery deadline. Confirmation starts unchecked and uses the backend's original one-use review.

Confirmation saves encrypted preparation; it does not send automatically. Saved pending tasks expose a separate reviewed encrypted handoff. An interrupted preparation exposes explicit same-operation resume. Retry retains the original input, operation, sequence, ciphertext and deadline. Uncertain failures clear the view and direct the user to refresh history. No mutation is automatically retried.

The user can paste an encrypted acceptance or result from the selected Mac. Incoming content is structurally parsed but only the verified host can authenticate/admit it under current retained permission. A saved result remains hidden until a separately acknowledged read. Results and markup-looking prompts are inserted as text and never treated as HTML, instructions or executable actions.

## History and cancellation

Owner-local refresh, export, stopping retries and deletion remain available without a live sending request. Export requires its own review explaining that the original browser prompt is readable in the downloaded history. Mac results remain encrypted there. Downloads contain no preparation key handles or restoration authority; exported copies are independent of later deletion.

Stop preserves content and prevents later local handoff attempts. It cannot retract an already copied message or cancel Mac work already accepted. Deletion removes saved preparations/keys and wire history, preserves minimal replay counters and locks the old device marker. Content is retained until explicit deletion.

Reviews capture the original history/key/peer/check/permission snapshot and compare it before confirmation. Account/scope changes, device controls, Escape, focus/visibility loss, wall-clock rollback, monotonic expiry and teardown cancel reviews, clear prompt/result/message text and revoke outstanding download URLs. A committed mutation clears the old displayed history before refresh; a failed refresh must not restore the old task list. JavaScript strings, prior downloads and copies already released cannot be recalled.

## Verification and remaining work

Disposable GitHub browser tests exercise the actual built page, CSP, SIWE/HTTPS/cookies/PostgreSQL and retained browser/Mac providers, using synthetic task input and worker output. They cover setup ordering, exact review, explicit handoff/result round trips, interruption/uncertain-response recovery, current-permission changes, offline maintenance, cancellation, text rendering and desktop/phone previews. Final results and inspected previews must be recorded before this package is considered verified.

No personal browser/native automation, personal Keychain/data, installed app replacement, model download/default change or live deployment is part of this package. Automatic encrypted transport, conversation replies, approval-required effects, relay retention decisions, historical recovery/rotation and independent/personal/native acceptance remain open. Browser common schema6, Mac task23 and remote8 are unchanged.
