# MyCloud fixed health helper

macOS sandbox network filters reject literal non-local addresses. Never replace the NAS exception with wildcard SSH egress. The companion/model sandbox remains byte-for-byte loopback-only.

The local development launcher starts a fixed-purpose helper outside that sandbox, then starts the existing native companion inside it. The helper listens only on an ephemeral IPv4 loopback port, uses a fresh per-launch random secret, and exposes only authenticated POST `/health` with a UUID operation ID. Caller-supplied hosts, commands, paths, arguments and browser Origins are rejected. It is not an SSH/TCP proxy. No cloud services or new credentials are provisioned.

Before and after the bounded check, the helper reads the companion's dedicated authenticated one-bit approval callback. This checks the actual approved MyCloud recurring definition, its original source fingerprint and current execution admission. This callback cannot read other APIs or grant authority. It fails closed before the companion is available or after approval is revoked.

The helper verifies existing source/dependency hashes and the NAS host-key set before and after execution. A fixed isolated Python bootstrap runs the pinned original checker with a hardened fixed SSH argv: `/usr/bin/ssh -F /dev/null`, explicit reviewed key/known-host file, strict host checking, no global host file, only root@192.168.1.164 port22. User SSH aliases/proxies/config commands cannot redirect the approved operation. The checker remains read-only remotely; its existing local health-latest report behavior is preserved.

Own process-group cancellation/deadline,32KiB source output,one operation at a time,one new operation per minute,48-response transient cache and10000-ID per-launch replay bound apply. All accepted observations and meaningful notification evidence remain in the existing encrypted MyCloud source store; no schedule changes are implied. Helper closes with the native child. Original automation remains active until separate native verification and owner-controlled pause/in-flight reconciliation.

Before installation: compile unchanged sandbox with a harmless command, test allowed helper request and rejected arbitrary request/direct egress, verify native source/launcher paths/signature, preserve rollback and stage exact checked commit. A successful source probe is not native schedule cutover.
