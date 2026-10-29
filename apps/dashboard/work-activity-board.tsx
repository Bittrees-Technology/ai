import "./work-board.css";
import React, { useState, type ReactNode } from "react";
import {
  centralLane,
  centralRunUrl,
  researchLane,
  workLanes,
  type WorkLane,
} from "./work-activity-state.js";

export function WorkActivityBoard({
  jobs,
  central,
  renderJob,
}: {
  jobs: any[];
  central: any;
  renderJob: (job: any) => ReactNode;
}) {
  const [view, setView] = useState("board");
  const cards: { id: string; lane: WorkLane; content: ReactNode }[] = jobs.map(
    (j) => ({
      id: "research:" + j.id,
      lane: researchLane(j.state),
      content: (
        <>
          <p className="work-origin">Research on this Mac</p>
          <h3>{j.input.brief.slice(0, 100)}</h3>
          <p>
            {j.added} of {j.input.target} people saved as research
          </p>
          <p>
            {j.state === "complete"
              ? "Research target reached; CRM additions are checked separately."
              : j.error || j.activity?.phase || j.state.replaceAll("_", " ")}
          </p>
          <small>Run {j.id}</small>
          <details>
            <summary>Progress &amp; evidence</summary>
            {renderJob(j)}
          </details>
        </>
      ),
    }),
  );
  const job = central?.currentJob,
    receipt = central?.lastReceipt;
  if (job)
    cards.push({
      id: "central:" + job.id,
      lane: centralLane(central),
      content: (
        <>
          <p className="work-origin">Bittrees Workflows · This Mac</p>
          <h3>{job.title}</h3>
          <p>Step {job.stepIndex + 1}</p>
          <p>
            {central.progress?.message ||
              (job.completionPending
                ? "Local output saved; waiting for central confirmation."
                : central.running
                  ? "Local execution in progress"
                  : central.enabled
                    ? "Waiting for authorized execution"
                    : "This Mac is paused")}
          </p>
          <small>Run {job.runId}</small>
          <p>
            <a
              href={centralRunUrl(central.workflowId, job.runId)}
              target="_blank"
              rel="noreferrer"
            >
              Open workflow, role &amp; evidence
            </a>
          </p>
        </>
      ),
    });
  if (receipt && receipt.jobId !== job?.id)
    cards.push({
      id: "central:" + receipt.jobId,
      lane: "done",
      content: (
        <>
          <p className="work-origin">Bittrees Workflows · Confirmed step</p>
          <h3>Step {receipt.stepIndex + 1} completed</h3>
          <p>
            {receipt.followUpQueued
              ? "The next step was queued centrally."
              : "The central source confirmed this step."}
          </p>
          <p>Model: {receipt.model}</p>
          <small>Run {receipt.runId}</small>
          <details>
            <summary>Completion receipt</summary>
            <p>{new Date(receipt.completedAt).toLocaleString()}</p>
            <p>Evidence: {receipt.evidenceHash}</p>
            <p>
              A completed step does not establish completion of the whole
              workflow.
            </p>
          </details>
          {receipt.workflowId && (
            <p>
              <a
                href={centralRunUrl(receipt.workflowId, receipt.runId)}
                target="_blank"
                rel="noreferrer"
              >
                Open central run
              </a>
            </p>
          )}
        </>
      ),
    });
  return (
    <section className="work-activity" aria-label="Work activity board">
      <div className="work-board-tools" role="group" aria-label="Activity view">
        <button
          aria-pressed={view === "board"}
          onClick={() => setView("board")}
        >
          Board
        </button>
        <button aria-pressed={view === "list"} onClick={() => setView("list")}>
          List
        </button>
      </div>
      <p>
        Workflows:{" "}
        {central
          ? central.configured
            ? central.enabled
              ? "Listening for authorized work"
              : "This Mac is paused"
            : "This Mac is not connected"
          : "Connection status unavailable"}
        . Central cards show this Mac’s current step and last confirmed receipt.
        Open Workflows for the full role-based queue.
      </p>
      {view === "board" ? (
        <div
          className="work-board"
          tabIndex={0}
          role="region"
          aria-label="Work lanes"
        >
          {workLanes.map(([id, label]) => (
            <section
              className={"work-lane work-lane-" + id}
              key={id}
              aria-label={label}
            >
              <h2>
                {label}
                <span>{cards.filter((c) => c.lane === id).length}</span>
              </h2>
              {!cards.some((c) => c.lane === id) && (
                <p className="work-lane-empty">No work here</p>
              )}
              {cards
                .filter((c) => c.lane === id)
                .map((c) => (
                  <article className="work-summary" key={c.id}>
                    {c.content}
                  </article>
                ))}
            </section>
          ))}
        </div>
      ) : (
        <div className="work-board-list">
          {cards.map((c) => (
            <article className="work-summary" key={c.id}>
              <p>{workLanes.find(([id]) => id === c.lane)?.[1]}</p>
              {c.content}
            </article>
          ))}
        </div>
      )}
      {!cards.length && (
        <p>No work recorded. Choose a workflow to start a run.</p>
      )}
    </section>
  );
}
