# Workflows and permissions

The website at `/workflows` and the Mac app's **Workflows & permissions** page show the connected device, declared engine, last contact, approval status, activity and held reviews. The Mac's five-minute runner checks the central permission before continuing. Supplier discovery remains every six hours, up to 20 offers per run.

## Approval

Sign in with an Ethereum browser wallet, then separately review and sign a workflow approval. The server creates a five-minute, browser-bound SIWE challenge. The signed message identifies the domain, wallet, device, declared engine, current source permissions and duration. Its resource digest binds the complete stored approval, including the exact source credentials. Successful signatures are consumed atomically. A login signature cannot authorize a workflow.

Approvals can last one day, 30 days or until revoked. The existing Raging workflow is bound to the Ethereum address already verified by its CRM owner account, independently matched to `raging.eth`. ENS is a display/reference name, not a substitute for signature verification. The migration does not fabricate a signature. It pauses this workflow until its owner signs.

Each server-side execution check rejects paused, revoked, expired or unsigned wallet-required grants. It checks the approved device metadata, source credential and scope. New credentials and added scopes require fresh approval. Pause blocks future requests; resume requires another signature. Revoke is permanent for that grant. An already accepted request can finish. Source apps continue to enforce their own roles, workspace assignment, qualification policy and duplicate protection.

The Mac holds encrypted service credentials; browsers receive no source or control token. A control token can report status, pause or revoke, but cannot approve or resume. The device ID is bound to the provisioned credential; this is not hardware attestation and does not prevent misuse of a stolen decrypted credential.

## Other people and devices

A new user opens the Mac page, chooses a configured local model or the rule-based engine, creates a ten-minute pairing code, and enters it on the website. The wallet owner reviews and signs the exact device. The pending registration has no source-app credentials. No Raging permissions are copied. Each user's wallet sees only authorities bound to that wallet.

Pairing records the selected engine; it does not start a model or automatically provision Mercado/CRM integration grants. Users manage models in **Models**, and independently authorize sources in **Connections**. This release exposes the existing Mercado coordinator and a reusable device/approval foundation. Connecting a newly paired user's source grants to an automatic marketplace runner still requires scoped integration provisioning. Generic model-driven workflows are not enabled by the supplier workflow approval.

The first release supports EOA browser-wallet signatures and EIP-6963 wallet discovery. Contract-wallet validation and WalletConnect QR pairing are not yet implemented. Use a wallet browser or an injected browser wallet.

## Deployment and verification

Apply `modules/remote/migrations/workflow-wallet-permissions.sql` after the authority and marketplace-status migrations, using the existing migration owner. Grant the application's runtime role DML on the three new portal tables. Test on an isolated Neon branch before production. Existing grants retain their behavior until explicitly switched to `require_wallet=true`; new paired devices always require a wallet signature.

`/api/workflows` enforces same-origin browser requests, secure HttpOnly Strict-SameSite cookies, bounded payloads and database rate limits. Device service requests reject browser origins/cookies. Activity synchronization only includes bounded receipt summaries; proposals, secrets and CRM contact payloads remain local or in source apps. The new status payload includes held-review reasons and IDs so both views can direct users to source review queues.

Run the dedicated local PostgreSQL test with `COORDINATOR_TEST_DATABASE_URL=... node --import tsx scripts/workflow-wallet-e2e.ts`. It tests signature validity, replay, browser binding, other-wallet denial, pairing, unsigned execution denial, scope changes, pause, signed resume, expiry and revocation. Run the existing marketplace integration and unit tests as well.
