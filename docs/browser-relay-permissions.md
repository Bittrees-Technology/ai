# Browser relay permission review

Browser permission enablement now requires the exact reviewed `deviceId` and `credentialEpoch`, in addition to the operation ID, expected prior permission, expiry and explicit confirmation. The server compares those fields against the current authenticated browser registration inside its existing locked transaction, before replacing or creating any permission. A newly registered browser cannot inherit a pending approval for its predecessor even when the owner session is unchanged.

Mac approval already names its exact device and epoch. Both browser and Mac input shapes use the same endpoint approval schema. Existing synthetic integration and browser fixtures now send the registration they actually observed. Missing identity fields are invalid input; mismatched current identity is denied without creating a permission. Actual PostgreSQL/HTTPS tests cover wrong identity/epoch, missing fields and same-owner registration replacement.

## Bounded owner metadata client

`BrowserRelayPermissionsClient` uses the existing fixed-origin bounded transport, HttpOnly browser cookies and current owner/session scope. It verifies exact owner, endpoint, credential epoch, operation ID, expiry and revision on approval; bounded ordered permission pages; owner history and revocation; and rejects unexpected fields, including returned credentials. Scope changes and explicit invalidation discard late responses. Lost mutation replies require a separate explicit lookup by the original operation ID; no automatic retry is added.

The owner-only `/browser/relay/permissions/endpoint` route validates the exact current endpoint and credential epoch under the same authority transaction and returns its current nonrevoked permission or null. An existing permission may retain an earlier credential epoch after rotation: this is displayed replacement metadata, not usable authority. This avoids inferring absence from a partial history page. The endpoint route remains absent without explicit private relay policy.

Seven new engine cases verify the client. Two additional actual-browser scenarios (six cases across Chromium/Firefox/WebKit) cover rotation, paged history, owner revocation and cancellation using real HttpOnly cookies. These are authored and built, with execution reserved for disposable GitHub CI. Actual HTTPS/PostgreSQL integration covers endpoint absence, exact browser/Mac identity, cross-owner/epoch/CSRF denial, credential rotation, revoked/expired endpoints, owner client approval/replacement, explicit operation lookup, bounded history and revocation.

## Remaining browser interface work

The browser needs an explicit owner-scoped permission view that can inspect the current browser permission, review enabling/replacing it, approve a current paired Mac, display its short-lived approval ID for the Mac, list retained permissions and revoke them. This must keep HttpOnly credentials out of JavaScript. The Mac's local acceptance remains a separate step and must not be represented as completed by browser approval alone.

Reuse the bounded relay request transport for metadata clients. Bind every response to the displayed owner, target endpoint/epoch, operation ID, exact reviewed permission and requested expiry. Retain an uncertain operation ID for explicit inspection; never automatically repeat an enable/approve action. Owner inspection/revocation must remain possible after an endpoint credential is lost. Browser registration replacement and account/scope changes must invalidate reviews and late responses.

Before enabling a browser permission, obtain the current verified browser registration; before approving a Mac, obtain the current paired device epoch and exact existing grant. Do not infer absence from a partial permission page. The existing API supports exact owner lookup and bounded history; a current-by-endpoint metadata lookup may be preferable to scanning all history. All mutations remain behind the explicitly configured remote policy.

The exact registration check, bounded metadata client and endpoint lookup are implemented and tested. The visible browser approval UI remains unfinished. No live routes, policy choices, installed app, Mac model or Acer news/model configuration is changed.
