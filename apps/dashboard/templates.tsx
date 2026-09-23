import { profileLabel } from "./model-profile-settings.js";
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
  const [maxRuns, setMaxRuns] = useState(1),
    [minutes, setMinutes] = useState(60);
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
  const act = (work: () => Promise<unknown>, remote = false) =>
    void work().catch((error) =>
      onError(
        error instanceof Error && error.message === "CAPACITY"
          ? Error(remote ? "REMOTE_TEMPLATE_CAPACITY" : "TEMPLATE_CAPACITY")
          : error,
      ),
    );
  return (
    <section className="panel">
      <h2>Local templates</h2>
      <p>
        Keep a reusable prompt and model choice on this Mac. Each run starts a
        new task using exactly the saved text. Templates do not include app
        access or saved memories. Remote runs require a separate reviewed
        permission below.
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
                  {profileLabel(profile)}
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
      <section aria-labelledby="remote-template-title">
        <h3 id="remote-template-title">Allow a remote template request</h3>
        <p>
          The prompt and model choice stay on this Mac. Only the template code,
          version, expiry and run limit appear remotely. Editing or deleting the
          template cancels its permission and unfinished remote runs.
        </p>
        <button
          disabled={controller.busy}
          onClick={() => act(() => controller.refreshRemote(), true)}
        >
          Check remote connection
        </button>
        {controller.remote && !controller.remote.available && (
          <p>
            Remote access is disabled in this build. Local templates remain
            available.
          </p>
        )}
        {controller.remote?.available &&
          controller.remote.connection?.state !== "paired" && (
            <p>
              Pair this Mac in Connections before sharing a template permission.
            </p>
          )}
        {controller.remote?.connection?.state === "paired" && (
          <>
            <p>
              Device code: <code>{controller.remote.connection.deviceId}</code>
            </p>
            <p>
              Account code: <code>{controller.remote.connection.ownerId}</code>
            </p>
            <fieldset disabled={controller.busy || !controller.saved}>
              <legend>Limits for the selected saved template</legend>
              <label>
                Maximum requests
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={maxRuns}
                  onChange={(e) => {
                    setMaxRuns(Number(e.target.value));
                    controller.resetRemoteReview();
                    render((v) => v + 1);
                  }}
                />
              </label>
              <label>
                Permission duration in minutes
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={minutes}
                  onChange={(e) => {
                    setMinutes(Number(e.target.value));
                    controller.resetRemoteReview();
                    render((v) => v + 1);
                  }}
                />
              </label>
              <button
                onClick={() =>
                  act(
                    async () => controller.reviewRemote(maxRuns, minutes),
                    true,
                  )
                }
              >
                Review remote permission
              </button>
            </fieldset>
          </>
        )}
        {controller.remoteReview && (
          <fieldset disabled={controller.busy}>
            <legend>Confirm this exact saved version</legend>
            <p>
              Template code: <code>{controller.remoteReview.templateId}</code> ·
              Version {controller.remoteReview.expectedRevision}
            </p>
            <p>
              Allow up to {controller.remoteReview.maxRuns} requests until{" "}
              {new Date(controller.remoteReview.expiresAt).toLocaleString()}.
              The prompt and model are shown above. This does not enable
              background receiving.
            </p>
            <label>
              <input
                type="checkbox"
                checked={controller.remoteConfirmed}
                onChange={(e) => controller.confirmRemote(e.target.checked)}
              />{" "}
              I reviewed the exact prompt, model, account, device and limits for
              remote requests.
            </label>
            <button
              disabled={!controller.remoteConfirmed}
              onClick={() => act(() => controller.shareRemote(), true)}
            >
              Allow this template remotely
            </button>
          </fieldset>
        )}
        <ul>
          {controller.remote?.connection?.templates.map((entry) => (
            <li key={entry.permissionId}>
              <p>
                Template code: <code>{entry.templateId}</code> · Version{" "}
                {entry.templateRevision}. Permission{" "}
                {entry.state.replaceAll("_", " ")}; expires{" "}
                {new Date(entry.expiresAt).toLocaleString()}; maximum{" "}
                {entry.maxRuns} requests.
              </p>
              <p>
                Background receiving:{" "}
                {entry.backgroundReceiving ? "enabled" : "off"}.
              </p>
              {(entry.state === "active" || entry.backgroundReceiving) && (
                <button
                  disabled={controller.busy}
                  onClick={() =>
                    controller.reviewRemoteAction(
                      entry.permissionId,
                      entry.backgroundReceiving
                        ? "stop-receiving"
                        : "start-receiving",
                    )
                  }
                >
                  {entry.backgroundReceiving
                    ? "Review stopping background receiving"
                    : "Review background receiving"}
                </button>
              )}
              {entry.pendingDelivery && (
                <p>
                  A saved command needs acknowledgement recovery. Check requests
                  to resume it while permission is valid.
                </p>
              )}
              {entry.state === "publication_pending" && (
                <button
                  disabled={controller.busy}
                  onClick={() =>
                    controller.reviewRemoteAction(entry.permissionId, "retry")
                  }
                >
                  Review publication retry
                </button>
              )}{" "}
              {entry.state === "active" && (
                <button
                  disabled={controller.busy}
                  onClick={() =>
                    controller.reviewRemoteAction(entry.permissionId, "check")
                  }
                >
                  Check requests
                </button>
              )}{" "}
              <button
                disabled={controller.busy}
                onClick={() =>
                  controller.reviewRemoteAction(entry.permissionId, "revoke")
                }
              >
                Review revocation
              </button>
            </li>
          ))}
        </ul>
        {controller.remoteAction && (
          <fieldset disabled={controller.busy}>
            <legend>
              {controller.remoteAction.action === "check"
                ? "Receive approved template requests"
                : controller.remoteAction.action === "revoke"
                  ? "Revoke template permission"
                  : controller.remoteAction.action === "start-receiving"
                    ? "Enable background template receiving"
                    : controller.remoteAction.action === "stop-receiving"
                      ? "Stop background template receiving"
                      : "Retry the saved publication"}
            </legend>
            <p>
              Permission code:{" "}
              <code>{controller.remoteAction.permissionId}</code>.{" "}
              {controller.remoteAction.action === "revoke"
                ? "This cancels unfinished dependent tasks locally before contacting the service. If the service cannot confirm, refresh the connection and retry withdrawal."
                : controller.remoteAction.action === "check"
                  ? "This pass can create tasks from the approved saved template. It does not enable recurring checks."
                  : controller.remoteAction.action === "start-receiving"
                    ? "Allow recurring checks that can create tasks from this exact approved template while the companion runs. This preference resumes on restart, within the existing permission expiry and run limit. It does not extend permission."
                    : controller.remoteAction.action === "stop-receiving"
                      ? "Stop and drain delivery for this permission before saving the preference. Existing tasks continue. Revoke permission to cancel unfinished dependent work."
                      : "Use the original permission and deadline. If local consent is no longer valid, revoke this permission and review a new one."}
            </p>
            <button
              onClick={() =>
                act(() => controller.applyRemoteAction(true), true)
              }
            >
              Confirm this action
            </button>{" "}
            <button
              onClick={() => {
                controller.resetRemoteReview();
                render((v) => v + 1);
              }}
            >
              Dismiss
            </button>
          </fieldset>
        )}
        {controller.remote?.templateReceiver && (
          <p role="status">
            Template receiver: {controller.remote.templateReceiver.state}.
            {controller.remote.templateReceiver.lastCheckedAt
              ? ` Last checked ${new Date(controller.remote.templateReceiver.lastCheckedAt).toLocaleString()}.`
              : ""}
            {controller.remote.templateReceiver.nextCheckAt
              ? ` Next check ${new Date(controller.remote.templateReceiver.nextCheckAt).toLocaleTimeString()}.`
              : ""}
            {controller.remote.templateReceiver.state === "attention"
              ? " Review the connection and permission before enabling receiving again."
              : ""}{" "}
            Use Check remote connection to refresh this status.
          </p>
        )}
        <p role="status">{controller.notice}</p>
      </section>
      <p role="status">
        {controller.busy
          ? "Working…"
          : "Prompt previews clear when this window loses focus. Saved templates stay until you delete them and are included in your data export."}
      </p>
    </section>
  );
}
