# Private task delivery and queue recovery

This package integrates the Mac task delivery controls, their authenticated local
API acceptance, durable Mac/browser delivery history and reviewed queue recovery.
They form one workflow: review an exact incoming task on the Mac, prepare and send
a separately permitted acceptance or result, then check and retain the matching
reply in the browser. Opening result text remains a separate action.

Both interfaces retain the original encrypted message when delivery is uncertain.
A server storage confirmation is shown separately from authenticated acceptance,
completed work or user reading. Looking past a rejected message inspects only the
next manually reviewed position and does not acknowledge, delete or accept the
skipped message. Positions are temporary, connection-bound and limited to twenty.

The Mac controller uses the existing authenticated local API and current native
custody, endpoint/peer identity and separate task/result permissions. Reviews are
one-use, explicitly acknowledged and expire after two minutes or an earlier
message/permission deadline. Focus loss, Escape, connection changes and cancellation
invalidate pending reviews and late responses. Stopping retries remains local and
does not claim to retract a message already stored remotely.

Task schema25 retains encrypted response delivery metadata; browser common storage7
retains relay acknowledgements and uncertain attempts. Upgrade verification uses
the actual previous writers, preserves existing records and rejects old writers
against the upgraded stores. Neither migration grants new permission.

## Verification

The component heads passed their engine, real HTTPS/PostgreSQL/browser and preview
checks before integration. The combined predecessor 60c6d08 passed all682 engine
cases and all1,137 browser cases once across Chromium, Firefox and WebKit, with no
failures, retries or skips. The integration rebase preserves that behavior and
includes the upstream send-review copy correction and CI artifact-upload allowance.
All682 local engine cases, typecheck, unchanged contracts, production/fixture builds
and the actual compiled task24→25 backup/rollback rehearsal pass after the rebase.
Final integration-head CI and refreshed screenshot reviews are tracked separately
and must pass before merge; prior component results do not replace them.

## Remaining scope

This is development source for the independent Mac companion. It does not replace
or launch the installed application, activate a live relay, read personal keys or
change a model. Acer runtime, model, schedules and news processing stay unchanged.
Conversation messages/replies, exact-proposal approvals, scoped resume, independent
cryptographic review, live retention policy and personal-device acceptance remain
separate requirements. Synthetic credentials, inference and disposable CI native
slots do not prove personal or live-service acceptance.
