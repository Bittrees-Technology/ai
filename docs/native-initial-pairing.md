# First-time native owner pairing

This is inactive client preparation. No launcher, HTTP route, dashboard, model or MCP tool imports these modules. The reserved Roles start/poll paths are a proposed counterpart contract, not deployed endpoint evidence. Installed software is unchanged by this source preparation.

## Boundary

An existing local Ed25519 identity and explicit native consent start pairing. There is no existing Roles bearer, credential, owner/profile UUID, workspace, native lease or Agent controller prerequisite. Roles derives the owner later from its original authenticated session, with current active-person identity and applicable Roles. Registration and pairing grant no action authority.

`initial-pairing.ts` creates a dedicated signed initial request and fresh signed polls, verifies a short-lived Roles-signed metadata result, binds the exact request/challenge/poll/native consent, and caps consent at five minutes and 62 calls. Unknown start outcomes remain held under their saved operation ID; reconstruction never automatically starts another mutation. Source results require `rolesCredentialId: null`, `runtimeEnrolled: false`, no workspace/lease/controller and no permissions. The key fingerprint is not a usable Roles credential. Pairing must not insert a generic MCP credential or activate a preexisting grant.

`initial-pairing-store.ts` supplies an encrypted SQLite journal using the already unlocked native Vault, identity-bound authenticated encryption, FULL/WAL durability and revision CAS. The caller owns the connection and must enforce its native owned-path/no-symlink/file-permission policy before opening it. Concurrent starts/polls cannot overwrite a newer durable result. Synthetic SQLite tests close and reopen the database and verify unknown-outcome retention without replay. These tests establish no production enrollment or persistence acceptance.

`initial-pairing-https.ts` allows only the two exact HTTPS POST endpoints. It sends no credential, cookie or Origin header, forbids redirects, pins a validated public IPv4 address while retaining hostname TLS verification, caps responses at 16 KiB and requests at 15 seconds, and rechecks source/native admission after DNS and response completion. Its trusted admission callback must enforce exact native consent, reviewed source signing purpose and current source/cost evidence. No network occurs on construction. Responses cannot choose the trusted source key.

`initial-pairing-signer.ts` reads only the existing encrypted task identity and checks key continuity. It signs only canonical initial-pairing request/poll domains under current exact native consent. Missing keys do not initialize themselves. No private key is returned, no workspace is required, and neither wallet, transaction, delegation nor generic MCP signature domains are accepted. A future device-held transaction key must remain separate.

## Required counterpart and native wiring

Before activation, the Roles owner must implement/review actual start, fresh-session owner review and poll routes; current person/role/source-purpose checks; durable replay/rate/expiry controls; atomic cross-owner/no-resurrection binding; and a reviewed source verification key specifically admitted for this metadata purpose. Existing runtime-enrollment source keys are not automatically approved for this new purpose.

The native owner flow must provide real bounded consent, safe owned journal open, existing-key signer and fixed transport with exact admission. Inspection/local initialization remains a separate explicit action. Do not synthesize IDs or flags, expose the helper to the model/browser, accept pasted private keys, or direct the user to an unimplemented source endpoint. Cancellation during the durable result write leaves the outcome held.

Actual runtime credential/device enrollment, canonical Agent controller admission, per-action Roles/source scope, until-revoked delegation, central worker execution and successor/revocation evidence remain separate acceptance requirements. No Safe or other transaction approval is implied by pairing.
