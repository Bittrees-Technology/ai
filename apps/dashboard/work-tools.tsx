import { CentralWorkflows } from "./central-workflows.js";
import React, { useState } from "react";
import { DirectoryWorkflows } from "./directory-workflows.js";
import { QualificationPanel } from "./qualification.js";
import { ProjectWorkPanel } from "./project-work.js";
import { InvestorResearchPanel } from "./investor-research.js";
import { CrmDatasetPanel } from "./crm-dataset.js";
import { CrmDrafts } from "./crm-drafts.js";
import { AutoNoteDrafts } from "./autonote-drafts.js";
import { AutoNoteApprovalPanel } from "./autonote-approval.js";
import { MailSendPanel } from "./mail-send.js";
export function WorkTools(props: {
  api: (
    path: string,
    method?: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<any>;
  onError: (error: unknown) => void;
  profiles: { id: string; model: string }[];
  onCreated: (id: string) => void;
}) {
  const [tool, setTool] = useState("");
  return (
    <section aria-label="Work controls">
      <label>
        Workflow
        <select value={tool} onChange={(e) => setTool(e.target.value)}>
          <option value="">Choose a workflow</option>
          <option value="central">Central workflows</option>
          <option value="directory">Directory discovery and validation</option>
          <option value="tasks">CRM task worker</option>
          <option value="discovery">Investor discovery</option>
          <option value="evidence">Investor evidence review</option>
          <option value="dataset">Research dataset editor</option>
          <option value="crm">CRM drafts</option>
          <option value="autonote">AutoNote drafts and approvals</option>
          <option value="mail">Mail delivery</option>
        </select>
      </label>
      <p>
        These controls manage existing workflows. Switching views does not stop
        background work.
      </p>
      {tool === "central" && <CentralWorkflows api={props.api} />}
      {tool === "directory" && <DirectoryWorkflows api={props.api} />}
      {tool === "tasks" && <ProjectWorkPanel {...props} />}
      {tool === "discovery" && <InvestorResearchPanel {...props} />}
      {tool === "evidence" && <QualificationPanel {...props} />}
      {tool === "dataset" && <CrmDatasetPanel {...props} manageData />}
      {tool === "crm" && <CrmDrafts {...props} />}
      {tool === "autonote" && (
        <>
          <AutoNoteDrafts {...props} />
          <AutoNoteApprovalPanel api={props.api} />
        </>
      )}
      {tool === "mail" && <MailSendPanel api={props.api} />}
    </section>
  );
}
