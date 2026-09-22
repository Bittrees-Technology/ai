# Review cited Mail passages

Mail task detail now places a “Check…” button beside each summary claim and suggested reply. Selecting it reads the corresponding original passage and displays it as plain text immediately below the chosen claim. Only one passage is visible at a time; Hide, focus loss, navigation, and the existing 15-second source refresh clear it. Delayed responses cannot repopulate a hidden or replaced view.

A citation identifies source context, not proof of factual correctness. Reply instructions supplied by the user need not appear in the email. Original source instructions are correspondence, not authority. Long-file synthesis and counts remain unverified; original part summaries remain available with their own passage controls. Downloads retain their existing current-permission check.

## Access and reconstruction

`POST /v1/requests/:id/mail-evidence` accepts only `expectedRevision` and `sectionId` behind the paired local API's token, Host/Origin and no-store protections. The owner comes from the local service. The task must be completed and unchanged, bound to Mail, and the requested section must be in its stored trusted citations. The adapter rechecks current grant, expiry, mode, selected message/file, source version and projection hash. The resolver also matches stored result/citation identities and checks the task again after the asynchronous source read. It returns one bounded passage; it accepts no URL, path, source authority or caller-provided excerpt.

Metadata tasks expose only cited metadata. Plain bodies use the same 800-Unicode-code-point sections supplied during generation. Single-prompt attachments use their original sections. Large attachments reconstruct exact part boundaries from the ordered offset citations retained in every original part summary, validating coverage, monotonic offsets and selected file identity. It does not re-plan against today's prompts/model settings or treat offsets as 800-character section numbers. Inconsistent historical results fail closed. Returned text is capped at 32,000 UTF-16 code units, matching the original bounded generation prompts. Raw source passages are fetched on demand and are not added to stored task results or exports.

## Evidence and limits

Authenticated HTTP and actual Mail adapter/worker tests cover plain/file passage reads, uncited selections, mode boundaries, no-store, bad credentials/origins, strict request fields, stale revisions, revoked grants and changed content. Additional tests cover metadata-only access, cross-owner rejection, missing adapters, Unicode boundaries, truncation notices, deletion during a source read, and exact reconstruction of nonuniform Unicode attachment parts. Client controller tests cover explicit requests, latest-request wins, hide/disposal, late successes/failures, wrong task/revision/section and malformed or denied responses.

This is engineering evidence, not completed native visual, keyboard, screen-reader or live-source acceptance. The installed app is not replaced by this source change. No Mail sending, draft saving, live grant, deployment, model-default change or Acer-server change is performed.
