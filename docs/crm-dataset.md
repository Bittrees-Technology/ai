# Scoped CRM dataset connection

In CRM, open Lead research, create a private list, and open Dataset, agent connection & sharing. Create a dataset connection and copy its MCP configuration. In the Mac app, open Connections → CRM dataset and paste that configuration. The Mac stores the credential in Keychain, bound to its local owner and one dataset. The source URL is fixed to CRM; arbitrary MCP servers are not accepted.

Read dataset and linked CRM records loads saved research plus current, explicitly linked CRM source records. Source snapshots remain separate from research. Edit the research JSON, preview the complete replacement, then save it through MCP. Preserve entry IDs and the loaded version. At most 600 entries fit in a private dataset; publication reviews remain limited to 20 entries. Changed research must have training eligibility pending.

For projects, use `kind: "projects"`, a stable UUID `id`, `name`, `category`, `source`, and `description`. In CRM, select an owned destination workspace and project entries, preview the import, then approve it. New projects start restricted to workspace owners and are linked back to the dataset. Existing names, including archived projects, are blocked rather than silently merged. Import an existing CRM record into the dataset to propose an update instead.

Without an enabled automatic-addition project permission, agent saves do not create CRM records. Review proposed CRM updates in CRM shows field differences and requires a current owner decision. The source rechecks dataset versions, record versions, access and duplicate state at approval. The dataset credential cannot choose new source records, invite, share or approve training. Explicit project capabilities separately permit automatic additions and eligible task work; shared sign-in alone grants neither.

Manual dataset editing and automated research use the same scoped connection. After an uncertain save, retry the exact same payload or read the current dataset before editing again. After an uncertain project approval, refresh the dataset and CRM; linked records prevent duplicate creation. Revocation in CRM stops future reads and saves. Removing the Mac credential does not revoke other copies. Already read data cannot be recalled.

Validation includes authenticated local HTTP boundaries, fixed-origin MCP transport, source denial, owner binding, conflicting versions, and an isolated full CRM HTTP ↔ companion HTTP/MCP round trip. Tests with synthetic data do not grant access to a personal dataset.

## Local investor research

Connections → Investor research runs the selected installed Ollama model on approved public HTTPS sources. Enter the research brief, target (1–200 additional people), and up to 100 starting URLs. The worker follows related team/about/contact links on those exact hosts, up to 8 pages per host / 300 pages total. No paid search provider or cloud inference is used. This is bounded site research, not an unrestricted search engine.

The source reader pins public IPv4 DNS results, denies private addresses and off-list redirects, limits responses to 1 MB, and does not bypass authentication, CAPTCHA or access blocks. The model receives only public excerpts and the brief, never CRM credentials or existing private entries. Names and current titles must occur in an exact contiguous evidence quote; a source quote must also establish a US office/location. This does not prove individual residence, accreditation, interest or investment fit. Candidates remain unverified and training-pending.

Small append-only batches use MCP with current versions and stable IDs. Conflicts stop the job with its pending batch retained. Resume reads current state and reconciles exact retries; it never silently replaces records. Jobs/checkpoints are encrypted in the active local content directory. Restart pauses work; resume is explicit. Source exhaustion is reported honestly, even below target. The source connection must remain on the original dataset. An expired or revoked connection stops further saves.

Local execution limits apply per model call; ordinary queued tasks are not started during research. The UI polls only local progress every 10 seconds while a run is active. Research does not poll CRM while idle; an open task editor refreshes its task list separately. Research saves private entries and, when enabled for a destination project, automatically adds new CRM records. Sharing, outreach and training approval remain separate actions.

## Research saves versus CRM records

Work activity labels the run count as **people saved as research**. This counts private dataset entries, not CRM contacts. **In CRM** uses confirmed dataset links and reviewed import mappings returned by CRM; it displays dataset-wide people/organization totals and the last check time. Missing historical status is shown as not checked, never as zero confirmed imports. During a run, these counts refresh on source dataset reads and after saves.

Enable automatic additions for an explicit destination project at CRM → Local AI. With that permission, new appended entries become CRM People/Organizations without per-batch approval, retain unverified-research labeling and follow project sharing. Task access is separate. Permissions expire within 30 days and can be revoked. Existing research is not imported retroactively; selected older entries use the existing import flow. Duplicates and changed authority stop the operation rather than silently overwriting records.

## Task editing and synchronization

In Connections, choose a task-enabled project to view its AI draft/review tasks. New CRM task and Edit save directly to CRM; the list refreshes every minute while visible (and on focus or manual refresh), including during research. You can change the name, brief, due date and Open/Done status without changing the task owner, sharing or linked records. No model is needed for these edits.

CRM remains authoritative. Every edit includes the version you read and a retry identifier. Conflicts preserve the local draft and require reopening the current task; exact retries do not create duplicates. A changed task also blocks a stale worker result. Closed app/offline state cannot continuously sync; the last successful sync time is displayed. Task runs appear in the owner-only workflow catalogue as metadata; names, briefs and results are not copied there. The catalogue does not start task execution. Existing project grants still govern access.

Task editing and research share a bounded FIFO queue of individual CRM requests. Research need not pause for task creation, edits or refresh. Connection replacement or removal invalidates queued requests from the old connection; failed requests release the queue without automatically retrying writes. Task version checks still reject stale edits and late worker results. Model execution retains its existing single-worker admission rules.

Read polling uses a separate bounded CRM budget from mutations. The editor stops background polling when hidden and refreshes immediately after a save. A source429 starts a ten-minute cooldown for that request lane, displays a rate-limit explanation, and preserves the draft without automatically retrying writes.

## Qualification of existing people

Enable **qualification research and label-only updates** for the intended project in CRM → Connected projects. This is a separate permission, disabled by default; it does not grant access to other projects or permission to send messages, delete records, approve training or change sharing.

In the local app, Connections → Investor qualification loads connected projects and previews mapped people and their labels. Select up to 20 people, an installed local model, investment requirements and approved public URLs. The worker reads up to six pages per person on those exact HTTPS hosts, then evaluates investment role, individual US location, Bitcoin/leverage mandate, cross-border mandate, vehicle and ticket. Quotes must match fetched text; unknown evidence cannot qualify a person. These are research labels, not proof of interest or offering eligibility.

`qualification.context` reads stable-ID mappings and versions; `qualification.enrich` saves evidence to the private dataset and updates only the mapped person's category; `qualification.sync` copies existing qualification labels in batches of at most20. Descriptions, organization links, contact details, sharing and owner-private notes are preserved. Enrichment leaves training pending or excluded. An interrupted save retains its exact payload for reconciliation; concurrent edits stop stale results. Local status polling does not call CRM.

Use **Sync previewed labels only** to copy reviewed dataset categories without reimporting profiles. Refresh the preview if data changed. The shared local model scheduler gives enrichment, discovery and project tasks separate turns.
