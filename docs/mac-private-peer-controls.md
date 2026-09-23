# Mac public-key invitation and review

Connections now mounts **Other private devices** beside this Mac’s key controls. The authenticated loopback API and `CompanionPrivatePeers` connect actual retained endpoint keys, verified device identity and the encrypted public-peer registry. Invitations are manually transferred public JSON; this is not an authenticated relay, reciprocal proof of possession or private task access. Browser key storage, independent source/task consent, recovery and delivery remain unfinished. The normal launcher keeps new setup off. Installed PR40, prepared PR104, personal Keychain/data, model defaults and Acer-server remain unchanged.

## Invitation and independent comparison

Status reads only local metadata. Explicit invitation creation requires an enabled development setup, fresh verified paired-device identity, the expected selected-key revision and the actual retained active native key. It never creates a key. The invitation contains the public key, exact account, sender and intended recipient, key epoch, fresh nonce and a maximum five-minute lifetime. A self-recipient, stale selection or identity failure is rejected. No private key bytes are returned.

Incoming review requires the expected peer-registry and Mac-key revisions. It resolves the actual local key, verifies the invitation’s curve point, exact owner/recipient and lifetime, then checks the key proof again after asynchronous inspection. A one-use review retains the parsed invitation, exact identity and revisions, expiry and full domain-separated fingerprint. The returned preview cannot mutate retained authority.

Confirmation obtains a new verified identity scope and requires the same complete binding, unchanged Mac key, current peer revision, explicit acknowledgement and exact independently compared fingerprint. The original captured invitation is inspected again. The key proof and peer approval are checked within the same SQLite immediate transaction, preventing another writer from changing the selected Mac key between the final proof check and pin publication. The registry independently checks current identity, expiry and peer revision. Registry replacement requires a higher epoch and unused key; retired/revoked keys cannot be silently restored. An uncertain response is reconciled by refreshing local metadata, never automatic replay.

The UI leaves the comparison field empty and requires the user to enter the full fingerprint from the other trusted screen or separately trusted channel. Changing it clears acknowledgement. It displays the account, this Mac, peer ID and replacement warning. Copying the fingerprint from the received invitation itself does not establish independent comparison. The server enforces the confirmation contract but cannot prove that a person actually compared two trusted screens. Saving a pin is one-sided and grants no task, source or action permission.

## Revocation and lifecycle

Local revocation has its own revision-bound review and acknowledgement and works without a live remote lease. It stops local trust; it does not revoke remote permissions or erase remote copies. Restored registry/key metadata stays locked; no reset or recovery bypass is exposed.

Peer and key work share one controller operation lock. Key review replaces pending peer review and peer review replaces pending key review. All-data deletion rejects active operations, invalidates outstanding reviews and uses existing key cleanup plus registry deletion. Logout invalidation fences active identity scopes and discards pending peer review. The UI clears invitations and reviews on focus loss, hiding, Escape, cancellation, input changes or expiry, and generation checks discard delayed responses. Already confirmed changes can have completed even when the UI hides or a response is lost; refresh is the reconciliation path.

The verified identity remains a bounded snapshot, not instantaneous remote/cross-process revocation. The parent must coordinate credential changes and call invalidation; the existing thirty-second scope limits still apply. There is no automatic poll, renewal, key generation, invitation upload, source grant or task dispatch.

## Verification and remaining work

Engine tests use actual key/peer lifecycle, verified client and authenticated HTTP with synthetic native entries and identity transport. They cover recipient-bound invitation/key correspondence, strict inputs, wrong owner/recipient, exact one-use comparison, mutated previews, expiry, registry/key races including key revocation immediately before the publication lock, revoked registration, replacement epochs, offline revocation, busy deletion, invalidation during native reads and all-data cleanup. UI controller tests cover delayed review suppression, missing comparison/acknowledgement, expiry and no uncertain retry.

Disposable GitHub browser tests mount the actual React panel against synthetic API responses in Chromium, Firefox and WebKit. They exercise independent comparison, acknowledgement reset, revocation wording, invitation hiding, delayed review, conflict behavior, keyboard controls and desktop/mobile layout. They do not establish native/personal use or independent protocol acceptance. No local browser automation is used.

Real reciprocal enrollment and proof of possession, browser endpoint keys, user-held endpoint recovery, fresh registration after restore, full rotation, authenticated invitation delivery, scoped task consent and private transport remain open. Mac task schema17 and browser database version1 are unchanged. Acer’s model, runtime and news briefings remain independent and unchanged.
