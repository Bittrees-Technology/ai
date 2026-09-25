# AutoNote companion approval setup

Use the existing companion tokens: canvas #edf3f6, ink #183945, surface #ffffff, border #aabec5 and focus #29658b. Retain Avenir/system typography and left-aligned Connections layout. Place a separate approval section immediately after AutoNote's transcript connection, with status, source setup link, code entry, cancellation and local removal. This is a permission setup flow, not an exact-draft approval screen; no new visual system or navigation is needed.

Review against the brief: distinguish transcript read access from meeting-note approval, explain source review before exchanging a code, and keep source revocation separate from local removal. Setup uses its own Keychain service and pins the parent meeting connection. Tokens never enter UI responses. This package deliberately exposes no save endpoint: durable exact-proposal review and encrypted transport are the next implementation step.

Working behavior: a stored approval credential is metadata, not a guarantee of current source authority. Source permissions are checked when eventually used. Parent removal or replacement makes stored approval unavailable. Cancel discards the in-memory exchange verifier; uncertain exchange is not automatically retried. Remove deletes only the local approval credential. Source revocation remains available at AutoNote's permission page.
