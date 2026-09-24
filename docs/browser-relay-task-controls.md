# Reviewed browser private task delivery

When the host settings explicitly advertise a complete private relay policy, the existing browser task workspace offers three additional reviewed actions: prepare a task for private delivery, send a saved task, and check for one Mac reply. Without that policy, those controls are not mounted. The settings flag is only availability: the verified host and server still check actual endpoint, peer, task and relay permissions.

Private preparation shows the complete supplied text, selected Mac, permission, fingerprint and delivery deadline capped to both connection leases. Confirmation saves the preparation locally. Sending is a separate review of the saved task ID, current revision, Mac and deadline; it sends the original ciphertext. A handoff task with a longer deadline than current connections is denied rather than silently resealed. A new task should be prepared for private delivery after reviewing current settings.

The send notice distinguishes stored, already delivered and previously removed server messages. None is evidence of Mac task acceptance or completion. An uncertain response clears the review and requires an explicit refresh and new review. Application mutations are never automatically retried; browser networking may replay a broken connection, so underlying operations remain idempotent.

A reply check polls at most one message for this browser. The trusted host authenticates and stores an acceptance or result before acknowledging exact delivery. The screen reports only response type and task identity. Opening retained result text remains a separate reviewed action under current result permission. Model output is rendered as text, with no execution authority.

All new actions use existing exact-snapshot comparisons, unchecked acknowledgements, one-use confirmation, current-host generation and review deadlines. Send review expiry also respects the task deadline. Account changes, blur, visibility changes, Escape or panel disposal invalidate current operations and suppress late output. Existing manual handoff, import, export, stop and local deletion remain available.

Verification includes existing engine and build checks plus four new shipped-page scenarios across three browser engines: exact preparation/send and native response roundtrip, uncertain-send deduplication, cancelled reply checking, and absent-policy controls. Eighteen screenshots cover desktop/narrow review, send review, saved/open result and uncertain delivery. Actual GitHub browser execution and visual inspection are required before acceptance.

No automatic polling, new model policy, live activation, installed-app or personal Keychain change is included. The Mac companion remains independent of Acer news processing.
