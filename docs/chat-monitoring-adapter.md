# Inactive Chat monitoring collector

`recurring-chat-source.ts` implements `LocalRecurringCollector` and is registered as
`local.chat.monitor.read` in companion startup with its default disabled configuration.
No workflow definition, schedule, source transport, authority callback or database is
created by registration. No fetch, network library, credential lookup or command runner
is imported. The existing offline/native policy is unchanged.

The fixed public scope is GET `https://chat.bittrees.org/api/health` and GET
`https://mail.bittrees.org/`, credentials omitted, redirects rejected, 15 seconds each.
Chat requires HTTP 200, JSON content type, at most 16 KiB of valid UTF-8 JSON,
`readiness.syncReady === true`, and boolean gateReady/releaseReady. Those two flags
are recorded independently and may be false without failing public availability.
Mail requires HTTP 200 and its body is never read. Neither check certifies mailbox
correctness or launch readiness. Source: Chat production-availability.mjs contract
SHA256 6713bdb16a20031f062e7f5445148f7f78e876c35b1bbb2093b7548e922ee371.

Future operator wiring must supply all of:

- Reviewed workflow ID and immutable scope revision; the host enforces workflow binding.
- `ChatAuthority(context, signal)`: freshly validate Roles/source authority, exact device,
  workflow/revision/operation/check and enforced zero additional cost. It runs before
  reservation, before dispatch, after response and before cached evidence is returned.
- `ChatSourceTransport(check, signal)`: reviewed native transport that enforces the exact
  frozen check, public DNS/IP pinning, TLS, no proxy/cookies/credentials/redirects and abort.
  This module has no default transport; mock transport does not prove native enforcement.
- A durable `ChatJournal`; `ChatOperationJournal` uses SQLite WAL/FULL and stores only bounded
  boolean observations plus operation metadata, no response bodies or credentials.
  Use an operator-owned safe path. Existing symlink/nonregular leaf paths are rejected.

Reservation commits before dispatch. A pending record is an uncertain outcome and blocks
replay, including after restart. Only a settled failed check can retry after 30 seconds,
with a maximum of two attempts for each check in the same occurrence. Healthy cached
observations retain their original time and still require current authority. Revision
changes, journal errors/capacity and revocation hold evidence. No timer schedules a retry;
the workflow owner must re-enter with the same occurrence ID. Different occurrences require
the existing single-owner scheduler/admission controls. No successor is provisioned.

Acer has no approved host, pinned helper, fixed invocation or source scope. Every combined
receipt therefore stays held, objectiveComplete false, monitoringAccepted false, and
explicitly records Acer unresolved even if both public checks pass. Its deterministic
collector decision escalates that hold. Do not silently omit Acer or treat these public
checks as complete independent monitoring acceptance.

Activation additionally needs exact original schedule/instruction inventory and fingerprints,
source/owner/controller approval, native allowed/denied boundary tests, bounded live evidence,
original-owner pause verification and a natural scheduled run. No such action is authorized
by this code preparation. Existing Chat runtime upgrades, app data and other workflows stay
outside this change. Do not install, activate, create grants, make live requests or publish
without their separate required checks and authorization.
