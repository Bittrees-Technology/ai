import { BrowserRelayControls } from "./browser-relay-state.js";
import type { BrowserDeviceContext } from "../../modules/remote/browser-device-client.js";
import type { PrivateRelayGrant } from "../../modules/remote/private-relay-enrollment.js";
type Device = {
  id: string;
  epoch: number;
  expiresAt: number;
  revoked: boolean;
};
/** Explicit permission controls, separate from recovery/key custody and task consent. */
export function mountBrowserRelay(
  root: HTMLElement,
  context: () => BrowserDeviceContext | null,
  devices: () => Device[],
  transport: typeof fetch = (...args) => globalThis.fetch(...args),
) {
  let disposed = false,
    rendered = "";
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  };
  const button = (label: string, action: () => void, disabled = false) => {
    const node = el("button", label);
    node.type = "button";
    node.disabled = disabled;
    node.onclick = action;
    return node;
  };
  const controls = new BrowserRelayControls(context, render, transport);
  const when = (time: number) => new Date(time).toLocaleString();
  const grantDetails = (grant: PrivateRelayGrant) => {
    const section = el("div");
    section.className = "relay-permission";
    section.append(
      el(
        "p",
        `${grant.endpointKind === "mac" ? "Mac" : "Browser"} ${grant.endpointId}`,
      ),
      el(
        "p",
        `Permission ${grant.id} · ${grant.state}${grant.expiresAt <= Date.now() ? " · expired" : ""}. Credential version ${grant.credentialEpoch}. Ends ${when(grant.expiresAt)}.`,
      ),
    );
    if (grant.state === "pending") {
      const expired = grant.approvalExpiresAt! <= Date.now();
      const label = el(
          "label",
          expired
            ? "Expired Mac approval ID"
            : "Approval ID to enter on this Mac",
        ),
        input = el("input");
      input.readOnly = true;
      input.value = grant.id;
      input.autocomplete = "off";
      input.spellcheck = false;
      label.append(input);
      section.append(
        label,
        el(
          "p",
          expired
            ? "This approval deadline passed. Review a replacement before accepting on the Mac."
            : `Open Connections in that Mac's companion and review this ID before ${when(grant.approvalExpiresAt!)}. This browser cannot accept for the Mac.`,
        ),
      );
    }
    return section;
  };
  function stamp(s: ReturnType<BrowserRelayControls["snapshot"]>) {
    return JSON.stringify([
      context(),
      devices(),
      s,
      s.result?.approvalExpiresAt
        ? s.result.approvalExpiresAt <= Date.now()
        : null,
    ]);
  }
  function sync() {
    const s = controls.snapshot();
    if (stamp(s) !== rendered) render();
  }
  function render() {
    if (disposed) return;
    const s = controls.snapshot();
    root.hidden = !context();
    rendered = stamp(s);
    root.replaceChildren();
    if (root.hidden) return;
    const title = el("h2", "Private message connections");
    const intro = el(
      "p",
      "Review separate connection permissions for this browser and your Mac. A permission lasts up to one hour, limited by the device's current access. Encryption keys, device trust and task permissions still need their own setup. Automatic message delivery is not enabled.",
    );
    const notice = el("p", s.notice),
      error = el("p", s.error);
    notice.setAttribute("role", "status");
    error.setAttribute("role", "alert");
    const actions = el("div");
    actions.className = "actions";
    const locked = s.busy || !!s.uncertain;
    actions.append(
      button(
        "Review this browser connection",
        () => void controls.reviewBrowser(),
        locked,
      ),
      button("Load permission history", () => void controls.load(), s.busy),
    );
    root.append(title, intro, notice, error, actions);
    if (s.uncertain) {
      const uncertain = el("div");
      uncertain.className = "relay-review";
      uncertain.append(
        el("h3", "Check the original request"),
        el(
          "p",
          `Operation ${s.uncertain.operationId}. Closing this page may lose this reference; permission history remains available.`,
        ),
        button(
          "Check request result",
          () => void controls.checkUncertain(),
          s.busy,
        ),
      );
      const label = el(
        "label",
        "I understand the original request may have completed. Clear this local reference so I can review the current permission again.",
      );
      const acknowledged = el("input");
      acknowledged.type = "checkbox";
      acknowledged.disabled = s.busy;
      label.prepend(acknowledged);
      const forget = button(
        "Clear local request reference",
        () => controls.forgetUncertain(acknowledged.checked),
        true,
      );
      acknowledged.onchange = () => {
        forget.disabled = s.busy || !acknowledged.checked;
      };
      uncertain.append(label, forget);
      root.append(uncertain);
    }
    const macs = devices().filter(
      (d) => !d.revoked && d.expiresAt > Date.now(),
    );
    root.append(el("h3", "Choose a paired Mac"));
    if (!macs.length)
      root.append(
        el(
          "p",
          "Use Load devices above to show your current paired Macs. Pairing and private connection approval are separate steps.",
        ),
      );
    const list = el("ul");
    for (const mac of macs) {
      const li = el("li");
      li.append(
        el("p", `Mac ${mac.id} · credential version ${mac.epoch}`),
        button(
          "Review this Mac connection",
          () => void controls.reviewMac(mac.id, mac.epoch),
          locked,
        ),
      );
      list.append(li);
    }
    root.append(list);
    if (s.review) {
      const r = s.review,
        stage = el("section");
      stage.className = "relay-review";
      stage.setAttribute("aria-label", "Review private connection");
      stage.append(
        el(
          "h3",
          r.action === "revoke"
            ? "Revoke this permission"
            : r.current
              ? "Replace this connection permission"
              : "Approve this connection",
        ),
        el("p", `Account ${r.ownerId}`),
        el(
          "p",
          `${r.action === "browser" ? "Browser" : r.action === "mac" ? "Mac" : r.current!.endpointKind} ${r.endpointId}. Credential version ${r.credentialEpoch}.`,
        ),
      );
      if (r.current) stage.append(grantDetails(r.current));
      stage.append(
        el(
          "p",
          r.action === "revoke"
            ? "This stops use of this remote permission. It does not delete encrypted message history or native saved credentials."
            : `New permission ends ${when(r.expiresAt)}.${r.current ? " Confirming revokes the previous permission." : ""}${r.action === "mac" ? " Accept separately on this Mac within two minutes after approval." : " This applies only to the reviewed browser registration."}`,
        ),
        el("p", `Review expires ${when(r.reviewUntil)}.`),
      );
      const label = el(
          "label",
          "I checked the account, device and permission change.",
        ),
        checkbox = el("input");
      checkbox.type = "checkbox";
      checkbox.disabled = s.busy;
      label.prepend(checkbox);
      const confirm = button(
        r.action === "revoke"
          ? "Confirm revoke permission"
          : "Confirm connection approval",
        () => void controls.confirm(r.id, checkbox.checked),
        true,
      );
      checkbox.onchange = () => {
        confirm.disabled = !checkbox.checked || s.busy;
      };
      stage.append(
        label,
        confirm,
        button("Cancel connection review", () => controls.hide()),
      );
      root.append(stage);
    }
    if (s.result) {
      const result = el("section");
      result.setAttribute("aria-label", "Connection result");
      result.append(
        el("h3", "Current permission result"),
        grantDetails(s.result),
      );
      root.append(result);
    }
    if (s.items.length) {
      const history = el("section");
      history.setAttribute("aria-label", "Permission history");
      history.append(el("h3", "Saved permissions"));
      for (const grant of s.items) {
        const item = grantDetails(grant);
        if (grant.state !== "revoked")
          item.append(
            button(
              "Review revoke permission",
              () => void controls.reviewRevoke(grant.id),
              locked,
            ),
          );
        history.append(item);
      }
      if (s.cursor)
        history.append(
          button(
            "Next permission page",
            () => void controls.load(s.cursor),
            s.busy,
          ),
        );
      root.append(history);
    }
  }
  const hide = () => controls.hide(),
    escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
  window.addEventListener("blur", hide);
  document.addEventListener("visibilitychange", hide);
  document.addEventListener("keydown", escape);
  const expiry = setInterval(() => {
    controls.sync();
    controls.expireReview();
    sync();
  }, 1000);
  render();
  return {
    sync,
    destroy() {
      disposed = true;
      clearInterval(expiry);
      controls.hide();
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", hide);
      document.removeEventListener("keydown", escape);
      root.replaceChildren();
      root.hidden = true;
    },
  };
}
