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
  reservation, before dispatch, after response and again for each scope before final
  aggregate completion or cached evidence is returned.
- `ChatSourceTransport(check, signal)`: reviewed native transport that enforces the exact
  frozen check, public DNS/IP pinning, TLS, no proxy/cookies/credentials/redirects and abort.
  This module has no default transport; mock transport does not prove native enforcement.
- A durable `ChatJournal`; `ChatOperationJournal` uses SQLite WAL/FULL and stores only bounded
  boolean observations plus operation metadata, no response bodies or credentials.
  Use an absolute canonical path under an operator-owned 0700 directory. Every ancestor must be a non-symlink owned by root/operator and protected from other-user writes (root sticky temporary ancestors are permitted). Existing leaf/sidecars must be owned, single-link regular 0600 files. No chmod or repair is performed. New files are exclusively created with NOFOLLOW; existing files require the dedicated application/version marker and expected schema. Foreign/empty legacy files and unsafe sidecars are held unchanged. Descriptor/path/parent identities are checked around SQLite open. This assumes a trusted same-UID owner; it is not OS isolation against another process with the operator’s full filesystem authority. WAL/FULL and crash recovery remain required.

Reservation commits before dispatch. A pending record is an uncertain outcome and blocks
replay, including after restart. Only a settled failed check can retry after 30 seconds,
with a maximum of two attempts for each check in the same occurrence. Healthy cached
observations retain their original time and still require current authority. Revision
changes, journal errors/capacity and revocation hold evidence. No timer schedules a retry;
the workflow owner must re-enter with the same occurrence ID. Different occurrences require
the existing single-owner scheduler/admission controls. No successor is provisioned.

Acer is an optional typed aggregate source, with no runtime binding or transport in
startup. Machine addresses, host-key fingerprints, accounts and paths stay in private
operator configuration. `AcerSourceBinding` contains only the reviewed source ID and
opaque host/helper/contract identity digests; `AcerSourceTransport` accepts that fixed
check and an abort signal, with no command, URL or argument selector. The trusted native
transport and current authority provider must independently enforce the actual private
identity. Supplying a digest alone never grants source access.

The source accepts at most 4096 bytes of strict UTF-8 version 1 JSON from a bounded
22-second call. It requires exact unique inbound/outbound components, readOnly true,
workerStarted false and mailSent false, exact status/exit-code agreement and a small
fixed reason vocabulary. Unknown/private fields, contradictory top-level status,
duplicated/foreign components and malformed age values are rejected without retaining
or echoing raw source output. A healthy component requires both reportAgeMs and
workerHeartbeatAgeMs independently between zero and 300000 ms inclusive. A recently
cached report never refreshes its worker heartbeat age. Conservative time elapsed since
local reservation, including transport/authority latency, is added again on cached
acceptance; stale evidence and backwards clocks hold the aggregate.

Private journal revisions additionally bind the runtime identity digests. An identity
change in an existing occurrence holds its old record instead of producing a new
operation ID. Pending public or private records remain unreplayable. Public legacy
results remain readable under their original revision, and cannot substitute for a
private aggregate result. Current authority is checked at read, dispatch, acceptance
and again for every scope before final aggregate or cached delivery. Revocation returns
held evidence without serving cached source observations.

Unresolved private binding keeps Acer explicitly held. Valid disabled, degraded or
unavailable reports also hold the combined aggregate. When explicitly injected trusted
interfaces provide current authorized healthy observations for all checks, the collector
can confirm that read-only source observation; objectiveComplete remains false and
monitoringAccepted remains false. This is never host, installation, native policy or
schedule acceptance. Startup remains disabled and no live transport is provisioned.

Activation additionally needs exact original schedule/instruction inventory and fingerprints,
source/owner/controller approval, native allowed/denied boundary tests, bounded live evidence,
original-owner pause verification and a natural scheduled run. No such action is authorized
by this code preparation. Existing Chat runtime upgrades, app data and other workflows stay
outside this change. Do not install, activate, create grants, make live requests or publish
without their separate required checks and authorization.
