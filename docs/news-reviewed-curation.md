# Reviewed News preview editing

Connections → News starts with reading. An existing key must include `curate` in News before the companion can prepare an edit. The user loads an existing private newspaper preview, chooses a story, edits its headline/summary, reviews exact before/after text and separately confirms curation for that change. Key storage never enables unattended writes. `publish` and `delivery` permissions are not used, even when present on the key.

The companion calls only fixed `get_connection`, `list_articles`, `get_preview` and `edit_preview_item` tools. No model, remote source URL, advertised tool or source instruction chooses a method. It cannot generate a preview, publish, send, change sharing permissions, add sources or change schedules. An account without a preview creates it in News first.

## Review and source consistency

The two-minute, in-memory review contains a server-generated ID, canonical exact edit, original story, source revision and bounded preview fingerprint. It is bound to the local owner and saved account/credential/scopes/expiry. Confirmation requires both `confirmed:true` and `curate:true`, accepts no replacement content, consumes the review before awaiting I/O, then checks current metadata and preview again before dispatch. Changed source content, revision, owner, credentials, permissions or expired review prevent the write. Loading a fresh preview, cancellation or removing the key invalidates the pending review.

[News PR3](https://github.com/Bittrees-Technology/news/pull/3) adds `edit_preview_item` under the existing curation scope. A row lock and exact revision allow one concurrent winner. It preserves unrelated stories—including excerpts too long for the older full-preview editing API—named feeds, source links, private-source permissions, current published snapshot and schedules. The edited story retains its original headline and is marked `user_edited`; owner-written summaries are not certified as source-grounded text. Headlines are 1–250 characters and summaries up to 2,000, with leading/trailing whitespace trimmed explicitly in review. Existing long content is never silently truncated.

After the call, the companion validates the returned revision and full projected front page against the exact expected edit, then checks authority again. Any failure after dispatch is **unconfirmed**, because the source may already have committed. There is no automatic retry or persisted write queue. The consumed review cannot be reused, including after a lost response. Load the source preview explicitly to reconcile; create a new review only after inspecting its current text. News revision checks also prevent a late competing save from overwriting a newer revision.

## Retention and limits

Preview and edit text remain transient in the dashboard; focus loss, unmount, refresh, source denial or expiry clears visible content and suppresses late responses. Hiding the window does not undo an already dispatched, explicitly approved source write. Server-side pending reviews expire after at most two minutes and are never persisted. Keys remain in the existing separate Mac Keychain entry and content does not enter task/memory exports or backups. Source changes remain stored in News under its own controls.

The fixed HTTPS/redirect restrictions, 25-second request deadlines, 8 MiB response bound, 100-story and 100-feed bounds apply. Only allowlisted front-page article fields and the number of feeds reach the UI; feed payloads and other source fields are omitted. This is exact manual story editing, not model-generated curation, ordering/removal, publication preview/approval or complete X1 acceptance. Acer's model/runtime/news jobs and the Mac's model defaults are unchanged.

## Evidence

Seven added engine/controller/HTTP suites verify explicit review and separate confirmation, strict intent, permission/account/local-owner binding, stale/expired/cancelled/replaced reviews, unsafe/bounded responses, duplicate denial, lost-response/post-write-access-loss handling, focus-loss/changed-text invalidation, protected routes and export omission. Four browser cases per engine cover exact review, keyboard confirmation, read-only access, uncertain reconciliation and late-save suppression. Review/saved layouts are captured at desktop and narrow widths in disposable GitHub CI.

The [actual integration receipt](evidence/news-reviewed-curation-integration-2026-09-23.json) uses the pinned News handler with disposable PostgreSQL and synthetic in-memory credentials. It verifies real source revision checks, exact edits, unchanged other-account data and long stories/feeds/snapshot/schedules, lost response after a real source commit, explicit reconciliation and revoked-key denial. No personal source key, native Keychain prompt, live publication, installed-app replacement or personal/native pilot was exercised. Schemas remain task21/memory2/browser1/import1.
