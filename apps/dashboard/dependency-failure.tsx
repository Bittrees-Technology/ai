import React from "react";
import { dependencyFailureSchema } from "../../modules/storage/dependency-failure.js";
export function DependencyFailureNotice({ result }: { result: unknown }) {
  const failure = dependencyFailureSchema.safeParse(result);
  if (!failure.success) return null;
  return (
    <section
      className="dependency-failure"
      aria-label="Required task did not complete"
    >
      <h3>A required task did not complete</h3>
      <p>
        This task cannot run because a required task failed, was cancelled, or
        expired. Review the prerequisites before creating a new task. It will
        not retry automatically.
      </p>
      <ul>
        {failure.data.prerequisites.map((p) => (
          <li key={p.taskId}>
            <span>Required task {p.taskId}</span> — {p.status}
          </li>
        ))}
      </ul>
    </section>
  );
}
