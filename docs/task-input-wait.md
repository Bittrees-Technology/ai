# Local task questions and replies

The task store now has an actual input-wait transition. A trusted worker holding
a current lease can atomically save an encrypted clarification in the existing
inbox, associate it with its task, end the run and enter `awaiting_input`. The old
lease and generation cannot write a late result. A duplicate identical question
from the original worker generation reconciles to its existing record.

A separate owner control operation accepts an answer to one exact question and
reviewed task revision. It appends an ordinary encrypted inbox reply and binds
that reply to the waiting task in the same transaction. The original task input
and idempotency hash remain unchanged. The answer does not become a new task that
would wait behind its target. An ordinary inbox reply alone does not change task
input. Current transport-specific conversation authority must be supplied by the
trusted caller; no remote permission is inferred from inbox membership.

The resumed worker uses only explicitly associated questions and replies, ordered
by their existing message sequence. It preserves the original prompt and treats
clarifications as additional owner input without changing source, model or action
permission. All source-specific generation paths receive the clarified request.
The existing worker still resolves its current model, revalidates source rights
before generation and before result storage, and records question/reply IDs with
the encrypted run history. Other tasks retain the existing conversation order.

Pause remains independent: an answer received while paused is saved but leaves
the task paused. Resuming an unanswered task returns it to `awaiting_input`.
Cancellation and stale revisions reject a new answer. Question expiry rejects
late answers and existing scheduler maintenance expires the blocked task, allowing
later eligible work to proceed. Each task retains at most eight questions and
128,000 UTF-8 bytes of combined question/answer content; nothing is silently evicted.
Questions are due within seven days and no later than the existing task deadline.

Task schema26 adds only an association table and an index. Text remains encrypted
in the existing messages table. Old records receive no automatic question or
permission. The old writer rejects the upgraded database. Source-bound question/answer text is concealed in exports and conversation previews; reading inbox history revalidates the associated task and source before returning content. Existing content backup
preserves associations; export includes the association metadata alongside the
existing messages, and deletion removes both. Untouched old backups still work
with the old writer. Restored remote/source permissions remain subject to their
existing locks and reauthorization rules.

## Current boundary

This package provides the real store transition and worker consumption, with
synthetic SQLite/worker/source-adapter tests and an actual compiled25→26 migration
rehearsal. It does not yet provide a user-facing ask/answer screen, a model question
decision policy, an HTTP answer route or encrypted conversation messaging. Those
must use these operations under reviewed current owner/conversation authority.
End-to-end remote replies and the full checklist requirement remain open. There
is no installed application replacement, inference/model change, live deployment,
personal data access or Acer news-processing change.
