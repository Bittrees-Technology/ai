import React, { useEffect, useState } from "react";
import { TemplateController } from "./template-state.js";
export function Templates({
  api,
  profiles,
  onError,
  onTask,
}: {
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
  profiles: { id: string; model: string }[];
  onError: (error: unknown) => void;
  onTask: (id: string) => void;
}) {
  const [, render] = useState(0);
  const [controller] = useState(
    () => new TemplateController(api, () => render((value) => value + 1)),
  );
  useEffect(() => {
    const hide = () => controller.hide();
    const visibility = () => {
      if (document.hidden) hide();
    };
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", visibility);
      controller.hide();
    };
  }, [controller]);
  const draft = controller.draft;
  const act = (work: () => Promise<unknown>) =>
    void work().catch((error) =>
      onError(
        error instanceof Error && error.message === "CAPACITY"
          ? Error("TEMPLATE_CAPACITY")
          : error,
      ),
    );
  return (
    <section className="panel">
      <h2>Local templates</h2>
      <p>
        Keep a reusable prompt and model choice on this Mac. Each run starts a
        new task using exactly the saved text. Templates do not include app
        access or saved memories, and cannot be started remotely yet.
      </p>
      <button
        disabled={controller.busy}
        onClick={() => act(() => controller.load())}
      >
        Show saved templates
      </button>{" "}
      <button disabled={controller.busy} onClick={() => controller.select()}>
        New template
      </button>
      <ul>
        {controller.items.map((item) => (
          <li key={item.id}>
            <button
              disabled={controller.busy}
              onClick={() => controller.select(item)}
            >
              {item.definition.name}
            </button>{" "}
            · Version {item.revision}
          </li>
        ))}
      </ul>
      {draft && (
        <fieldset disabled={controller.busy}>
          <legend>
            {draft.revision
              ? `Review version ${draft.revision}`
              : "New template"}
          </legend>
          <label>
            Name
            <input
              maxLength={80}
              value={draft.definition.name}
              onChange={(e) => controller.edit({ name: e.target.value })}
            />
          </label>
          <label>
            Task type
            <select
              value={draft.definition.kind}
              onChange={(e) =>
                controller.edit({
                  kind: e.target.value as "query" | "summarize" | "draft",
                })
              }
            >
              <option value="query">Question</option>
              <option value="summarize">Summary</option>
              <option value="draft">Draft</option>
            </select>
          </label>
          <label>
            Model
            <select
              value={draft.definition.modelProfileId}
              onChange={(e) =>
                controller.edit({ modelProfileId: e.target.value })
              }
            >
              <option value="">Choose a saved model</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.model} · {profile.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            Exact prompt
            <textarea
              rows={8}
              maxLength={32000}
              value={draft.definition.prompt}
              onChange={(e) => controller.edit({ prompt: e.target.value })}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={controller.confirmed}
              onChange={(e) => controller.confirm(e.target.checked)}
            />{" "}
            I reviewed this prompt and model for the action I choose below.
          </label>
          <p>
            Changes require saving before a run. Deleting a template leaves any
            tasks already created from it; use Data controls to delete task
            history.
          </p>
          <button
            disabled={
              !controller.confirmed ||
              !draft.definition.name.trim() ||
              !draft.definition.prompt ||
              !draft.definition.modelProfileId
            }
            onClick={() => act(() => controller.save())}
          >
            Save template
          </button>{" "}
          <button
            disabled={!controller.confirmed || !controller.saved}
            onClick={() =>
              act(async () => {
                const task = await controller.run();
                if (task) onTask(task.id);
              })
            }
          >
            Run saved template
          </button>{" "}
          <button
            disabled={!controller.confirmed || !controller.saved}
            onClick={() => act(() => controller.remove())}
          >
            Delete template
          </button>
        </fieldset>
      )}
      <p role="status">
        {controller.busy
          ? "Working…"
          : "Prompt previews clear when this window loses focus. Saved templates stay until you delete them and are included in your data export."}
      </p>
    </section>
  );
}
