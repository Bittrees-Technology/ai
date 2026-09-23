import type { BrowserKeyHost } from "../../modules/remote/browser-key-host.js";
type Host = Pick<
  BrowserKeyHost,
  | "consentAPI"
  | "keyAPI"
  | "peerAPI"
  | "checkAPI"
  | "session"
  | "keyContext"
  | "reviewVersion"
>;
type Status = Awaited<ReturnType<Host["consentAPI"]["status"]>>;
type Keys = Awaited<ReturnType<Host["keyAPI"]["status"]>>;
type Peers = Awaited<ReturnType<Host["peerAPI"]["status"]>>;
type Checks = Awaited<ReturnType<Host["checkAPI"]["status"]>>;
type Prepared = Awaited<ReturnType<Host["consentAPI"]["prepare"]>>;
type Snapshot = { keys: Keys; peers: Peers; checks: Checks; status: Status };
type Deadline = { started: number; mono: number; expires: number };
type Review = Deadline & {
  action: "approve" | "revoke" | "clear" | "reset";
  before: Snapshot;
  prepared?: Prepared;
  peerId?: string;
};
/** Explicit saved choices only. No task dispatch or model selection is exposed. */
export function mountBrowserPermissions(
  root: HTMLElement,
  host: Host,
  now = Date.now,
  monotonic = () => performance.now(),
  closeOtherReviews = () => {},
) {
  let disposed = false,
    generation = 0,
    busy = false,
    version = host.reviewVersion();
  let loaded: string | null = null,
    state: Snapshot | null = null,
    review: Review | null = null,
    pending: Deadline | null = null;
  const urls = new Set<string>(),
    timers = new Set<ReturnType<typeof setTimeout>>();
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text = "",
    cls = "",
  ) => {
    const n = document.createElement(tag);
    n.textContent = text;
    n.className = cls;
    return n;
  };
  const button = (text: string, action: () => void) => {
    const n = el("button", text);
    n.type = "button";
    n.onclick = action;
    return n;
  };
  const checkbox = (text: string) => {
    const label = el("label", "", "browser-keys-check"),
      input = el("input");
    input.type = "checkbox";
    label.append(input, el("span", text));
    return { label, input };
  };
  const select = (text: string) => {
    const label = el("label", text),
      input = el("select");
    input.id = `browser-permission-${crypto.randomUUID()}`;
    label.htmlFor = input.id;
    return { label, input };
  };
  const box = el("section", "", "browser-keys browser-permissions");
  box.setAttribute("aria-label", "Browser task permissions");
  const notice = el(
      "p",
      "Refresh permissions to read your saved choices.",
      "browser-keys-notice",
    ),
    error = el("p", "", "browser-keys-error"),
    current = el("p", "", "browser-keys-reference");
  notice.setAttribute("role", "status");
  error.setAttribute("role", "alert");
  const actions = el("div", "", "browser-keys-actions"),
    refresh = button("Refresh permissions", () => void load()),
    exportButton = button("Export permission history", exportHistory),
    clearButton = button("Review permission deletion", () =>
      maintenance("clear"),
    ),
    resetButton = button("Review permission reset", () => maintenance("reset"));
  actions.append(refresh, exportButton, clearButton, resetButton);
  const columns = el("div", "", "browser-keys-columns"),
    history = el("div"),
    list = el("ul"),
    stage = el("div", "", "browser-keys-stage"),
    form = el("div");
  history.append(
    el("h3", "Saved browser choices"),
    el(
      "p",
      "Saved choices do not confirm a current connection. Device changes or expiry can make them unusable.",
    ),
    list,
  );
  const peer = select("Mac for task permission"),
    duration = select("Permission duration"),
    send = checkbox("Allow this browser to send tasks to this Mac"),
    results = checkbox("Allow this browser to read results from this Mac");
  for (const [value, text] of [
    ["1", "1 hour"],
    ["4", "4 hours"],
    ["24", "24 hours"],
  ]) {
    const option = el("option", text);
    option.value = value!;
    duration.input.append(option);
  }
  const start = button("Review task permission", () => void prepare());
  form.append(
    el("h3", "Choose what this browser may do"),
    el(
      "p",
      "Complete this browser’s device check first. Your Mac separately decides whether to accept tasks, which local model to use and whether to share results.",
    ),
    peer.label,
    peer.input,
    send.label,
    results.label,
    duration.label,
    duration.input,
    el(
      "p",
      "Permission ends sooner if this browser’s registration expires. Expiry stops access; it does not delete saved task content.",
    ),
    start,
  );
  const reviewBox = el("div"),
    heading = el("h3"),
    details = el("p"),
    identity = el("p", "", "browser-keys-reference"),
    ack = checkbox("I reviewed this Mac and these exact permission choices."),
    confirm = button("Save browser permission", () => void submit()),
    cancel = button("Cancel permission review", () =>
      reset("Permission review closed.", true),
    );
  heading.tabIndex = -1;
  reviewBox.append(heading, details, identity, ack.label, confirm, cancel);
  stage.append(form, reviewBox);
  columns.append(history, stage);
  box.append(
    el("h2", "Choose task access"),
    el(
      "p",
      "Set separate browser and Mac permissions before exchanging private tasks. Saving a permission does not send a task or grant access to sources, memory, tools or publishing.",
    ),
    current,
    actions,
    notice,
    error,
    columns,
  );
  root.append(box);
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  const scope = () => {
    const s = host.session();
    return s ? JSON.stringify([s, host.keyContext()?.binding ?? null]) : null;
  };
  const focused = () =>
    document.visibilityState !== "hidden" && document.hasFocus();
  const timed = (d: Deadline) => {
    const n = now(),
      elapsed = monotonic() - d.mono;
    return (
      Number.isSafeInteger(n) &&
      n >= d.started &&
      n < d.expires &&
      Number.isFinite(elapsed) &&
      elapsed >= 0 &&
      elapsed < d.expires - d.started
    );
  };
  const deadline = (expires = now() + 120000): Deadline => ({
    started: now(),
    mono: monotonic(),
    expires,
  });
  const snapshot = () =>
    !!loaded && loaded === scope() && version === host.reviewVersion();
  const alive = (g: number, s: string | null) =>
    !disposed &&
    g === generation &&
    !!s &&
    s === scope() &&
    version === host.reviewVersion() &&
    focused() &&
    (!pending || timed(pending));
  const local = () => {
    const k = state?.keys,
      a = k?.slots.find((s) => s.state === "active");
    return k && !k.locked && a?.publicKey
      ? {
          revision: k.revision,
          keyId: a.id,
          keyEpoch: a.keyEpoch,
          binding: a.binding,
          publicKey: a.publicKey,
        }
      : null;
  };
  const online = () => {
    const k = local(),
      b = host.keyContext()?.binding;
    return !!k && !!b && same(k.binding, b) && b.expiresAt > now();
  };
  const paired = () =>
    online() &&
    !!state &&
    !state.peers.needsFreshDevice &&
    !state.status.needsFreshDevice &&
    !state.checks.needsFreshDevice &&
    same(state.peers.key, local());
  function controls() {
    const ready = snapshot() && focused() && !busy && !!state;
    refresh.disabled = !scope() || !focused() || busy;
    exportButton.disabled = !ready;
    clearButton.disabled = !ready || !state?.status.revision;
    resetButton.disabled = !ready || !state?.status.revision || !online();
    peer.input.disabled =
      duration.input.disabled =
      send.input.disabled =
        !ready || !paired();
    results.input.disabled = send.input.disabled || !send.input.checked;
    start.disabled =
      send.input.disabled || !send.input.checked || !peer.input.value;
    for (const b of list.querySelectorAll<HTMLButtonElement>("button"))
      b.disabled = !ready;
    form.hidden = !!review;
    reviewBox.hidden = !review;
    ack.input.disabled = busy;
    confirm.disabled =
      !ready || !review || !timed(review) || !ack.input.checked;
    cancel.disabled = busy;
  }
  send.input.onchange = () => {
    if (!send.input.checked) results.input.checked = false;
    controls();
  };
  results.input.onchange =
    peer.input.onchange =
    duration.input.onchange =
    ack.input.onchange =
      controls;
  function clearDownloads() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    for (const u of urls) URL.revokeObjectURL(u);
    urls.clear();
  }
  function reset(
    message: string,
    forget = false,
    cancelHost = true,
    closeReviews = true,
  ) {
    generation++;
    if (cancelHost) {
      if (closeReviews) closeOtherReviews();
      host.consentAPI.invalidate();
    }
    version = host.reviewVersion();
    busy = false;
    review = null;
    pending = null;
    ack.input.checked = send.input.checked = results.input.checked = false;
    duration.input.value = "1";
    identity.textContent = "";
    clearDownloads();
    if (forget) {
      loaded = null;
      state = null;
      list.replaceChildren();
      peer.input.replaceChildren();
      current.textContent = "";
    }
    notice.textContent = message;
    error.textContent = "";
    controls();
  }
  function render() {
    current.textContent = `Saved permission version ${state!.status.revision}. ${state!.status.needsFreshDevice ? "Permissions deleted. Use a different browser registration and active key before resetting." : "A new permission applies to new tasks; it cannot reopen results tied to an older permission."}`;
    list.replaceChildren();
    peer.input.replaceChildren(el("option", "Choose a reviewed Mac"));
    peer.input.options[0]!.value = "";
    for (const p of state!.peers.state?.peers ?? [])
      if (!p.revoked) {
        const o = el("option", p.peerId);
        o.value = p.peerId;
        peer.input.append(o);
      }
    if (!state!.status.grants.length)
      list.append(
        el(
          "li",
          "No saved permissions. Choose a reviewed Mac and turn on only the access you want.",
        ),
      );
    for (const grant of state!.status.grants) {
      const li = el("li");
      li.append(
        el(
          "h4",
          grant.revoked
            ? "Revoked on this browser"
            : grant.choices.expiresAt <= now()
              ? "Permission expired"
              : "Permission saved",
        ),
        el(
          "p",
          `Mac ${grant.choices.peerId}. Permission ${grant.id}. Version ${grant.revision}.`,
          "browser-keys-reference",
        ),
        el(
          "p",
          `Send tasks: ${grant.choices.sendTasks ? "allowed" : "off"}. Read results: ${grant.choices.receiveResults ? "allowed" : "off"}. Ends ${new Date(grant.choices.expiresAt).toLocaleString()}.`,
        ),
      );
      if (!grant.revoked)
        li.append(
          button("Review revoking permission", () =>
            maintenance("revoke", grant.choices.peerId),
          ),
        );
      list.append(li);
    }
    controls();
  }
  function failure(e: unknown) {
    const messages: Record<string, string> = {
      DENIED: "The device, completed check or access could not be verified.",
      CONFLICT:
        "The saved device, check or permission changed during this review.",
      REPAIR_REQUIRED:
        "A different browser registration and active key are required before resetting permissions.",
      CAPACITY:
        "The permission limit was reached. No choices were removed automatically.",
      BUSY: "Another operation is still finishing.",
      STORAGE_UNAVAILABLE: "Saved permissions are unavailable.",
    };
    error.textContent = `${messages[e instanceof Error ? e.message : ""] ?? "The operation was not confirmed."} Refresh permissions before another review. A failed response can follow a saved change; do not repeat the old approval.`;
  }
  async function read(g: number, s: string | null): Promise<Snapshot | null> {
    const keys = await host.keyAPI.status();
    if (!alive(g, s)) return null;
    const peers = await host.peerAPI.status();
    if (!alive(g, s)) return null;
    const checks = await host.checkAPI.status();
    if (!alive(g, s)) return null;
    const status = await host.consentAPI.status();
    return alive(g, s) ? { keys, peers, checks, status } : null;
  }
  function finish(g: number, s: string | null) {
    if (g !== generation) return;
    if (!alive(g, s))
      reset(
        "Response expired or access changed. Refresh permissions to inspect any saved result.",
        true,
        false,
      );
    else {
      busy = false;
      pending = null;
      controls();
    }
  }
  async function load() {
    if (busy || !focused() || !scope()) return;
    reset("Reading saved permissions…", true);
    const g = generation,
      s = scope();
    busy = true;
    pending = deadline();
    controls();
    try {
      const value = await read(g, s);
      if (!value) return;
      state = value;
      loaded = s;
      notice.textContent =
        "Permission history loaded. Review new choices or maintain saved permissions.";
      render();
    } catch (e) {
      if (alive(g, s)) failure(e);
    } finally {
      finish(g, s);
    }
  }
  async function prepare() {
    if (start.disabled || !state || !snapshot() || !focused() || busy) return;
    const before = structuredClone(state),
      k = local()!,
      selected = state.peers.state?.peers.find(
        (p) => p.peerId === peer.input.value && !p.revoked,
      ),
      hours = Number(duration.input.value);
    if (!selected || ![1, 4, 24].includes(hours)) return;
    const choices = {
      peerId: selected.peerId,
      peerKeyEpoch: selected.keyEpoch,
      sendTasks: send.input.checked,
      receiveResults: results.input.checked,
      expiresAt: Math.min(now() + hours * 3600000, k.binding.expiresAt),
    };
    reset("Checking the selected Mac and permission choices…");
    const g = generation,
      s = loaded;
    busy = true;
    pending = deadline();
    controls();
    try {
      const fresh = await read(g, s);
      if (!fresh) return;
      if (!same(before, fresh)) throw Error("CONFLICT");
      const prepared = await host.consentAPI.prepare({
        expectedRevision: before.status.revision,
        choices,
      });
      if (!alive(g, s)) return;
      const proof = {
        revision: before.peers.revision,
        key: k,
        peerId: selected.peerId,
        keyEpoch: selected.keyEpoch,
        fingerprint: selected.fingerprint,
      };
      if (
        !same(prepared.choices, choices) ||
        !same(prepared.local, k) ||
        !same(prepared.peer, proof)
      )
        throw Error("CONFLICT");
      review = {
        ...pending!,
        expires: Math.min(pending!.expires, prepared.expiresAt),
        action: "approve",
        before,
        prepared,
      };
      heading.textContent = "Review browser task permission";
      details.textContent = `Send tasks: allowed. Read results: ${choices.receiveResults ? "allowed" : "off"}. Ends ${new Date(choices.expiresAt).toLocaleString()}. The Mac must separately approve receiving tasks, its local model and sharing results. Replacing this permission does not reopen older tasks or results.`;
      identity.textContent = `Browser ${k.binding.deviceId}. Mac ${selected.peerId}. Reviewed Mac fingerprint ${selected.fingerprint}.`;
      ack.input.checked = false;
      confirm.textContent = "Save browser permission";
      notice.textContent =
        "Review these exact choices. Leaving this window closes the review.";
      controls();
      heading.focus();
    } catch (e) {
      if (alive(g, s)) {
        reset("Permission review could not be prepared.", true);
        failure(e);
      }
    } finally {
      finish(g, s);
    }
  }
  function maintenance(action: "revoke" | "clear" | "reset", peerId?: string) {
    if (
      !state ||
      !snapshot() ||
      !focused() ||
      busy ||
      !state.status.revision ||
      (action === "reset" && !online())
    )
      return;
    if (
      action === "revoke" &&
      !state.status.grants.some(
        (g) => g.choices.peerId === peerId && !g.revoked,
      )
    )
      return;
    const before = structuredClone(state);
    reset("Review this exact permission change.");
    review = { ...deadline(), action, before, peerId };
    const wording = {
      revoke: [
        "Revoke this browser’s permission",
        "Stop further sending and result reading under this permission. This does not cancel a task already accepted by the Mac or retract copied messages and exports.",
        "Revoke browser permission",
      ],
      clear: [
        "Delete saved browser permissions",
        "Delete saved permission choices and their local encryption key. A minimal locked marker remains; a different browser registration and active key are required before reset. Task history, Mac permissions and exported copies are not deleted.",
        "Delete browser permissions",
      ],
      reset: [
        "Reset permissions for a different browser",
        "Use the current different browser registration and active key. Start with no permissions enabled; review new choices separately.",
        "Reset browser permissions",
      ],
    }[action];
    heading.textContent = wording[0]!;
    details.textContent = wording[1]!;
    confirm.textContent = wording[2]!;
    identity.textContent = `Account ${host.session()?.ownerId}. ${peerId ? `Mac ${peerId}.` : "All saved browser permissions."} Saved version ${before.status.revision}.`;
    ack.input.checked = false;
    controls();
    heading.focus();
  }
  async function submit() {
    if (
      confirm.disabled ||
      !review ||
      !snapshot() ||
      !focused() ||
      !timed(review) ||
      !ack.input.checked
    )
      return;
    const r = review,
      g = generation,
      s = loaded;
    review = null;
    ack.input.checked = false;
    busy = true;
    pending = r;
    controls();
    try {
      const fresh = await read(g, s);
      if (!fresh) return;
      if (!same(fresh, r.before)) throw Error("CONFLICT");
      if (r.action === "approve")
        await host.consentAPI.approve({
          reviewId: r.prepared!.reviewId,
          expectedRevision: r.prepared!.expectedRevision,
          confirmed: true,
          acknowledged: true,
        });
      else if (r.action === "revoke")
        await host.consentAPI.revoke({
          peerId: r.peerId!,
          expectedRevision: r.before.status.revision,
          confirmed: true,
        });
      else
        await host.consentAPI[r.action]({
          expectedRevision: r.before.status.revision,
          confirmed: true,
        });
      if (!alive(g, s)) return;
      reset(
        `${r.action === "approve" ? "Browser permission saved. No task was sent." : r.action === "revoke" ? "Permission revoked on this browser only." : r.action === "clear" ? "Browser permissions deleted. A different registration and active key are required before reset." : "Browser permissions reset. No choices are enabled."} Refresh permissions to inspect the result.`,
        true,
      );
    } catch (e) {
      if (alive(g, s)) {
        reset(
          "Response not confirmed. Refresh permissions to inspect the saved state.",
          true,
        );
        failure(e);
      }
    } finally {
      finish(g, s);
    }
  }
  function exportHistory() {
    if (!state || !snapshot() || !focused() || busy) return;
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              format: "bittrees-browser-task-permissions-v1",
              exportedAt: now(),
              history: state.status,
            },
            null,
            2,
          ) + "\n",
        ],
        { type: "application/json" },
      ),
    );
    urls.add(url);
    const a = el("a");
    a.href = url;
    a.download = "bittrees-browser-permissions.json";
    box.append(a);
    a.click();
    a.remove();
    const timer = setTimeout(() => {
      URL.revokeObjectURL(url);
      urls.delete(url);
      timers.delete(timer);
    }, 30000);
    timers.add(timer);
    notice.textContent =
      "Permission history exported. It contains public device details and saved choices, no private keys or task content. It cannot restore permission.";
  }
  const blur = () =>
      reset(
        "Permission review closed after leaving this window. Refresh permissions to continue.",
        true,
        true,
        false,
      ),
    focus = () => controls(),
    visibility = () => {
      if (document.visibilityState === "hidden") blur();
    },
    keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape")
        reset(
          "Permission review closed. Refresh permissions to continue.",
          true,
        );
    };
  window.addEventListener("blur", blur);
  window.addEventListener("focus", focus);
  document.addEventListener("visibilitychange", visibility);
  box.addEventListener("keydown", keydown);
  const timer = setInterval(() => {
    if (disposed) return;
    if (
      (loaded || busy) &&
      (!scope() ||
        (loaded && loaded !== scope()) ||
        version !== host.reviewVersion())
    )
      reset(
        "Account, registration or device controls changed. Refresh permissions to continue.",
        true,
        false,
      );
    else if (
      (pending && !timed(pending)) ||
      (review && !busy && !timed(review))
    )
      reset(
        "Permission review expired. Refresh permissions to inspect the saved state.",
        true,
      );
    controls();
  }, 500);
  controls();
  return {
    invalidate() {
      reset("Access changed. Refresh permissions to continue.", true, false);
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      generation++;
      host.consentAPI.invalidate();
      clearDownloads();
      clearInterval(timer);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
      box.removeEventListener("keydown", keydown);
      box.remove();
    },
  };
}
