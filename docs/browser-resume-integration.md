# Browser resume request flow

The existing private-delivery setting now exposes a Mac resume requests panel.
Choose a saved exact-task permission, review preparation, then separately review
sending the saved request. Relay storage and authenticated Mac acceptance are
shown separately; neither is presented as completed inference.

The host retains the original ciphertext before any upload. Explicit retries use
that same request. Current device/peer/permission checks run before sending and
again around asynchronous submission. Incoming queue items are selected exactly;
a matching Mac receipt is authenticated and durably recorded before relay
acknowledgement. Users can inspect the next queue item without acknowledging the
one skipped.

History, export, stop and deletion use the existing owner-local maintenance APIs.
Deletion locks resume consent. Stop cannot withdraw data already delivered.
Reviews close on focus loss, account/version changes, expiry or another panel's
review. Confirmation compares the current saved snapshot with the reviewed one.

Validation is intentionally focused: typechecked production builds and one built
browser flow across the existing three engines, with desktop and phone previews.
The flow exercises real synthetic relay traffic, loss of an upload response,
original-request retry, skipping an unrelated queued offer and exact receipt
acceptance by the actual synthetic Mac resume module. It does not prove installed
Mac UI polling, model inference completion or a personal live pilot. Browser and
visual results remain pending CI at initial submission.

Acer news processing and installed app/model defaults are unchanged.
