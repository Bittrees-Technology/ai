# Browser relay receipts and results

The trusted browser host exposes one explicit `relayTaskAPI.check({after, confirmed:true})` operation. It obtains a fresh verified device scope and current relay permission, polls at most one message, authenticates it against the retained task and pinned Mac key, and saves the ciphertext in the browser outbox. Only then does it acknowledge that message's exact relay hash and revision.

The authenticated encrypted payload selects acceptance or result handling. Caller-provided response kinds are rejected. Result consent is checked separately, including inside the final IndexedDB transaction. That transaction also checks the live relay scope and deadline, current account, key, peer, task consent and original task envelope. Unsupported payloads, mismatched receipts, changed authority and conflicting retained responses fail without acknowledgement.

A result can precede the separate acceptance receipt. Both remain encrypted in retained history, and reading result content requires a separate explicit action with current permission. The relay check returns bounded metadata only. Server storage or delivery acknowledgement never asserts task completion.

If an acknowledgement reply is lost after the browser save, retained history remains available across reload. A repeat pull reconciles either a queued duplicate or an already acknowledged message. A scope change after a local commit can leave a saved message without an acknowledgement; it never creates authority to retry automatically.

No scheduler, visible send/check button, automatic task execution or automatic response sending is introduced here. Browser and native operations are tested together through disposable HTTPS and PostgreSQL in actual GitHub browser jobs. No public endpoint, installed Mac app, personal Keychain, local model or Acer news processing is changed.
