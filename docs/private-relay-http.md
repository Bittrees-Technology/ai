# Explicitly configured private relay HTTP boundary

`createRemoteApp` accepts an optional `privateRelayPolicy`. When absent, private-relay routes are not mounted. Null, incomplete policies, and policies whose origin or chain differ from the app configuration fail at construction. The policy requires explicit content/metadata retention and quotas; this change chooses none for a live host. No startup environment switch, listener, migration command, cleanup timer, browser transport or Mac transport loop is added.

When a future host explicitly supplies the policy, the routes inherit direct TLS and exact Host checks, untrusted proxy headers, per-peer request limits, no-store responses, restrictive content policy and no CORS. Browser requests require the exact Origin, custom request header, same-origin fetch metadata when supplied and no bearer authorization. Browser operations bind the session cookie and account header; endpoint operations additionally require the separate browser registration cookie. Duplicate session/device cookies are rejected. Mac routes reject browser Origin, Cookie and fetch-metadata headers and require the appropriate bearer credential.

The following POST JSON routes are mounted only with the explicit policy:

| Prefix | Operations | Required authority |
| --- | --- | --- |
| `/browser/relay/permission/` | `inspect`, `enable` | Current session, account and browser registration |
| `/browser/relay/mac/` | `approve` | Current owner session/account; separate Mac acceptance still required |
| `/browser/relay/permissions/` | `inspect`, `operation`, `list`, `revoke` | Current owner session/account |
| `/device/relay/approval/` | `inspect` | Current Mac status credential; metadata only for that exact device/epoch |
| `/device/relay/permission/` | `accept` | Current Mac status/pairing credential, exact pending approval and confirmation |
| `/device/relay/permission/` | `inspect`, `revoke` | Separate active private-relay credential |
| `/browser/relay/messages/` | `submit`, `poll`, `inspect`, `acknowledge`, `delete` | Current browser registration/session and independent active relay grant |
| `/device/relay/messages/` | `submit`, `poll`, `inspect`, `acknowledge`, `delete` | Separate active private-relay credential |
| `/browser/relay/history/` | `export`, `delete` | Current owner session/account, even without active endpoint registration/grants |

Only the two exact message-submit paths get the 96KiB JSON ingress limit needed for a maximum-size encrypted envelope. Other paths retain the existing 32KiB limit. Compressed JSON is refused. All bodies are passed to strict backend contracts, with empty inspection bodies checked explicitly. Every endpoint message request also requires `X-Bittrees-Relay-Permission` identifying the exact reviewed grant. The repository compares it with the current grant inside the same transaction before a message read/write, so a stale client cannot silently use a replacement permission. Headers never replace transaction-bound session, registration and grant validation. The Mac can inspect its exact approval metadata with its current status credential before accepting or to reconcile an uncertain acceptance; no relay secret is returned by inspection. Inspection can show expired/revoked metadata, conferring no transport authority. Permission acceptance returns a new secret once; retry after an uncertain response must reconcile this metadata or owner history rather than issue another secret.

Storage receipts, acknowledgement and exported ciphertext have the semantics documented in [private-relay-store.md](private-relay-store.md). No route decrypts content or provides task-execution authority. Permission revocation does not revoke the independent status credential. Owner history remains available until logout/session expiry even if endpoint relay permission is revoked. No cleanup route is exposed.

Actual local HTTPS/PostgreSQL tests use temporary certificates and synthetic SIWE accounts, browser registration and Mac pairing. They verify default-disabled routing, invalid/mismatched policies, separate native opt-in, credential separation, duplicate cookies, account/CSRF rejection, maximum authenticated encrypted transfer, oversized/compressed requests, reverse delivery, receipt retries, owner export/deletion and revocation/logout. No local GUI/browser automation or personal device data is involved.

Live hosting/migrations, user-facing permission controls, durable endpoint credential custody, transport scheduling, retry/backoff/cancellation, cleanup and backup policy, retention choices and independent acceptance remain open. Acer news/model processing is unchanged and is not an inference fallback for the Mac companion.
