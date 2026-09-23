# Reviewed Mail controls on the Mac

Connections now includes a separate **Send a reviewed message** panel. It preserves the existing read-only Mail drafting connection. A user can write a message or paste a checked reply, supply their Mail sign-in wallet and assigned mailbox, explicitly list To/Cc/Bcc recipients and attach up to four files totaling one MiB. Optional original-message references must come from Mail; the source verifies their exact version. No model receives a sending tool.

Saving the message creates the encrypted immutable record described in [the backend guide](mail-send-journal.md). The user downloads an explicit review file, imports it at Mail's separate approval page, then pastes its one-time code here. Approval alone never sends. After loading the permitted message, **Review final send** displays every recipient, exact plain body, subject, attachment name/size, downloadable exact bytes and optional original-message reference. A separate unchecked acknowledgment enables **Send this exact message once**.

The source/host feature must be released and enabled separately. The last verified live Mail publication does not yet include this source approval flow; staged source version57 and the companion still need combined HTTP/queue/SMTP acceptance and coordinated release. Do not infer personal readiness from the presence of the Mac controls.

## Recovery and privacy

- Focus loss, hiding and exit clear final review/acknowledgment, approval code, private file preview, history and selected saved-message content. Expiry clears the corresponding approval attempt or final review; local history remains readable with expired permission. Late responses cannot restore these views; a late server review is explicitly cancelled by its own ID.
- The pending operation ID and deadline survive focus loss so a user can return from Mail with a code for their downloaded file. The verifier stays in the companion, not the UI or review file. Creating a replacement approval file requires new source approval. No content is put in a URL, browser storage or logs.
- Unsaved compose fields remain in the form across focus changes, including the operating-system file picker. They are cleared explicitly or when leaving Connections. They are not autosaved. File reads are bounded; late file reads cannot repopulate the form after focus invalidation.
- Submitted confirmations are consumed immediately. An uncertain response disables further send review in that panel and offers a status check. It never retries the send. Loading history after a restart relies on the durable backend reservation.
- Restored records are reconciliation-only even if the backup preceded submission. Expired/disconnected grants do not hide locally saved history; users can export/delete it or prepare approval for the same operation. Checking status needs a matching current source permission.
- History distinguishes preparation, recorded submission, uncertainty, partial/full SMTP acceptance and refusal. Every recipient's historical result is shown. Delivery stays unverified; the Sent copy is reported separately.
- Explicit file exports/downloads contain private plaintext and remain outside the encrypted store until the user deletes them. Local record deletion requires a separate acknowledgment and does not recall mail, cancel source work or revoke source permission. A confirmed deletion clears the view even if the subsequent connection refresh fails.

## Design and verification

The panel extends the existing companion design: Avenir/Avenir Next for all text, navy `#183945`, pale blue `#edf3f6`, paper `#f8fbfc`, green `#28685c` and blue `#29658b`. One reading column keeps the complete message together; a narrow blue edge marks the exact content. Recipient labels align beside values on wide screens and stack on phones. History is a list, not a set of interchangeable cards. All actions use ordinary labels and keyboard-operable controls. Untrusted message text is rendered as text, never HTML.

The shipped controller is exercised through the actual authenticated loopback API, real encrypted SQLite journal and real connector using synthetic source responses. Tests cover full compose/approval/confirmation/status/history/deletion, focus/expiry/late-response fences, uncertainty, restored records, file limits and deletion acknowledgment. Browser scenarios run only on disposable GitHub CI runners in Chromium, Firefox and WebKit and retain review/approval/receipt/uncertainty/restored-history previews at desktop and phone widths.

These tests do not replace the still-required combined private Mail source/queue/SMTP verification or native/personal acceptance. No personal data/Keychain, real message, installed app change, local browser automation, source deployment or Acer operation is involved. Mac inference remains independent and model defaults are unchanged.
