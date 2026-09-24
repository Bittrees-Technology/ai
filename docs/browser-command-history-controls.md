# Saved pause/cancel requests

The shipped remote panel saves the exact reviewed pause/cancel intent in the
owner-local browser journal before its first HTTP dispatch. If the submission
reply is lost, the saved record remains uncertain. A successful submission is
followed by an explicit receipt read: duplicate submission does not imply that a
command is still pending. A receipt records the last server observation, not
current task progress or proof of local execution beyond the reported outcome.

After reload, sign in and choose **Refresh saved commands**. **Check saved receipt**
looks up that original command ID and never resends it. Unavailable receipts are
not proof of failure: server retention can have ended. Local records remain until
reviewed deletion; there is no silent pruning or automatic retry.

**Review retrying original command** displays the same device, task, revision,
command ID and remaining deadline. One unchecked acknowledgement enables one
attempt. The review expires after two minutes or the earlier original/server
command deadline. A retry never extends the deadline or changes the ID. The
server still checks current account/device permission. Terminal observed commands
cannot be retried. Pause/cancel authority does not enable resume or task creation.

Export and deletion have their own unchecked reviews and fresh history-revision
checks. Export downloads bounded command metadata without task content, keys or
credentials. Deletion removes local entries while retaining the revision tombstone
that fences stale tabs. It does not retract commands or remove server receipts or
previously exported files. Corrupt-record repair and user-level browser storage
reset recovery are still separate work; a corrupt/future database fails closed.

Wallet/session change, focus loss, hidden pages, Escape and competing task-control
activity clear visible history and reviews and fence late completions. Commands
already dispatched cannot be retracted by closing a review. Reviews use wall and
monotonic deadlines. Stable expiry refreshes preserve button focus.

## Verification boundary

Engine fault tests cover persistence-before-dispatch, uncertain delivery,
acknowledged duplicate outcomes, late scope loss, expiry before dispatch and stale
receipt revisions. The shipped-page browser tests use real IndexedDB, HTTPS,
wallet sign-in and disposable PostgreSQL. They cover lost submission plus reload,
read-only reconciliation, reviewed retry, export/deletion, changed permission,
wallet invalidation and future-storage denial. A synthetic paired Mac publishes
status and acknowledgement through production stores; these tests do not claim
actual execution on a personal Mac. Three browser engines and desktop/390px
previews run in disposable CI. This does not deploy the relay or change the
installed companion, models, Acer server or news briefings.

## Integration review

The foundation and controls are integrated on the private delivery/history/queue
branch. Visual review found that the older original-command confirmation stayed
visible beside a saved-command retry review. Opening either review now dismisses
the other without dispatching either action. The generic uncertain-action message
says the action could not be confirmed, preserving the possibility that the server
already accepted it. The real-browser retry scenario verifies both switching
directions and still asserts the original command identity and unchanged server
record. All690 local engine tests and builds pass after integration; final combined
CI and eighteen refreshed previews remain required. Corrupt-record recovery and
full offline/live acceptance remain open.
