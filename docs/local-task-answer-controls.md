# Reviewed answers on this Mac

The companion Inbox now offers **Answer task question** for task-linked messages expecting a reply. Only an exact question recorded by the worker's input-wait transition can be answered. Ordinary Inbox replies remain messages and never satisfy that wait.

Opening fetches the question under current local owner, task, source and local-reference checks. Review fetches it again and requires the same task revision, question, deadline, conversation, inbox and status. The screen shows the question, exact answer and effect on the task. Confirmation starts unchecked and is consumed before saving. A waiting task becomes queued; a paused task remains paused and needs a separate resume. No permission is added by answering.

The local API binds the message path, question and task, requires an explicit confirmation, original revision and UUID idempotency key, and checks current source/local references before the atomic answer transaction. A duplicate with the exact original content, key and revision returns a minimal receipt. Changed retries, expired/cancelled work, other owners and ordinary messages cannot append an answer. Existing worker checks still validate model, dependencies and source rights before generation and result storage.

Question and draft display lasts at most two minutes from opening, also bounded by the question deadline. Both wall and monotonic clocks are checked. Blur, visibility change, Escape and disposal clear the draft/review and invalidate late reads. This is a bounded display window, not instant remote revocation or a claim of physical memory erasure. Nothing is added to the incremental message cache or browser storage. Hiding a save already dispatched cannot undo it.

An uncertain or invalid save response clears the review and never retries automatically. Reopen the question to check its authoritative answer association. If an answer was saved, the UI reports that and offers no further answer form. If it remains answerable, a new explicit review is required. This does not claim receipt of any particular answer when another local session may have answered.

Verification includes authenticated HTTP/SQLite source and lifecycle tests, controller race/clock/uncertainty tests, and the real Inbox component in disposable Chromium, Firefox and WebKit CI. Browser fixtures use synthetic HTTP replies; the engine tests exercise the real local HTTP routes and store. New UI screenshots are retained for visual acceptance. The full suite and previews must pass before integration/merge.

This package exposes the existing input-wait primitive locally. Model policy for deciding when to ask a question, separately consented encrypted remote conversations, and remote answer transport remain open. No installed application, personal data, native keys, live services, inference model or Acer news pipeline is changed.
