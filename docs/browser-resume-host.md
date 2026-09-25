# Browser session controller for resume consent

BrowserKeyHost owns the resume consent lifecycle within the signed-in owner/session. Inspection, preparation and approval obtain a fresh verified identity and current paired-key context. Status, revocation and clearing use the existing local exclusive operation, so removing authority does not require a network request. Reset requires a verified device.

Host cancellation, logout, account/session changes, identity failure and close invalidate pending resume reviews alongside other private panels. Lazy opening checks the host generation and closes an instance created after cancellation. Public methods return consent metadata, never an authorized sender, private key handle or task execution capability.

This is internal integration only. User-facing resume controls, encrypted command/receipt delivery and activation remain unfinished.

Validation: all949 local tests, type checking and production builds pass. Two new actual-identity-server browser scenarios, across three engines, cover independent review/retention/offline revocation and cancellation/account change. These are scheduled in disposable CI and have not yet passed.
