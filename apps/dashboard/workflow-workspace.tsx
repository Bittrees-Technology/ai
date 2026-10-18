import { Agents } from "./agents.js";
import { RecurringWork } from "./recurring.js";
import React, { useState } from "react";
import { Templates } from "./templates.js";
import { WorkTools } from "./work-tools.js";
import { Workflows } from "./workflows.js";
export function WorkflowWorkspace(props: {
  api: (
    path: string,
    method?: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<any>;
  profiles: { id: string; model: string }[];
  onError: (error: unknown) => void;
  onTask: (id: string) => void;
  onActivity: () => void;
}) {
  const [view, setView] = useState("sequences");
  return (
    <section className="content" aria-label="Workflows">
      <h2>Workflows</h2>
      <p>
        Choose the work, its instructions and model, and the access it can use.
        Track execution and results in Work activity.
      </p>
      <nav aria-label="Workflow views">
        {(
          [
            ["sequences", "Task sequences"],
            ["agents", "Task queue & agents"],
            ["instructions", "Saved instructions"],
            ["recurring", "Recurring work"],
            ["permissions", "Permissions & sync"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            aria-current={view === id ? "page" : undefined}
            onClick={() => setView(id)}
          >
            {label}
          </button>
        ))}
        <button onClick={props.onActivity}>View work activity</button>
      </nav>
      {view === "sequences" && (
        <>
          <p>
            Existing workflows control research, evidence checks, CRM work and
            follow-up tasks. Each keeps its own trigger, model and completion
            rules.
          </p>
          <WorkTools {...props} onCreated={props.onTask} />
        </>
      )}
      {view === "agents" && <Agents api={props.api} models={props.profiles} />}
      {view === "instructions" && <Templates {...props} />}
      {view === "recurring" && <RecurringWork api={props.api} />}
      {view === "permissions" && <Workflows api={props.api} />}
    </section>
  );
}
