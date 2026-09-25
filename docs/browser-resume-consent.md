# Browser resume consent — implementation in progress

The browser independently authenticates a Mac resume offer before showing its task, model and permission identities. Inspection writes no consent or replay record. Preparing a review captures the current local key, paired peer, possession proof and consent revision. Explicit acknowledged approval writes encrypted consent and the original offer's replay outcome in one transaction.

Consent is limited to the exact permission, task revision, model digest and expiry. Authority checks revalidate current identity, keys, pairing and the retained consent row. Revocation remains local; clearing locks the row, and resetting requires a fresh device. This does not create a resume command or activate browser controls.

Storage version16 adds a separate resume_consents store and fences older writers before the shared replay ledger can contain resume outcomes. Existing stores must remain intact.

Validation pending: actual browser authenticated offer/approval/replay tests, pinned15→16 preservation and older-writer checks, recovery/rotation/rollback behavior, production host integration and UI. Type checking, production builds and all949 local tests pass, including the authenticated cross-family replay collision case. The pinned version15 provider archive was verified and built locally. Six focused browser scenarios are scheduled across three engines, including actual15→16 preservation and old-writer refusal; these have not run yet. These checks do not prove browser consent acceptance.

Authority resolution and transaction-time validation also require the original exact resume-offer replay outcome. Missing or altered replay evidence denies use even when the encrypted grant itself remains unchanged. The focused browser suite includes deletion and changed-outcome fault injection.
