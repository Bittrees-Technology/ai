# Focused CRM summaries

Choose **Use focused CRM summary** in the companion's selected-record draft form. Existing free-form drafts remain available. This is an explicit local workflow, not a hosted Jev connection or an automatic product classifier.

The server accepts `workflow: "crm-summary-v1"` on the existing CRM drafts endpoint and creates a summarize task. The worker verifies a CRM source binding and rejects memory, dependency inputs and other task kinds. The existing connector owns permission and revision validation; model decisions never grant authority. The run history records the objective, selected record IDs, workflow version, permitted action, completion criteria and model-call budget.

Execution follows this sequence:

1. Check current source access and task dependencies.
2. Pin the selected local model; apply the existing wall-time/cancellation boundaries.
3. If explicitly requested, use the existing bounded owner-clarification flow.
4. Generate one structured summary or stop decision. No tools are exposed.
5. Validate the output shape and resolve every claim's citations to the selected record revisions.
6. Recheck source access and revisions before storing the result.

Each run allows one generation, or two with clarification enabled. Existing clarification limits, transient retry policy and execution timeout still apply. A resumed run revalidates the binding; it does not inherit permission from an earlier result. These are per-run bounds, not a new cumulative billing budget.

A stop decision is a completed decision with no summary, displayed as **Stopped**. Malformed output, invented references or tool-call payloads fail without a saved result. There is no automatic repair loop or alternate model. Record content, owner clarifications and model responses cannot expand the tool set or enable publication. Publishing a valid draft still uses the separate existing CRM review flow.

Citation checking establishes that referenced records and revisions exist in the authorized selection. It does not prove factual entailment or guarantee that the model correctly identifies every off-topic request. All summaries remain unreviewed. Personal-model quality acceptance remains pending.

This change does not alter the Acer server, News models, installed Mac app, connector consent or remote hosting. Subsequent products should add their own versioned workflow and validation rather than widening this workflow's permissions.
