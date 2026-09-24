# Browser conversation offer relay

The browser key host can inspect one queue item without opening or acknowledging it, then authenticate an exactly selected Mac offer using the existing independent conversation review. The relay client closes after each operation; no live transport survives the interactive consent review. Task/content envelopes do not become conversation offers merely because they appear in this queue.

Acknowledgement is a separate explicit operation after durable browser consent. The first attempt binds the exact original ciphertext and server selection to that consent. An encrypted journal records the attempt before networking. A lost response can be retried after reload using its original message/hash/server revision without polling a queue that may already have removed the item. Retries preserve the original consent and do not approve or renew it. Server receipt observations describe transport only.

Every attempt and observation requires current browser key/peer proof, unrevoked and unexpired consent, the original offer identity, and the existing common replay outcome. Failed writes roll back; a deleted fence is never recreated by acknowledgement. Stale, altered, superseded and mismatched receipts conflict. Explicit narrowed consent for the same original offer retains its receipt journal, while superseded offers do not inherit one. Earlier confirmed observations survive uncertain retries.

Browser common storage version11 fences older writers. Genuine version10 consent, keys, tasks and replay rows are preserved; missing receipt history is not invented. The pinned actual version10 provider is built from b1263ca9f2ccc4072f9e36e1b4a491bcd58ff3c6 for the upgrade scenario.

This package currently provides the internal host/storage path and browser tests. Shipped queue/review/acknowledgement controls and their visual acceptance remain to be connected. Conversation message/reply/answer delivery, historical replay reconciliation and broader native/personal/live acceptance remain open. No installed app, personal keys/content, runtime/model, live relay or Acer news changes.
