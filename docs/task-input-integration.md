# Local task question and answer integration

This package brings the existing durable wait/reply lifecycle, task-linked Inbox
privacy and exact-answer controls onto the private delivery and saved-command
foundation. It preserves the original three implementation commits. The browser
fixture exposes both saved-command and Inbox entry points after integration.

A current worker can save one bounded clarification into the encrypted Inbox and
release its lease. The owner explicitly opens that exact question, writes an
answer, reviews its current task revision and confirms once. Saving queues waiting
work; paused work remains paused. Resumed workers consume only associated answers
and recheck model/source/dependency authority. Ordinary Inbox replies do not
unblock tasks. Changed, expired or uncertain reviews require fresh inspection.

Task26 adds question/reply associations without modifying existing task inputs.
An actual compiled task25 engine verifies preservation, encrypted backup/restore,
old-writer denial and rollback to an untouched original backup. The Mac runtime
accepts loopback inference only; Acer remains independent.

All 715 local engine tests, typecheck, generated contracts, production and browser
fixture builds, and the compiled25-to26 compatibility rehearsal pass. Disposable
GitHub browser CI must verify all 1,176 integrated cases plus final Inbox/answer
previews before merge. No local browser or native application is launched.

The optional model question decision policy is now implemented in a follow-up;
see [its current behavior and verification boundary](model-question-policy.md).
Separately consented encrypted remote conversation/reply transport remains open. This is source integration, not an
installed upgrade, live deployment or personal pilot. Model quality, signing,
recovery and independent release acceptance remain separate requirements.
