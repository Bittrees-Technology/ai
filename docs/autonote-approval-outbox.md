# Encrypted AutoNote approval outbox

The internal outbox retains one reviewed exact-notes offer and its encrypted packets in the existing encrypted AutoNote review record. It is not yet connected to a host route, browser receiver, or source-save decision handler.

An explicit prepare request pins the separate source/peer permission, request ID, review revision, packet IDs, and shared outbound sequences in one transaction. Repeating that request returns the same offer. Encryption replaces each locally encrypted-at-rest plaintext packet with its durable HPKE envelope before any upload can occur. Completed encryption is never regenerated during retry.

Explicit dispatch resolves current source and peer permission again, records the attempt before invoking the host-supplied authenticated relay sender, then retains a matching storage receipt. A lost response leaves uncertainty; a later explicit retry sends the identical envelope. Construction and restart do not trigger upload. A relay receipt proves storage only, not browser approval or a source write.

Stop prevents further dispatch. Removal requires a stopped, inactive offer and removes only its local record. Backup/export retain the outbox through the existing encrypted review payload; restored key/peer locks prevent dispatch using restored permission. At most four offers are retained per operation, with the existing 2 MB exact-notes limit per offer.

Before host integration, include the outbox busy state in deletion and backup guards, bind the sender to the authenticated relay identity, and provide explicit review/send/retry/stop controls. Multipart receiver validation and a separately checked source-save decision remain subsequent work.

Validation extends the existing AutoNote integration fixture: actual encryption, a lost relay response, a reopened store, byte-identical explicit retry, retained storage receipt, backup/restore denial, and stopped-offer cleanup. No additional browser matrix or live source write is introduced.
