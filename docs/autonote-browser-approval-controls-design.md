# AutoNote browser approval controls

Use the existing companion palette: cloud #edf3f6, ink #183945, paper #ffffff, border #aabec5, focus #29658b. Avenir and the existing body/heading scale remain unchanged. Keep text left aligned and constrained within each source submission; long fingerprints wrap. No new animation or decorative cards.

Layout: submission → “Review on a paired browser” → explicit load → paired browser and relay choices → saved permission → encrypted offer progress → one review with an unchecked acknowledgement and confirm/cancel. The distinctive content is the source meeting/audience and paired fingerprint, not a generic status dashboard. Granting permission, preparing encrypted notes, and sending them are distinct actions. Stored-at-relay progress is never labeled approved or saved.

[paired browser] [relay connection]
[Review permission]
Permission: browser fingerprint / expiry / revoke
Offer: 2 of 4 parts stored / Review sending remaining parts / stop
Review: exact action, source audience where available, recipient, expiry
[ ] Acknowledge this action   [Confirm] [Cancel]

Review against brief: integrate into the existing source-owned workflow, keep controls usable on a phone, preserve explicit consent, and avoid making users approve each transport chunk. A single reviewed send processes remaining parts sequentially; a failure leaves retained progress for an explicit reviewed retry. Focus loss, hiding, Escape, outside click, selection changes and expiry discard the review. Browser receiving and exact save remain separately unfinished and are stated in the UI.
