# Mac device-check controls

Connections now mounts **Verify a private device** between the public-key review and task-permission panels. It calls the existing authenticated local peer-check API; no new authority, transport, key storage or cryptographic protocol is introduced. Normal native launches still leave private setup off. This change does not replace the installed app or activate a hosted service.

## Manual exchange

Both endpoints first need independently reviewed public-key pins and their retained local keys. In an enabled development configuration:

1. Choose a saved device and review starting a check. The review names its ID and saved full fingerprint. A fresh acknowledgement and **Start device check** reserve and prepare the exchange.
2. Review **Show code** for that saved exchange. **Show encrypted code** retrieves the original pending ciphertext. Transfer the complete code to the intended device yourself; this interface never reads/writes the clipboard or sends the code upstream.
3. On the other endpoint, choose the sender, paste its code and review answering the check. Confirm **Create check reply**, then separately reveal and transfer the reply.
4. On the original endpoint, choose the peer, paste the reply and review verifying it. **Verify check reply** passes it to the existing cryptographic verifier and displays the saved completion result.
5. Repeat with the endpoints reversed. Answering a challenge does not verify its sender on the responding endpoint. Task permissions must be reviewed separately after each endpoint completes its own check.

The interface parses a bounded envelope and checks the selected sender, original operation for replies and expiry before presenting review. The companion remains authoritative: it verifies ciphertext, current owner/key/peer/identity proofs, deadlines and transcript under the existing commit checks. The interface never treats untrusted header fields as cryptographic evidence.

Every review expires within five minutes, capped by the original exchange deadline when applicable. Fresh acknowledgement is required for each action, including revealing ciphertext and stopping. Fingerprints and IDs wrap on narrow screens, controls have visible keyboard focus and minimum 44px targets, and actions use the existing ink/mist/evergreen visual language. Select labels are stable independently of their option text.

## Saved history and interrupted work

Saved exchange states distinguish unfinished preparation, pending challenge, prepared reply, historical verification, stopped work and restore locks. Historical verification does not establish a current connection; rotation, peer-registry changes, revoked/expired identity or restored data can invalidate it. The actual permission layer validates current trust again. Metadata refresh performs no inference, remote identity request or native key lookup.

An unfinished preparation can be explicitly resumed with its original ID/deadline. Ciphertext retrieval always uses the saved ID and original bytes. Local stop remains available when setup is off and requires the reviewed record revision; it cannot erase already shared codes or revoke completed verification. Restore-locked records cannot resume/reveal. Expired pending work cannot reveal/resume; users can still stop it locally. Revocation of completed trust remains in the existing key/device controls.

Focus loss, hidden documents, Escape, cancellation, refresh and unmount clear visible codes, pasted input, selections and acknowledgements. Late asynchronous replies cannot repopulate hidden review/code state. A request already executing may still commit; hiding the screen is not cancellation. An uncertain response clears the displayed status and asks for an explicit refresh. There is no automatic mutation retry or new-check creation. Repeating verification requires the original unexpired reply and is reconciled by the backend.

## Verification and remaining scope

Five engine scenarios connect the actual dashboard state controller to both real companion endpoint stacks with real HPKE and disposable stores. Native entries, identity transport and inference remain synthetic. They cover no-authority exchange, wrong/malformed/oversized/expired input, revision-bound stop, exact ciphertext after reopen, late-output suppression, lost acknowledgement, original-ID preparation resume and stale peer revocation. Existing backend tests cover authenticated HTTP boundaries and cryptographic failures.

Five additional browser scenarios run only on disposable GitHub Chromium, Firefox and WebKit. They exercise the actual React panel with a synthetic API, keyboard acknowledgement, narrow layouts, immutable code retrieval, separate response/verification, resume/offline stop, invalid inputs, expiry, focus loss and uncertain outcomes. Retained screenshots require inspection before merge. Browser fixtures are UI evidence, not browser endpoint-key implementation or personal/native acceptance.

Task schema19, browser schema1, prepared PR104 and the installed personal app are unchanged. Browser key persistence/recovery, automated relay/delivery, native personal acceptance, independent security review, encrypted replies/approvals and release signing remain open. Acer-server's model, runtime and news jobs stay unchanged; Mac inference remains independent without Acer fallback.
