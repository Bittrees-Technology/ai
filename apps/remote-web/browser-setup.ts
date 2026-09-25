import { mountBrowserResumes } from "./browser-resumes.js";
import { mountBrowserConversationContent } from "./browser-conversation-content.js";
import { mountBrowserConversations } from "./browser-conversations.js";
import { mountBrowserTasks } from "./browser-tasks.js";
import type { z } from "zod";
import type { BrowserKeyHost } from "../../modules/remote/browser-key-host.js";
import type {
  browserDeviceInspectionSchema,
  browserRegistrationSchema,
} from "../../modules/remote/browser-device-contracts.js";
import { mountBrowserKeys } from "./browser-keys.js";
import { mountBrowserPeers } from "./browser-peers.js";
import { mountBrowserPermissions } from "./browser-permissions.js";
import { mountBrowserChecks } from "./browser-checks.js";
type Inspection = z.infer<typeof browserDeviceInspectionSchema>;
type Registration = z.infer<typeof browserRegistrationSchema>;
type Review = {
  action: "register" | "revoke";
  target: Registration | null;
  operationId: string;
  scope: string;
  started: number;
  mono: number;
  expires: number;
};
/** Explicit setup UI over a host bound to one trusted signed-in session.
 * This entry point is exported for the remote host; it does not auto-mount. */
export function mountBrowserSetup(
  root: HTMLElement,
  host: BrowserKeyHost,
  now = Date.now,
  monotonic = () => performance.now(),
  privateDelivery = false,
) {
  let resumeView: ReturnType<typeof mountBrowserResumes> | undefined;
  let contentView:
    ReturnType<typeof mountBrowserConversationContent> | undefined;
  let disposed = false,
    generation = 0,
    busy = false,
    loaded: string | null = null,
    inspection: Inspection | null = null,
    items: Registration[] = [],
    cursor: string | null = null,
    review: Review | null = null;
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text = "",
    className = "",
  ) => {
    const node = document.createElement(tag);
    node.textContent = text;
    node.className = className;
    return node;
  };
  const button = (text: string, action: () => void) => {
    const node = el("button", text);
    node.type = "button";
    node.onclick = action;
    return node;
  };
  const box = el("section", "", "browser-keys browser-registration");
  box.setAttribute("aria-label", "Browser registration");
  const title = el("h2", "Register this browser"),
    intro = el(
      "p",
      "Registration identifies this browser to your account. Key setup comes next; connecting another device and allowing private tasks are separate choices.",
    ),
    current = el("p", "", "browser-keys-reference"),
    notice = el(
      "p",
      "Refresh registration to review this browser.",
      "browser-keys-notice",
    ),
    error = el("p", "", "browser-keys-error"),
    actions = el("div", "", "browser-keys-actions"),
    refresh = button("Refresh registration", () => void load()),
    start = button("Review registration", () =>
      openReview("register", inspection?.registration ?? null),
    ),
    columns = el("div", "", "browser-keys-columns"),
    history = el("div"),
    list = el("ul"),
    more = button("Show next registrations", () => void load(true)),
    stage = el("div", "", "browser-keys-stage"),
    idle = el(
      "p",
      "Review the current browser before creating or replacing its registration.",
    ),
    reviewBox = el("div"),
    heading = el("h3"),
    details = el("p"),
    target = el("p", "", "browser-keys-reference"),
    label = el("label", "", "browser-keys-check"),
    acknowledge = el("input"),
    ackText = el("span"),
    confirm = button("Confirm registration", () => void submit()),
    cancel = button("Cancel registration review", () =>
      reset("Review closed."),
    );
  acknowledge.type = "checkbox";
  acknowledge.onchange = controls;
  label.append(acknowledge, ackText);
  notice.setAttribute("role", "status");
  error.setAttribute("role", "alert");
  heading.tabIndex = -1;
  history.append(el("h3", "Registered browsers"), list, more);
  reviewBox.append(heading, details, target, label, confirm, cancel);
  stage.append(idle, reviewBox);
  columns.append(history, stage);
  actions.append(refresh, start);
  box.append(title, intro, current, actions, notice, error, columns);
  root.append(box);
  const keyRoot = el("div");
  root.append(keyRoot);
  const keyView = mountBrowserKeys(
    keyRoot,
    host.keyAPI,
    () => host.keyContext(),
    now,
  );
  const peerRoot = el("div");
  root.append(peerRoot);
  const peerView = mountBrowserPeers(peerRoot, host, now, monotonic, () => {
    // One host owns all three views. A peer action closes the other reviews
    // synchronously, before it captures the host cancellation version.
    reset("Registration review closed while reviewing device identities.");
    keyView.invalidate();
    conversationView.invalidate();
    contentView?.invalidate();
    resumeView?.invalidate();
  });
  const checkRoot = el("div");
  root.append(checkRoot);
  const checkView = mountBrowserChecks(checkRoot, host, now, monotonic, () => {
    reset("Registration review closed while reviewing device checks.");
    keyView.invalidate();
    peerView.invalidate();
    conversationView.invalidate();
    contentView?.invalidate();
    resumeView?.invalidate();
  });
  const permissionRoot = el("div");
  root.append(permissionRoot);
  const permissionView = mountBrowserPermissions(
    permissionRoot,
    host,
    now,
    monotonic,
    () => {
      reset("Registration review closed while reviewing task permission.");
      keyView.invalidate();
      peerView.invalidate();
      checkView.invalidate();
      conversationView.invalidate();
      contentView?.invalidate();
      resumeView?.invalidate();
    },
  );
  const taskRoot = el("div");
  root.append(taskRoot);
  const taskView = mountBrowserTasks(
    taskRoot,
    host,
    now,
    monotonic,
    () => {
      reset("Registration review closed while reviewing a task.");
      keyView.invalidate();
      peerView.invalidate();
      checkView.invalidate();
      permissionView.invalidate();
      conversationView.invalidate();
      contentView?.invalidate();
      resumeView?.invalidate();
    },
    privateDelivery,
  );
  const conversationRoot = el("div");
  root.append(conversationRoot);
  const conversationView = mountBrowserConversations(
    conversationRoot,
    host,
    now,
    monotonic,
    () => {
      reset("Registration review closed while reviewing conversation access.");
      keyView.invalidate();
      peerView.invalidate();
      checkView.invalidate();
      permissionView.invalidate();
      taskView.invalidate();
      contentView?.invalidate();
      resumeView?.invalidate();
    },
  );
  const contentRoot = el("div");
  root.append(contentRoot);
  contentView = mountBrowserConversationContent(
    contentRoot,
    host,
    now,
    monotonic,
    () => {
      reset("Registration review closed while reviewing saved conversations.");
      keyView.invalidate();
      peerView.invalidate();
      checkView.invalidate();
      permissionView.invalidate();
      taskView.invalidate();
      conversationView.invalidate();
      resumeView?.invalidate();
    },
  );
  const resumeRoot = el("div");
  root.append(resumeRoot);
  resumeView = mountBrowserResumes(resumeRoot, host, now, monotonic, () => {
    reset("Registration review closed while reviewing task resume permission.");
    keyView.invalidate();
    peerView.invalidate();
    checkView.invalidate();
    permissionView.invalidate();
    taskView.invalidate();
    conversationView.invalidate();
    contentView?.invalidate();
  });
  const stamp = () => {
    const c = host.session();
    return c ? JSON.stringify(c) : null;
  };
  const focused = () =>
    document.visibilityState !== "hidden" && document.hasFocus();
  const alive = (g: number, s: string | null) =>
    !disposed && g === generation && !!s && stamp() === s && focused();
  function valid() {
    if (
      !review ||
      busy ||
      !focused() ||
      review.scope !== loaded ||
      loaded !== stamp()
    )
      return false;
    const n = now(),
      elapsed = monotonic() - review.mono;
    return (
      Number.isSafeInteger(n) &&
      n >= review.started &&
      n < review.expires &&
      Number.isFinite(elapsed) &&
      elapsed >= 0 &&
      elapsed < 120000
    );
  }
  function controls() {
    const ready =
      !!loaded &&
      loaded === stamp() &&
      !!inspection &&
      inspection.sessionExpiresAt > now() &&
      focused() &&
      !busy;
    refresh.disabled = !stamp() || !focused() || busy;
    start.disabled = !ready;
    more.disabled = !ready;
    more.hidden = !cursor;
    for (const b of list.querySelectorAll("button")) b.disabled = !ready;
    idle.hidden = !!review;
    reviewBox.hidden = !review;
    acknowledge.disabled = busy;
    confirm.disabled = !valid() || !acknowledge.checked;
    cancel.disabled = busy;
  }
  function reset(message: string) {
    generation++;
    host.cancelKeys();
    review = null;
    acknowledge.checked = false;
    busy = false;
    notice.textContent = message;
    error.textContent = "";
    controls();
  }
  function clearSnapshot() {
    inspection = null;
    items = [];
    cursor = null;
    loaded = null;
    current.textContent = "";
    list.replaceChildren();
    controls();
  }
  function invalidate() {
    reset("Account or access changed. Refresh registration to continue.");
    clearSnapshot();
    keyView.invalidate();
    peerView.invalidate();
    checkView.invalidate();
    permissionView.invalidate();
    taskView.invalidate();
    conversationView.invalidate();
    contentView?.invalidate();
    resumeView?.invalidate();
  }
  const describe = (row: Registration) =>
    row.revokedAt !== null
      ? "Revoked"
      : row.binding.expiresAt <= now()
        ? "Expired"
        : "Registered";
  function render() {
    const row = inspection?.registration;
    current.textContent = row
      ? `${describe(row)} browser ${row.binding.deviceId}. Account ${inspection!.ownerId}. Registration expires ${new Date(row.binding.expiresAt).toLocaleString()}.`
      : "No registration for this browser and account.";
    list.replaceChildren();
    if (!items.length) list.append(el("li", "No registrations on this page."));
    for (const row of items) {
      const li = el("li"),
        text = el(
          "p",
          `${describe(row)}. Expires ${new Date(row.binding.expiresAt).toLocaleString()}.`,
        ),
        id = el("p", row.binding.deviceId, "browser-keys-reference");
      li.append(
        el(
          "h4",
          row.binding.deviceId === inspection?.registration?.binding.deviceId
            ? "This browser"
            : "Another browser",
        ),
        text,
        id,
      );
      if (row.revokedAt === null)
        li.append(
          button("Review browser revocation", () => openReview("revoke", row)),
        );
      list.append(li);
    }
    controls();
  }
  function failure(e: unknown) {
    const code = e instanceof Error ? e.message : "";
    error.textContent =
      code === "CONFLICT"
        ? "The registration changed. Refresh and review the current browser before another attempt."
        : code === "CAPACITY"
          ? "The account registration limit was reached. No existing registration was replaced automatically."
          : code === "BUSY"
            ? "Another operation is finishing. Refresh before trying again."
            : "The operation was not confirmed. Refresh registration to check the current state; do not assume a failed response means nothing changed.";
  }
  async function load(next = false) {
    if (busy || !focused() || !stamp()) return;
    const after = next ? cursor : null;
    if (next && !after) return;
    reset("Checking registration…");
    const g = generation,
      s = stamp();
    busy = true;
    controls();
    try {
      const view = await host.inspect();
      if (!alive(g, s)) return;
      const page = await host.list(after ? { after } : {});
      if (!alive(g, s)) return;
      inspection = view;
      items = page.items;
      cursor = page.nextCursor;
      loaded = s;
      notice.textContent =
        "Registration checked. Review a change here, or refresh keys below for setup and offline maintenance.";
      keyView.invalidate();
      render();
    } catch (e) {
      if (alive(g, s)) {
        clearSnapshot();
        failure(e);
        keyView.invalidate();
      }
    } finally {
      if (g === generation) {
        busy = false;
        controls();
      }
    }
  }
  function openReview(action: Review["action"], row: Registration | null) {
    if (
      busy ||
      !focused() ||
      !inspection ||
      loaded !== stamp() ||
      inspection.sessionExpiresAt <= now()
    )
      return;
    reset("Review this exact change.");
    keyView.invalidate();
    const n = now();
    review = {
      action,
      target: row ? structuredClone(row) : null,
      operationId: crypto.randomUUID(),
      scope: loaded!,
      started: n,
      mono: monotonic(),
      expires: Math.min(n + 120000, inspection.sessionExpiresAt),
    };
    heading.textContent =
      action === "revoke"
        ? "Revoke browser registration"
        : row
          ? "Replace this browser registration"
          : "Create browser registration";
    details.textContent =
      action === "revoke"
        ? "This browser will no longer pass server identity checks. Its local keys, downloaded backups and saved content are not deleted. An operation already committed cannot be undone."
        : row
          ? "The reviewed registration will be retired and this browser will receive a new identity. Existing key material stays on this browser for export or deletion; it is not automatically adopted by the new registration. Review key reset and setup separately."
          : "This creates a new identity for this browser and account. It does not create encryption keys, pair another device or allow private tasks. The registration expires independently of sign-in.";
    target.textContent = `Account ${inspection.ownerId}.${row ? ` Browser ${row.binding.deviceId}, registration version ${row.binding.credentialEpoch}.` : " No prior registration was found."}`;
    ackText.textContent =
      action === "revoke"
        ? "I understand that this stops registration access without deleting stored copies."
        : "I reviewed this browser and understand that key setup and private access are separate.";
    confirm.textContent =
      action === "revoke"
        ? "Confirm browser revocation"
        : "Confirm registration";
    controls();
    heading.focus();
  }
  async function submit() {
    if (!valid() || !acknowledge.checked) return;
    const selected = review!,
      g = generation,
      s = loaded;
    review = null;
    acknowledge.checked = false;
    keyView.invalidate();
    busy = true;
    controls();
    try {
      if (selected.action === "register") {
        const prior = selected.target?.binding;
        const result = await host.register({
          operationId: selected.operationId,
          expected: prior
            ? {
                deviceId: prior.deviceId,
                credentialEpoch: prior.credentialEpoch,
              }
            : null,
          confirmed: true,
        });
        if (!alive(g, s)) return;
        notice.textContent = `Browser ${result.binding.deviceId} registered until ${new Date(result.binding.expiresAt).toLocaleString()}. Refresh keys below to review setup. Save the recovery code and encrypted backup separately.`;
      } else {
        const b = selected.target!.binding;
        await host.revoke({
          deviceId: b.deviceId,
          credentialEpoch: b.credentialEpoch,
          confirmed: true,
        });
        if (!alive(g, s)) return;
        notice.textContent =
          "Browser registration revoked. Stored keys, content and exported copies were not deleted.";
      }
      clearSnapshot();
      keyView.invalidate();
    } catch (e) {
      if (alive(g, s)) {
        clearSnapshot();
        failure(e);
        keyView.invalidate();
      }
    } finally {
      if (g === generation) {
        busy = false;
        controls();
      }
    }
  }
  const conceal = () =>
      reset(
        "Registration review closed after leaving this window. Refresh before another change.",
      ),
    visibility = () => {
      if (document.visibilityState === "hidden") conceal();
    },
    focus = () => controls(),
    keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") reset("Review closed.");
    };
  window.addEventListener("blur", conceal);
  window.addEventListener("focus", focus);
  document.addEventListener("visibilitychange", visibility);
  box.addEventListener("keydown", keydown);
  const timer = setInterval(() => {
    if (disposed) return;
    if (loaded && loaded !== stamp()) {
      host.invalidate();
      invalidate();
    } else if (review && !valid() && !busy)
      reset(
        "Review expired or access changed. Refresh registration and review again.",
      );
    controls();
  }, 1000);
  controls();
  return {
    invalidate() {
      host.invalidate();
      invalidate();
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      generation++;
      clearInterval(timer);
      window.removeEventListener("blur", conceal);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
      box.removeEventListener("keydown", keydown);
      resumeView?.destroy();
      resumeRoot.remove();
      contentView?.destroy();
      contentRoot.remove();
      conversationView.destroy();
      conversationRoot.remove();
      taskView.destroy();
      taskRoot.remove();
      permissionView.destroy();
      permissionRoot.remove();
      checkView.destroy();
      checkRoot.remove();
      peerView.destroy();
      peerRoot.remove();
      keyView.destroy();
      host.close();
      keyRoot.remove();
      box.remove();
    },
  };
}
