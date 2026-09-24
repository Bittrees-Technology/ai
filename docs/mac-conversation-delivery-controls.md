# Mac conversation delivery controls

The selected Inbox conversation has separate reviews for preparing a local encrypted copy, uploading that original copy through ai.bittrees.org, and stopping further uploads. Saving conversation permissions or preparing a copy does not upload content. The controls use the authenticated local API and the existing private-key/permission/source guards.

Preparation reads the original local message again, shows its exact text and the paired browser fingerprint, then rechecks the original before creating or sealing the envelope. A live AI question also binds its current task revision and input wait. A normal reply requires an existing retained parent mapping. Reviews clear after15 seconds or when focus, visibility, selected permissions or the component lifetime changes. No task text is read from the cached Inbox placeholder.

A stable content identifier is derived from the permission ID and local message ID, without hashing message text. A lost preparation response cannot cause the interface to create a second original identity. Refresh retained history to inspect the outcome; an interrupted preparation has a separate review to finish sealing the same original. The encrypted envelope is retained on the Mac; the preparation control neither downloads it nor sends it to the relay.

Uploading has a separate, unchecked confirmation. The host verifies the current relay connection, original content, destination, source access and key/permission lifetime again. Original ciphertext and sequence are reused for explicit retry. Delivery history distinguishes an uncertain attempt, relay server storage and an authenticated recipient-storage receipt. None confirms that a message was read or that work completed. For an incoming content item, the upload action sends its already-prepared storage receipt only.

Stopping is a separately reviewed local action and remains available without relay authority. It cannot retract an already submitted copy. Retained history remains part of existing owner export/deletion and encrypted backup controls.

The controller tests use actual authenticated local HTTP, real encrypted storage and a synthetic relay transport. Browser acceptance exercises the built Inbox on disposable GitHub runners with desktop/phone previews. This package does not install or replace the Mac app, access personal data/Keychain, activate live delivery, change models, or touch Acer news processing. Browser content sending, Mac incoming queue integration, receipt controls and full release acceptance remain separate requirements.
