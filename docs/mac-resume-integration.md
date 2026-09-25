# Reviewed Mac resume delivery

The private connection panel now opens Mac resume delivery. Choose a saved
connection and exact task permission, inspect one queue item, then explicitly
review accepting that request. Sending its retained acceptance receipt is a
separate reviewed action. A receipt confirms the resume transition, not inference
completion.

The local API uses existing key/peer exclusion and verified relay custody.
Authenticated task/model permission and replay admission commit before relay
acknowledgement. Receipt sends reuse the original encrypted receipt and recheck
current authority around submission. Owner-local status exposes saved receipt
metadata, not ciphertext or key material, so refreshing the UI does not lose the
ability to send an already accepted request's receipt.

UI reviews compare the current permission/connection/receipt snapshot with the
reviewed snapshot. Focus loss, cancellation, expiry and selection changes close
the review. Cancellation finishes before another operation begins.

The existing single three-engine browser flow now drives the browser and rendered
Mac controls through the actual local HTTP API. It covers an uncertain upload,
original request retry, reviewed Mac acceptance, receipt transmission and browser
receipt reconciliation, with desktop/phone previews. These updated UI/relay checks
await disposable CI at initial submission; prior direct-module results are not
proof of this integration. Eleven existing resume API tests and typechecked
production builds pass locally. No additional low-level matrix was added.

Installed native-shell polling, personal/live activation, signing/update trust and
actual inference completion remain separate requirements. Acer news processing
is untouched.
