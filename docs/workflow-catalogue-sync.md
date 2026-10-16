# Workflow hub synchronization

A paired local workflow device publishes an opaque saved-template and local investor-research index to the existing AI service every minute while the companion is running. No new device is registered automatically. The owner must complete the existing wallet pairing; unpaired or revoked devices cannot publish. Metadata synchronization grants no approval or execution scope.

Only workflow ID, revision, operation kind and bounded local state leave the device. Names, prompts, research briefs, URLs, model settings, local files, task input and output remain local. The hub shows generic process steps and the last device heartbeat. An offline device cannot report new changes until it reconnects. Removing a template publishes a tombstone on the next successful snapshot; revoking a device immediately hides or marks its workflow records removed at the source.

Cloud migration: apply `modules/remote/migrations/workflow-catalogue.sql` to the existing coordinator database. The workflow hub uses an independent read-only metadata function and applies current Roles permissions as well as owner filtering. The companion needs a build containing this change; updating the AI website alone cannot change an installed local app.
