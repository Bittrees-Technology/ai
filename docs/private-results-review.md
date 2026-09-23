# Private response review

Status: internal browser interface, mounted only in the synthetic test fixture. The production remote page does not import it. No endpoint, network sender, background transport, task submission, key persistence or pairing is added. Mac task schema16 and browser database version1 are unchanged. The installed Mac companion, prepared archive, local models and Acer-server news processing remain unchanged and separate.

## User controls

History loads only after **Refresh history**. Rows show time, a short reference and status without decrypting prompts or results. **Review response** explicitly opens one authenticated stored result through `BrowserPrivateOutbox.readResult`, using the reviewed row revision. Completed output is labeled an AI-generated draft; failed, cancelled and expired tasks show fixed status descriptions. Model output is inserted only as text, never HTML, links, images or executable markup.

**Hide response**, Escape, focus loss, page hiding and page exit clear displayed plaintext and invalidate pending reads. Returning focus does not reopen output. Deletion review, downloads, refresh and retry changes also close the preview. The component does not retain plaintext in its own state, browser storage or downloads. JavaScript/DOM removal does not promise physical memory erasure or revoke copies already read by another program.

**Download encrypted history** exports current owner-scoped ciphertext and routing metadata as JSON. It is not an endpoint-key backup and cannot alone recover readable history. Object URLs are revoked after 30 seconds or destruction. **Stop retries** stops local outgoing handoffs; a task already accepted on the Mac may still run.

**Review deletion** clears the preview and captures the current history revision. Deletion requires a separate acknowledgement and explicit button. A concurrent history change rejects the stale review. Deletion removes browser history, preserves the Mac's independent history and requires fresh pairing before this browser can send again. It does not claim destination cancellation or remove earlier exported copies.

## Trusted mounting contract

`mountPrivateResults(root, api, scope)` accepts only the outbox's `export`, `readResult`, `stop` and `clear` methods. The host must supply a current verified scope value that changes on every account, key or permission change, and call `invalidate()` immediately on each change. A null scope denies opening. Scope values and DOM controls are not authorization: the backend still enforces identity, current peer/key permission, exact revision and authenticated decryption.

A generation counter rejects late reads after hiding or invalidation. While a preview is selected and the document is focused, a two-second revalidation calls the guarded reader again; deletion or authority loss clears the preview. This is a fallback for changes outside the current view, not instant remote revocation. A suspended browser cannot execute timers, so focus/visibility handlers and immediate host invalidation remain required. `destroy()` removes listeners/timers, revokes downloads and clears the view. Real registration, consent, persistent keys/recovery and production lifecycle wiring remain open.

## Visual and verification scope

The screen follows the existing remote interface: Avenir/system typography, ink `#183945`, evergreen `#28685c`, white paper, mist `#edf3f6`, border `#aabec5` and error `#8a2630`. A compact history list sits beside the readable result; below 700px it becomes a single column. Controls have visible keyboard focus and 44px minimum height. No remote fonts, images or motion are used.

The disposable GitHub browser suite exercises Chromium, Firefox and WebKit with actual encrypted companion results and synthetic keys. Scenarios cover literal malicious markup, keyboard review/hiding, late decrypted reads after blur, permission invalidation, reviewed deletion conflicts, export ciphertext, retry semantics and narrow-screen overflow. Explicit desktop/mobile screenshots are retained in the seven-day `private-results-ui-preview` artifact for visual inspection. This is browser-engine evidence, not personal Safari/WKWebView, installed-app, real pairing or independent cryptographic acceptance.
