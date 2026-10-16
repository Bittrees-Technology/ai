# Scoped CRM dataset connection

In CRM, open Lead research, create a private list, and open Dataset, agent connection & sharing. Create a dataset connection and copy its MCP configuration. In the Mac app, open Connections → CRM dataset and paste that configuration. The Mac stores the credential in Keychain, bound to its local owner and one dataset. The source URL is fixed to CRM; arbitrary MCP servers are not accepted.

Read dataset and linked CRM records loads saved research plus current, explicitly linked CRM source records. Source snapshots remain separate from research. Edit the research JSON, preview the complete replacement, then save it through MCP. Preserve entry IDs and the loaded version. At most 600 entries fit in a private dataset; publication reviews remain limited to 20 entries. Changed research must have training eligibility pending.

For projects, use `kind: "projects"`, a stable UUID `id`, `name`, `category`, `source`, and `description`. In CRM, select an owned destination workspace and project entries, preview the import, then approve it. New projects start restricted to workspace owners and are linked back to the dataset. Existing names, including archived projects, are blocked rather than silently merged. Import an existing CRM record into the dataset to propose an update instead.

Agent saves never publish CRM records. Review proposed CRM updates in CRM shows field differences and requires a current owner decision. The source rechecks dataset versions, record versions, access and duplicate state at approval. The dataset credential exposes schema/read/save only: it cannot choose new source records, approve, invite, share or publish.

Reads and saves are manual, with no background polling or model tool execution added. After an uncertain save, retry the exact same payload or read the current dataset before editing again. After an uncertain project approval, refresh the dataset and CRM; linked records prevent duplicate creation. Revocation in CRM stops future reads and saves. Removing the Mac credential does not revoke other copies. Already read data cannot be recalled.

Validation includes authenticated local HTTP boundaries, fixed-origin MCP transport, source denial, owner binding, conflicting versions, and an isolated full CRM HTTP ↔ companion HTTP/MCP round trip. Tests with synthetic data do not grant access to a personal dataset.

## Local investor research

Connections → Investor research runs the selected installed Ollama model on approved public HTTPS sources. Enter the research brief, target (1–200 additional people), and up to 100 starting URLs. The worker follows related team/about/contact links on those exact hosts, up to 8 pages per host / 300 pages total. No paid search provider or cloud inference is used. This is bounded site research, not an unrestricted search engine.

The source reader pins public IPv4 DNS results, denies private addresses and off-list redirects, limits responses to 1 MB, and does not bypass authentication, CAPTCHA or access blocks. The model receives only public excerpts and the brief, never CRM credentials or existing private entries. Names and current titles must occur in an exact contiguous evidence quote; a source quote must also establish a US office/location. This does not prove individual residence, accreditation, interest or investment fit. Candidates remain unverified and training-pending.

Small append-only batches use MCP with current versions and stable IDs. Conflicts stop the job with its pending batch retained. Resume reads current state and reconciles exact retries; it never silently replaces records. Jobs/checkpoints are encrypted in the active local content directory. Restart pauses work; resume is explicit. Source exhaustion is reported honestly, even below target. The source connection must remain on the original dataset. An expired or revoked connection stops further saves.

Local execution limits apply per model call; ordinary queued tasks are not started during research. The UI polls only local progress every 10 seconds while a run is active. No CRM polling occurs while idle. Research saves private entries only; publication, sharing, outreach and training approval remain separate human actions.
