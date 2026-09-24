import "./browser-runtime.ts";
import { mountBrowserRelay } from "./browser-relay.ts";
import { BrowserSessionCoordinator } from "./browser-session.ts";
import { BrowserSetupMount } from "./browser-setup-mount.ts";
import { RemoteWebController, browserApi } from "./controller.js";
const el = (id) => document.getElementById(id);
let accountId = null;
const api = browserApi(fetch, () => accountId);
const settings = await fetch("/settings.json", { cache: "no-store" })
  .then((r) => {
    if (!r.ok) throw Error();
    return r.json();
  })
  .catch(() => null);
if (!settings || settings.origin !== location.origin) {
  el("error").textContent =
    "This page could not verify its connection settings. Reload before signing in.";
  document.querySelectorAll("button").forEach((b) => (b.disabled = true));
} else {
  el("network").textContent = `Wallet network: ${settings.chainId}.`;
  let controller;
  const sessions = new BrowserSessionCoordinator(() =>
    controller?.peerSessionChanged(),
  );
  const setup = new BrowserSetupMount(
    el("browser-recovery"),
    el("browser-setup"),
    el("browser-recovery-open"),
    el("browser-recovery-notice"),
    () => controller?.sessionContext() ?? null,
    settings.privateRelay === true,
  );
  const relay =
    settings.privateRelay === true
      ? mountBrowserRelay(
          el("private-relay-controls"),
          () => controller?.sessionContext() ?? null,
          () => controller?.state.devices ?? [],
        )
      : null;
  controller = new RemoteWebController(
    api,
    window.ethereum,
    settings,
    render,
    sessions,
  );
  function render(s) {
    accountId = s.account?.ownerId ?? null;
    setup.sync();
    relay?.sync();
    el("error").textContent = s.error;
    el("notice").textContent = s.notice;
    el("account").textContent = s.account
      ? `Verified wallet: ${s.account.address}. Session expires ${new Date(s.account.expiresAt).toLocaleString()}.`
      : "Not signed in.";
    el("login").hidden = !!s.account;
    el("logout").hidden = !s.account && !controller.authAction;
    el("pairing").hidden = !s.account;
    el("management").hidden = !s.account;
    el("confirmation-area").hidden = !s.confirmation;
    el("confirmation").value = s.confirmation;
    document
      .querySelectorAll("[data-status-controls] button")
      .forEach((b) => (b.disabled = s.busy));
    // Cancellation must stay available while a wallet or sign-in request waits.
    el("logout").disabled = false;
    el("devices").replaceChildren();
    for (const d of s.devices) {
      const li = document.createElement("li"),
        label = document.createElement("p");
      label.textContent = `Device ${d.id} — ${d.revoked ? "revoked" : d.expiresAt <= Date.now() ? "expired" : "paired"}. Access expires ${new Date(d.expiresAt).toLocaleString()}.`;
      li.append(label);
      if (!d.revoked && d.expiresAt > Date.now()) {
        const show = document.createElement("button");
        show.textContent = "View shared statuses";
        show.disabled = s.busy;
        show.onclick = () => controller.statuses(d.id);
        li.append(show);
        const templates = document.createElement("button");
        templates.textContent = "View approved templates";
        templates.disabled = s.busy;
        templates.onclick = () => controller.templates(d.id);
        li.append(templates);
        const control = document.createElement("button");
        control.textContent = d.controlsEnabled
          ? "Disable pause/cancel"
          : "Approve pause/cancel";
        control.disabled = s.busy;
        control.onclick = () => {
          const confirmed = window.confirm(
            d.controlsEnabled
              ? "Disable remote pause/cancel for this device?"
              : "Allow this account to pause or cancel shared tasks on this Mac? This needs separate confirmation on the Mac within five minutes. It does not allow starting tasks or reading content.",
          );
          void controller.controls(d.id, !d.controlsEnabled, confirmed);
        };
        li.append(control);
        const revoke = document.createElement("button");
        revoke.textContent = "Revoke device";
        revoke.disabled = s.busy;
        revoke.onclick = () => {
          if (
            window.confirm(
              "Revoke this device and remove its stored remote statuses?",
            )
          )
            void controller.revoke(d.id, true);
        };
        li.append(revoke);
      }
      el("devices").append(li);
    }
    el("devices-more").hidden = !s.deviceCursor;
    el("statuses").replaceChildren();
    el("statuses-title").hidden = !s.deviceId;
    for (const task of s.statuses) {
      const li = document.createElement("li");
      li.textContent = `Task ${task.id}: ${task.status.replaceAll("_", " ")}. Updated ${new Date(task.updatedAt).toLocaleString()}.`;
      if (
        s.devices.find((d) => d.id === s.deviceId)?.controlsEnabled &&
        !["completed", "failed", "cancelled", "expired"].includes(task.status)
      ) {
        for (const action of task.status === "paused"
          ? ["cancel"]
          : ["pause", "cancel"]) {
          const button = document.createElement("button");
          button.textContent =
            action === "pause" ? "Review pause" : "Review cancel";
          button.disabled = s.busy;
          button.onclick = () => controller.reviewCommand(task.id, action);
          li.append(button);
        }
      }
      el("statuses").append(li);
    }
    if (s.deviceId && !s.statuses.length) {
      const li = document.createElement("li");
      li.textContent = "No unexpired statuses are available for this device.";
      el("statuses").append(li);
    }
    el("command-review").hidden = !s.commandReview;
    el("command-details").textContent = s.commandReview
      ? `${s.commandReview.command === "pause" ? "Pause" : "Cancel"} task ${s.commandReview.taskId} on device ${s.commandReview.deviceId}, using reviewed revision ${s.commandReview.expectedRevision}. Expires ${new Date(s.commandReview.expiresAt).toLocaleTimeString()}. Cancelled tasks cannot be resumed.`
      : "";
    el("command-result").hidden = !s.commandResult;
    el("command-outcome").textContent = s.commandResult
      ? `Command ${s.commandResult.id}: ${s.commandResult.receipt?.outcome ?? s.commandResult.state}. A pending command has not been confirmed as applied.`
      : "";
    el("statuses-more").hidden = !s.statusCursor;
    el("templates-title").hidden = !s.templateDeviceId;
    el("templates").replaceChildren();
    for (const template of s.templates) {
      const li = document.createElement("li"),
        description = document.createElement("p");
      description.textContent = `Template code ${template.templateId}, version ${template.templateRevision}, on device ${template.deviceId}. ${template.submittedRuns} of ${template.maxRuns} requests submitted; permission expires ${new Date(template.expiresAt).toLocaleString()}.`;
      li.append(description);
      for (const action of ["run", "revoke"]) {
        const button = document.createElement("button");
        button.textContent =
          action === "run" ? "Review run request" : "Review revocation";
        button.disabled =
          s.busy ||
          template.expiresAt <= Date.now() ||
          (action === "run" && template.submittedRuns >= template.maxRuns);
        button.onclick = () =>
          controller.reviewTemplate(template.permissionId, action);
        li.append(button);
      }
      el("templates").append(li);
    }
    if (s.templateDeviceId && !s.templates.length) {
      const li = document.createElement("li");
      li.textContent =
        "No active template permissions are available on this page. Review and share one explicitly on your Mac first.";
      el("templates").append(li);
    }
    el("templates-more").hidden = !s.templateCursor;
    el("template-review").hidden = !s.templateReview;
    const review = s.templateReview;
    el("template-details").textContent = review
      ? `${review.action === "run" ? "Request one run of" : "Revoke permission for"} template ${review.template.templateId}, version ${review.template.templateRevision}, on device ${review.template.deviceId}. Permission allows ${review.template.maxRuns} requests until ${new Date(review.template.expiresAt).toLocaleString()}.${review.intent ? ` This fixed request expires ${new Date(review.intent.command.expiresAt).toLocaleTimeString()}.` : ""} Match this code and version to the prompt reviewed on your Mac. No new text or app permission is supplied here.`
      : "";
    el("template-submit").textContent =
      review?.action === "revoke"
        ? "Confirm revocation"
        : "Confirm this run request";
    el("template-result").hidden = !s.templateResult;
    el("template-outcome").textContent = s.templateResult
      ? `Request ${s.templateResult.id}: ${s.templateResult.receipt?.outcome ?? s.templateResult.state}.${s.templateResult.receipt?.taskId ? ` Local task code: ${s.templateResult.receipt.taskId}.` : ""} A queued receipt confirms task creation only. Check the Mac or its manually shared task status for progress.`
      : "";
  }
  el("templates-more").onclick = () =>
    controller.templates(controller.state.templateDeviceId, true);
  el("template-submit").onclick = () => controller.submitTemplate(true);
  el("template-dismiss").onclick = () =>
    controller.set({ templateReview: null });
  el("template-refresh").onclick = () => controller.templateReceipt();
  el("command-submit").onclick = () => controller.submitCommand(true);
  el("command-dismiss").onclick = () => controller.set({ commandReview: null });
  el("command-refresh").onclick = () => controller.commandReceipt();
  el("login").onclick = () => controller.login();
  el("refresh").onclick = () => controller.refresh();
  el("logout").onclick = () => controller.logout();
  el("pair-form").onsubmit = (e) => {
    e.preventDefault();
    const details = el("details").value,
      confirmed = el("confirm").checked;
    el("details").value = "";
    el("confirm").checked = false;
    void controller.approve(details, confirmed);
  };
  el("devices-load").onclick = () => controller.devices();
  el("devices-more").onclick = () => controller.devices(true);
  el("statuses-more").onclick = () =>
    controller.statuses(controller.state.deviceId, true);
  const hide = () => {
    controller.hide();
    el("details").value = "";
    el("confirm").checked = false;
  };
  window.addEventListener("blur", hide);
  document.addEventListener("visibilitychange", hide);
  const changed = () => {
    hide();
    void controller.walletChanged();
  };
  window.ethereum?.on?.("accountsChanged", changed);
  window.ethereum?.on?.("chainChanged", changed);
  const expiry = setInterval(() => {
    if (controller.state.account && !controller.sessionContext()) {
      controller.invalidateSession();
      controller.set({
        notice:
          "Session access changed or expired. Refresh your session to continue.",
      });
    }
    setup.sync();
    relay?.sync();
  }, 1000);
  window.addEventListener(
    "pagehide",
    () => {
      clearInterval(expiry);
      setup.destroy();
      relay?.destroy();
      sessions.close();
      controller.invalidateSession();
    },
    { once: true },
  );
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) location.reload();
  });
  render(controller.state);
  void controller.refresh();
}
