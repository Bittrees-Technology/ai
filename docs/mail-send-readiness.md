# Mail sending prerequisites

End-user Mail sending remains unavailable. The companion now has [reviewed-send backend groundwork](mail-send-journal.md), while its complete user interface, combined source/companion acceptance and release remain open. Its selected-message grants permit metadata, optional body and optional selected text attachment reads only. Chat sending grants belong to Chat's separate audience and must not be reused by the AI companion. Copy/download remains the available output path for a generated reply.

## Historical version54 prerequisite audit

The following results describe the pinned version54 baseline, not the later version57 source or new companion backend.

The source-readiness probe checks an explicitly pinned, clean private Mail checkout. It runs actual source consent, grant and queue tests, calls the current request parsers and AI HTTP router, then exercises the real Python connector with temporary Maildirs, an isolated SQLite journal and intercepted SMTP. The network is denied during the connector probe. It never launches the connector service or reads personal Mail configuration.

```sh
MAIL_REPO=/absolute/path/to/private/mail \
MAIL_SOURCE_COMMIT=<exact-40-character-source-commit> \
MAIL_PYTHON=/absolute/path/to/python-with-cryptography \
MAIL_READINESS_OUTPUT=/absolute/path/outside-public-repo/readiness.json \
node_modules/.bin/tsx scripts/mail-send-readiness.ts
```

Install the private source's locked dependencies before running. Use Node 24 and a Python environment with `cryptography`; the probe does not install anything. Keep its receipt and source-test transcript beside the local guides. Private Mail source and credentials are not copied into this repository or fetched by public CI. The TypeScript runner is a source-tree verification tool, not a packaged companion command.

The 23 September 2026 check against source `3616993d16cb37954a747567f27503b7b15ea65b` passed 70 actual source tests and the intercepted connector checks. It establishes these boundaries:

- Current selected AI grants cannot dispatch Mail sending. Source session, assignment, MFA, expiration, revocation and mailbox state remain authoritative.
- The existing Chat send parser accepts one To recipient. It rejects caller-supplied From, Cc, Bcc, multiple To recipients and approval fields. It is not the full AI send contract.
- The connector derives From from the authorized mailbox. Exact attachment bytes survive MIME construction. Repeating an accepted operation has one SMTP effect; changing recipient, subject, body or files under that ID is rejected.
- A timeout after possible SMTP acceptance leaves a durable pending record. Repeating it is denied without another SMTP attempt. The existing response is only `ok`; it does not establish delivery to recipients.
- No read-only operation receipt route is exposed. A send retry cannot substitute for a status check, and a Sent-folder search cannot reliably prove an uncertain operation failed.

The existing `scripts/mail-integration-check.ts` also passes against this source after updating its stale single-stage synthetic reply fixture. It now verifies separate summary/reply formats and that actual source-grant revocation between stages prevents reply generation and persists no partial draft. Metadata and selected-attachment summaries retain their existing paths. This repairs verification tooling; production prompts and inference behavior are unchanged.

The readiness result is explicitly **false**. Passing prerequisite tests does not complete the Mail sending checklist. Implementation still needs the full reviewed From/To/Cc/Bcc/subject/body/attachment envelope, a distinct per-user AI send grant, exact-content confirmation invalidated by changes, authority rechecks through queue dispatch, and read-only historical receipts with explicit queued/accepted/uncertain semantics. Then the companion can add encrypted durable intent, complete review and reconciliation controls. Delivered status needs its own authoritative evidence and must never be inferred from SMTP acceptance.

Any mailbox-transport support belongs in Mail's existing queue and connector lifecycle. Do not add a second mail scheduler, borrow Chat grants, or give the model a direct sending tool. Future local source work must preserve existing Chat and web Mail behavior, remain disabled until source and companion acceptance passes, and be checked with intercepted delivery before live use. Native/personal acceptance and the user's exact live-message authorization remain separate. Mac inference and Acer's news model/runtime/jobs are unchanged by this work.
