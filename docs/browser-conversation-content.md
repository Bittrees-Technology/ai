# Retained browser conversation content

The internal browser engine prepares messages and exact answers, authenticates Mac
messages and questions, and retains original encrypted envelopes and acceptance
receipts. It does not add a user interface, perform network delivery, reconcile
remote receipts, or enable the installed Mac app. The Acer news runtime is separate.

Content lives in version13 of the existing private browser database. At-rest rows
use nonextractable AES-GCM keys and bind ciphertext to owner scope, hashed wire ID,
device and revision. No plaintext message, question or conversation selector is
stored in row metadata. These local keys are accessible to this origin's code;
this does not claim protection against a compromised authenticated origin.

Permission, current owner/device/key/peer proof and generation-time replay coverage
are required. Crypto runs outside IndexedDB transactions. Admission rechecks those
proofs in one transaction with the content row, hash-only shared incoming replay
ledger and shared outgoing receipt sequence. A failed write rolls all three back.
Conflicting wire IDs, cross-family replay and missing retained duplicate outcomes
fail closed. Unknown parents remain pending without consuming replay. A question
answer derives its task ID and expected revision from the authenticated stored
question. An ordinary reply remains a message.

Retried preparation requires the identical request; retried envelope retrieval
returns the original ciphertext. Concurrent writers use revision and sequence
checks, with explicit retry after a conflict. Changing consent during crypto denies
publication. A completed offer transport acknowledgement changes receipt history,
not the approved conversation authority. Changed/replaced consent does not silently
broaden access to old rows.

Delivery deadlines prevent new delivery or acceptance; they do not delete saved
content. Reading retained content still requires current conversation authority.
Explicit owner export requires a currently verified matching account and can retain
history after that permission expires. It exports content/envelopes, never storage
keys or reusable permission proofs; there is no runtime-authority import. Explicit
local deletion works offline and locks conversation consent in the same transaction.
Hash-only incoming replay fences survive deletion to prevent recreation by replay.
Limits are 128 retained records per local owner, 4,096 total and 200KB per encrypted
value; reaching a limit requires explicit cleanup, never automatic eviction.

The version12 fixture is compiled from actual source
`25a119464989d50790f1861d50bdf9cc12abf3c8`. Its modules archive SHA256 is
`806aa588eba4b4ffb96a5ea08cb007cea79ccfc72d706d3a342304873bad7d99`.
The additive upgrade leaves keys, consent, tasks, channels and incoming replay
unchanged; older writers refuse version13. Browser acceptance runs only on disposable
GitHub runners in Chromium, Firefox and WebKit, including actual Mac-engine message
interoperability, exact question answers, storage failure, revoked authority during
crypto, retention/export/deletion and actual version12 preservation. Local build
success alone is not browser acceptance.

Remaining work includes browser UI wiring, reviewed relay content transfer,
receipt reconciliation, complete end-to-end historical replay acceptance and release
acceptance. No personal data, native credential access, local browser automation,
installed application replacement, live service activation or model changes are part
of this package.

## Trusted browser host

`BrowserKeyHost.conversationContentAPI` supplies per-operation verified device
identity and current key/peer proof for list/read/prepare/envelope/accept. The engine
rechecks those proofs and independent consent through its common database writes.
Selected-grant listing decrypts locally but returns only metadata; it does not open
messages for display or grant permission to send. Expired delivery deadlines do not
erase saved rows or remove them from an otherwise current authorized listing.

Explicit archive export requires current matching owner/device verification but
permits retained history after key revocation. It exports no private key or reusable
authority. Explicit local deletion requires the same signed-in host owner/session
and confirmation, works without a network call, locks conversation consent and
leaves task permission and hash-only replay fences intact. Logging out invalidates
all these operations. The shared host operation lock, close, cancellation and
account/registration-change paths include conversation content.

The authenticated host adds no relay call or automatic send. Browser UI review,
relay transport and end-to-end user acceptance remain separate work.

A failed final identity response can occur after the short local transaction has
committed. It is an unconfirmed outcome, not evidence that nothing was saved. The
caller must explicitly inspect the metadata and retry the same operation identity;
prepared content, sealed ciphertext and accepted outcomes are reused. These flows
do not claim an atomic transaction between identity-server state and IndexedDB.
