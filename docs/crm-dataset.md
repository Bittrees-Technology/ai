# Scoped CRM dataset connection

In CRM, open Lead research, create a private list, and open Dataset, agent connection & sharing. Create a dataset connection and copy its MCP configuration. In the Mac app, open Connections → CRM dataset and paste that configuration. The Mac stores the credential in Keychain, bound to its local owner and one dataset. The source URL is fixed to CRM; arbitrary MCP servers are not accepted.

Read dataset and linked CRM records loads saved research plus current, explicitly linked CRM source records. Source snapshots remain separate from research. Edit the research JSON, preview the complete replacement, then save it through MCP. Preserve entry IDs and the loaded version. At most 20 entries fit in one dataset; use multiple datasets for larger inventories. Changed research must have training eligibility pending.

For projects, use `kind: "projects"`, a stable UUID `id`, `name`, `category`, `source`, and `description`. In CRM, select an owned destination workspace and project entries, preview the import, then approve it. New projects start restricted to workspace owners and are linked back to the dataset. Existing names, including archived projects, are blocked rather than silently merged. Import an existing CRM record into the dataset to propose an update instead.

Agent saves never publish CRM records. Review proposed CRM updates in CRM shows field differences and requires a current owner decision. The source rechecks dataset versions, record versions, access and duplicate state at approval. The dataset credential exposes schema/read/save only: it cannot choose new source records, approve, invite, share or publish.

Reads and saves are manual, with no background polling or model tool execution added. After an uncertain save, retry the exact same payload or read the current dataset before editing again. After an uncertain project approval, refresh the dataset and CRM; linked records prevent duplicate creation. Revocation in CRM stops future reads and saves. Removing the Mac credential does not revoke other copies. Already read data cannot be recalled.

Validation includes authenticated local HTTP boundaries, fixed-origin MCP transport, source denial, owner binding, conflicting versions, and an isolated full CRM HTTP ↔ companion HTTP/MCP round trip. Tests with synthetic data do not grant access to a personal dataset.
