import { RemoteWebController } from "/controller.js";
const el = (id) => document.getElementById(id);
let accountId = null;
async function api(path, body) {
  const r = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json", "X-Bittrees-Request": "1" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error);
  return data;
}
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
  const controller = new RemoteWebController(
    api,
    window.ethereum,
    settings,
    render,
  );
  function render(s) {
    accountId = s.account?.ownerId ?? null;
    el("error").textContent = s.error;
    el("notice").textContent = s.notice;
    el("account").textContent = s.account
      ? `Verified wallet: ${s.account.address}. Session expires ${new Date(s.account.expiresAt).toLocaleString()}.`
      : "Not signed in.";
    el("login").hidden = !!s.account;
    el("logout").hidden = !s.account;
    el("pairing").hidden = !s.account;
    el("management").hidden = !s.account;
    el("confirmation-area").hidden = !s.confirmation;
    el("confirmation").value = s.confirmation;
    document.querySelectorAll("button").forEach((b) => (b.disabled = s.busy));
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
      el("statuses").append(li);
    }
    if (s.deviceId && !s.statuses.length) {
      const li = document.createElement("li");
      li.textContent = "No unexpired statuses are available for this device.";
      el("statuses").append(li);
    }
    el("statuses-more").hidden = !s.statusCursor;
  }
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
  render(controller.state);
  void controller.refresh();
}
