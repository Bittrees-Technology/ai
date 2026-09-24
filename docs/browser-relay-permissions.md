# Browser relay permission review — work in progress

Browser permission enablement now requires the exact reviewed `deviceId` and `credentialEpoch`, in addition to the operation ID, expected prior permission, expiry and explicit confirmation. The server compares those fields against the current authenticated browser registration inside its existing locked transaction, before replacing or creating any permission. A newly registered browser cannot inherit a pending approval for its predecessor even when the owner session is unchanged.

Mac approval already names its exact device and epoch. Both browser and Mac input shapes use the same endpoint approval schema. Existing synthetic integration and browser fixtures now send the registration they actually observed. Missing identity fields are invalid input; mismatched current identity is denied without creating a permission. Actual PostgreSQL/HTTPS tests cover wrong identity/epoch, missing fields and same-owner registration replacement.

## Remaining browser interface work

The browser needs an explicit owner-scoped permission view that can inspect the current browser permission, review enabling/replacing it, approve a current paired Mac, display its short-lived approval ID for the Mac, list retained permissions and revoke them. This must keep HttpOnly credentials out of JavaScript. The Mac's local acceptance remains a separate step and must not be represented as completed by browser approval alone.

Reuse the bounded relay request transport for metadata clients. Bind every response to the displayed owner, target endpoint/epoch, operation ID, exact reviewed permission and requested expiry. Retain an uncertain operation ID for explicit inspection; never automatically repeat an enable/approve action. Owner inspection/revocation must remain possible after an endpoint credential is lost. Browser registration replacement and account/scope changes must invalidate reviews and late responses.

Before enabling a browser permission, obtain the current verified browser registration; before approving a Mac, obtain the current paired device epoch and exact existing grant. Do not infer absence from a partial permission page. The existing API supports exact owner lookup and bounded history; a current-by-endpoint metadata lookup may be preferable to scanning all history. All mutations remain behind the explicitly configured remote policy.

This branch currently implements the exact browser registration check and integration updates only. The metadata client and visible browser approval UI are not implemented yet. No live routes, policy choices, installed app, Mac model or Acer news/model configuration is changed.
