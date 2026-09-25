# Browser resume permission controls

The recovery/setup view can inspect an encrypted task resume offer from a previously verified Mac. Inspection is read-only. A separate review shows the exact task ID, task revision, model digest, Mac permission, paired Mac fingerprint, and chosen expiry. Saving requires an unchecked acknowledgement and fresh identity, key, peer, and possession evidence. Saving browser permission alone does not resume a task.

The panel supports bounded JSON paste/file import, permission-history export, offline revocation/deletion, and reset after a different registration/key. Exported history cannot restore permission. Escape, focus loss, registration/account changes, other panel actions, expiry, and disposal invalidate reviews and discard late responses. Monotonic and wall-clock deadlines both apply. The existing browser host/core remains the authority boundary; the UI exposes no private keys or execution handles.

The first UI does not yet send encrypted resume commands or receive execution receipts. These remain required follow-on work. Acer news processing, model defaults, the installed Mac app, and live deployment are unchanged.

## Visual direction

Use existing Bittrees controls: ink `#183945`, mist `#edf3f6`, white `#ffffff`, border `#aabec5`, evergreen `#28685c`, focus `#29658b`. Avenir/Avenir Next carries headings and body text. Left-aligned saved history sits beside offer inspection/review, stacking on narrow screens. Exact task/model identity is the decision content; no extra dashboard decoration or animation. This preserves the surrounding recovery workflow rather than introducing a new design language. Desktop/phone screenshots must be inspected from disposable CI before visual acceptance.

## Verification scope

Three production-browser scenarios use actual Mac resume consent/offer modules with disposable encrypted storage and synthetic native slots. They cover exact import/review/save, unchanged paused Mac task, retained browser choices after reload, history export, offline revoke/delete, tampered input/selection changes, and Escape/focus/cross-panel cancellation across three engines. Existing consent-core tests cover replay, storage atomicity, expiry and identity authority; neither narrow suite substitutes for full browser/native and migration acceptance. No browser test runs on the user's Mac.
