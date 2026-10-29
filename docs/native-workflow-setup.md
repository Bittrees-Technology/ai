# Native workflow setup

The native **Review workflow identity…** menu works without `native-enrollment.json`
or a successful hosted permissions heartbeat. Its loopback capability belongs only
to the native shell and is excluded from the core engine's environment allowlist.
The helper starts without opening Keychain, reading identity state or contacting a
source. A separate owner confirmation precedes inspection of existing local state.

Inspection opens `task-sync.db` read-only, verifies the saved Ed25519 key pair and
returns only its existing public principal/key fingerprint and saved workspace
context. It never treats another local identity as the task workflow key. A missing
key is distinct from an unreadable, corrupt, symlinked or inconsistent existing key;
errors hold the flow rather than replacing state. Saved workspace context is not
current source authorization.

When the task key is missing, the native owner can separately choose **Create local
identity**. This consumes a one-use, exact review digest within sixty seconds.
The helper rechecks admission after asynchronous unlock and under the SQLite write
transaction. The private key is encrypted before insertion. An existing key is
never replaced, and unrelated state is preserved. Unknown outcomes require local
inspection/reconciliation before another attempt; no automatic regeneration or
cleanup is performed. Tests initialize synthetic temporary state only.

Neither inspection nor initialization registers a Roles credential, selects an
Agent controller, signs a delegation, changes a grant, activates a schedule or
contacts a network source. No profile ID, key, controller or authority is accepted
from web/model arguments. This is the first native setup action, not completed
enrollment. Only an authenticated active person with currently applicable Roles
can perform the later separately scoped contributor/delegation approvals.

The remaining bootstrap stage must resolve the actual existing source credential,
current source device/owner/workspace and included-usage evidence before preparing
the finite native enrollment session. It must not generate fixture authority IDs,
use a wallet label as authentication, or assume this public identity is enrolled.
Roles enrollment, Agent canonical admission/controller consent, source access and
workflow execution retain their own current authorization and Safe approvals.

The candidate preserves the sandbox and existing app/data. Packaging includes the
new native UI source; installation still requires all required checks on the exact
head, staged native startup/boundary verification and the reviewed rollback path.
