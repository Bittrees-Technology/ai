# Browser key setup and recovery controls

Design: use the existing Bittrees remote palette: ink #183945, evergreen #28685c, white #ffffff, mist #edf3f6, border #aabec5 and error #8a2630. Avenir/system type, left aligned with a 72-character reading measure. A narrow key-history column sits beside a single review/setup surface; mobile stacks them. The main visual emphasis is the real three-step sequence: review the change, save separate recovery items, then check the saved backup before activation. Use visible keyboard focus, 44-pixel controls, natural text wrapping and no animation or external assets.

Design review: this is a private-key maintenance screen, not a marketing page. Keep the companion's existing palette and restrained typography. Avoid a hero, decorative counters or repeated cards. Describe consequences directly, distinguish an encrypted backup from its recovery code, and keep each irreversible action behind its own unchecked acknowledgment. Public identifiers use ordinary wrapping text; secret codes appear only after explicit reveal.

## Setup and maintenance

`mountBrowserKeys` is an internal, unmounted view over the real browser key lifecycle. Its trusted host supplies a fixed local owner, verified binding, fresh-registration status and a session scope. Call `invalidate()` immediately on account, logout, registration or permission changes. The view makes no network requests and never registers, pairs or grants private access. The production remote page is unchanged.

Starting setup requires an exact revision review. It retires the previous selection and reserves a new key. The user explicitly reveals or downloads the generated recovery code, saves it separately and re-enters it. `prepareRecovery` creates the encrypted backup but leaves the key inactive. The user downloads that backup, selects their saved file and re-enters the code with a separate acknowledgment. `activatePrepared` verifies the exact stored encrypted kit, code, key correspondence, current identity and metadata revision before committing activation. Changing the file or code clears the final acknowledgment. Existing `provision` remains a trusted compound API for compatibility; this interface uses only the split flow.

The history provides explicit review for stop, deletion, whole-scope clearing and new registration. Stop retains the encrypted backup; deletion removes local material and clearing requires a different freshly registered device. Export and deletion remain available offline. Neither action changes other devices or exported copies. A confirmed deletion removes stale history immediately even if the following status read fails.

An unfinished setup can resume with the saved original code. Material already prepared is reused and checked; an interrupted physical generation must be replaced explicitly. There is no silent retry, key regeneration or automatic activation. Lost committed acknowledgments are reconciled through an explicit refresh.

## Recovery and interruptions

The backup checker opens a selected encrypted kit locally and verifies local-owner/current-account identity. It displays only the original public key/device identifiers. It does not import a slot, restore historical decryption, reconnect a device or recreate grants, replay state or messages. Historical restore and rotation remain unfinished.

Codes are hidden initially. Blur, page hiding, Escape and explicit hiding erase in-memory UI copies, all password/file inputs, selected kits, acknowledgments and results, and revoke outstanding download URLs. The opaque setup/review reference remains until its original two-minute deadline so returning from a file picker can continue with re-entered saved material. A generated code erased before saving cannot be revealed again. A downloaded plaintext code remains under the user's control; downloads are not encrypted or deleted by this view. JavaScript garbage collection, browser downloads and external copies prevent a claim of guaranteed memory or disk erasure.

Context changes and expiry close the review. Generation/scope/focus checks discard late reads, exports, preparation and activation responses; they cannot reopen secrets, erase a newer review or announce an earlier account's result. A committed operation can still have happened before focus loss, so refresh is required to reconcile uncertainty. Native file-picker usability and real personal acceptance remain release requirements; the CI blur test exercises the return path without claiming a native dialog test.

## Verification and release boundary

`tests/browser/browser-key-controls.spec.ts` mounts the shipped UI over actual IndexedDB and WebCrypto in the disposable Chromium/Firefox/WebKit workflow. It covers saved-file/code activation, persistence/resume, malformed/foreign backups, mismatched code/kit, acknowledgment/revision/replay denial, competing selection, offline export/revoke/clear/reset, late responses, expiry, blur/visibility/Escape, URL cleanup, failed post-deletion refresh, keyboard review and desktop/mobile previews. Fixtures use synthetic identities and block external requests. Local checks cover type checking, engine regressions, contracts and production/fixture builds; browser execution and preview inspection occur on GitHub, not the user's browsers.

The [signed-in page](production-browser-recovery.md) now mounts these controls through verified identity wiring. Pairing, historical key restoration, private transport and independent/personal acceptance remain separate release requirements. A readable backup alone must never restore registration or permission. Database schemas, installed Mac app, prepared archive, Mac model selection and Acer model/runtime/news jobs remain unchanged.
