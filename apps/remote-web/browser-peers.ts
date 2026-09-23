import { z } from "zod";
import type { BrowserKeyHost } from "../../modules/remote/browser-key-host.js";
import type { BrowserKeyProof } from "../../modules/remote/browser-key-lifecycle.js";

type Host = Pick<
  BrowserKeyHost,
  "peerAPI" | "keyAPI" | "session" | "keyContext" | "reviewVersion"
>;
type Status = Awaited<ReturnType<Host["peerAPI"]["status"]>>;
type Keys = Awaited<ReturnType<Host["keyAPI"]["status"]>>;
type Prepared = Awaited<ReturnType<Host["peerAPI"]["prepare"]>>;
type Invitation = Awaited<ReturnType<Host["peerAPI"]["invitation"]>>;
type Action = "incoming" | "outgoing" | "revoke" | "reset" | "clear";
type Deadline = { started: number; mono: number; expires: number };
type Review = {
  action: Action;
  revision: number;
  started: number;
  mono: number;
  expires: number;
  prepared?: Prepared;
  recipient?: string;
  peerId?: string;
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const uuid = z.uuid().regex(/^[a-f0-9-]+$/);

/** Public identity exchange only. Every online operation uses the verified host;
 * displayed history never supplies an identity grant or task permission. */
export function mountBrowserPeers(
  root: HTMLElement,
  host: Host,
  now = Date.now,
  monotonic = () => performance.now(),
  closeOtherReviews: () => void = () => {},
) {
  let disposed = false,
    generation = 0,
    busy = false,
    loaded: string | null = null,
    version = -1,
    status: Status | null = null,
    keys: Keys | null = null,
    review: Review | null = null,
    pending: Deadline | null = null,
    outgoing: { value: Invitation; started: number; mono: number } | null =
      null;
  const urls = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text = "",
    cls = "",
  ) => {
    const node = document.createElement(tag);
    node.textContent = text;
    node.className = cls;
    return node;
  };
  const button = (text: string, fn: () => void) => {
    const node = el("button", text);
    node.type = "button";
    node.onclick = fn;
    return node;
  };
  const field = (text: string, area = false) => {
    const label = el("label", text),
      input = area ? el("textarea") : el("input");
    input.autocomplete = "off";
    input.spellcheck = false;
    label.append(input);
    return { label, input };
  };
  const box = el("section", "", "browser-keys browser-peers");
  box.setAttribute("aria-label", "Browser device identities");
  const notice = el(
      "p",
      "Refresh saved devices to begin.",
      "browser-keys-notice",
    ),
    error = el("p", "", "browser-keys-error"),
    current = el("p", "", "browser-keys-reference"),
    actions = el("div", "", "browser-keys-actions"),
    refresh = button("Refresh saved devices", () => void load()),
    exportButton = button("Export public device history", () =>
      exportHistory(),
    ),
    resetButton = button("Review device list reset", () => openReview("reset")),
    clearButton = button("Review device history deletion", () =>
      openReview("clear"),
    ),
    columns = el("div", "", "browser-keys-columns"),
    history = el("div"),
    list = el("ul"),
    stage = el("div", "", "browser-keys-stage"),
    idle = el("div"),
    recipient = field("Mac device ID"),
    incoming = field("Public invitation from your Mac", true),
    inviteButton = button("Review invitation to Mac", () =>
      openReview("outgoing"),
    ),
    prepareButton = button("Review invitation from Mac", () => void prepare()),
    reviewBox = el("div"),
    heading = el("h3"),
    details = el("p"),
    identity = el("p", "", "browser-keys-reference"),
    fingerprint = el("p", "", "browser-peers-fingerprint"),
    comparison = field("Full fingerprint from your Mac’s display"),
    checkLabel = el("label", "", "browser-keys-check"),
    check = el("input"),
    checkText = el("span"),
    confirm = button("Confirm device review", () => void submit()),
    cancel = button("Cancel device review", () =>
      reset(
        "Review closed. Refresh saved devices before another change.",
        true,
      ),
    ),
    output = el("div", "", "browser-keys-result"),
    outputHeading = el("h3", "Public invitation for your Mac"),
    outputFingerprint = el("p", "", "browser-peers-fingerprint"),
    outputText = field("Public invitation to share", true),
    outputInfo = el("p"),
    copy = button("Select invitation to copy", () => {
      if (!liveOutput()) return;
      outputText.input.focus();
      outputText.input.select();
      notice.textContent =
        "Invitation selected. Copy the complete text and compare its full fingerprint on your Mac.";
    }),
    download = button("Download public invitation", () => {
      if (liveOutput())
        save(
          JSON.stringify(outgoing!.value.invitation, null, 2),
          "bittrees-browser-invitation.json",
        );
    }),
    hide = button("Hide public invitation", () =>
      reset("Invitation hidden. Refresh saved devices to continue.", true),
    );
  notice.setAttribute("role", "status");
  error.setAttribute("role", "alert");
  check.type = "checkbox";
  check.onchange = controls;
  comparison.input.oninput = controls;
  recipient.input.maxLength = 36;
  incoming.input.maxLength = 4096;
  comparison.input.maxLength = 64;
  outputText.input.readOnly = true;
  (incoming.input as HTMLTextAreaElement).rows = 6;
  (outputText.input as HTMLTextAreaElement).rows = 9;
  heading.tabIndex = -1;
  outputHeading.tabIndex = -1;
  checkLabel.append(check, checkText);
  reviewBox.append(
    heading,
    details,
    identity,
    fingerprint,
    comparison.label,
    checkLabel,
    confirm,
    cancel,
  );
  output.append(
    outputHeading,
    outputInfo,
    outputFingerprint,
    outputText.label,
    copy,
    download,
    hide,
  );
  idle.append(
    el("h3", "Exchange public invitations"),
    el(
      "p",
      "Use the device ID shown by your Mac companion. Each invitation expires after five minutes. Recovery codes and encrypted backups do not belong here.",
    ),
    recipient.label,
    inviteButton,
    incoming.label,
    prepareButton,
  );
  history.append(el("h3", "Saved device identities"), list);
  stage.append(idle, reviewBox, output);
  columns.append(history, stage);
  actions.append(refresh, exportButton, resetButton, clearButton);
  box.append(
    el("h2", "Review your Mac’s identity"),
    el(
      "p",
      "Exchange public invitations and compare the full fingerprint on each device. Saving an identity does not yet complete a connection or allow private tasks.",
    ),
    current,
    actions,
    notice,
    error,
    columns,
  );
  root.append(box);

  const scope = () => {
    const c = host.session();
    return c ? JSON.stringify([c, host.keyContext()?.binding ?? null]) : null;
  };
  const focused = () =>
    document.visibilityState !== "hidden" && document.hasFocus();
  const snapshot = () =>
    !!loaded && loaded === scope() && version === host.reviewVersion();
  const alive = (g: number, s: string | null) =>
    !disposed &&
    g === generation &&
    !!s &&
    s === scope() &&
    version === host.reviewVersion() &&
    focused() &&
    (!pending || timed(pending.started, pending.mono, pending.expires));
  const localKey = (): BrowserKeyProof | null => {
    const active = keys?.slots.find((s) => s.state === "active");
    return keys && !keys.locked && active?.publicKey
      ? {
          revision: keys.revision,
          keyId: active.id,
          keyEpoch: active.keyEpoch,
          binding: active.binding,
          publicKey: active.publicKey,
        }
      : null;
  };
  const online = () => {
    const key = localKey(),
      binding = host.keyContext()?.binding;
    return (
      !!key &&
      !!binding &&
      same(key.binding, binding) &&
      binding.expiresAt > now()
    );
  };
  function timed(started: number, mono: number, expires: number) {
    const n = now(),
      elapsed = monotonic() - mono;
    return (
      Number.isSafeInteger(n) &&
      n >= started &&
      n < expires &&
      Number.isFinite(elapsed) &&
      elapsed >= 0 &&
      elapsed < expires - started
    );
  }
  const valid = () =>
    !!review &&
    snapshot() &&
    focused() &&
    !busy &&
    timed(review.started, review.mono, review.expires);
  const liveOutput = () =>
    !!outgoing &&
    snapshot() &&
    focused() &&
    !busy &&
    timed(outgoing.started, outgoing.mono, outgoing.value.invitation.expiresAt);
  function controls() {
    const ready = snapshot() && focused() && !busy && !!status;
    refresh.disabled = !scope() || !focused() || busy;
    exportButton.disabled = !ready;
    clearButton.disabled = !ready || !status?.state;
    resetButton.disabled = !ready || !online();
    inviteButton.disabled = !ready || !online();
    prepareButton.disabled =
      !ready ||
      !online() ||
      !!status?.needsFreshDevice ||
      (!!status?.key && !same(status.key, localKey()));
    recipient.input.disabled = !ready;
    incoming.input.disabled = !ready;
    for (const b of list.querySelectorAll("button")) b.disabled = !ready;
    idle.hidden = !!review || !!outgoing;
    reviewBox.hidden = !review;
    output.hidden = !outgoing;
    comparison.label.hidden = review?.action !== "incoming";
    fingerprint.hidden = review?.action !== "incoming";
    comparison.input.disabled = busy;
    check.disabled = busy;
    confirm.disabled =
      !valid() ||
      !check.checked ||
      (review?.action === "incoming" &&
        comparison.input.value !== review.prepared?.fingerprint);
    cancel.disabled = busy;
    copy.disabled = download.disabled = !liveOutput();
  }
  function clearDownloads() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
  }
  function reset(message: string, forget = false, cancelHost = true) {
    generation++;
    if (cancelHost) {
      closeOtherReviews();
      host.peerAPI.invalidate();
    }
    version = host.reviewVersion();
    busy = false;
    review = null;
    pending = null;
    outgoing = null;
    check.checked = false;
    comparison.input.value = "";
    fingerprint.textContent = identity.textContent = "";
    outputText.input.value = "";
    outputFingerprint.textContent = "";
    incoming.input.value = "";
    recipient.input.value = "";
    clearDownloads();
    if (forget) {
      loaded = null;
      status = null;
      keys = null;
      current.textContent = "";
      list.replaceChildren();
    }
    notice.textContent = message;
    error.textContent = "";
    controls();
  }
  function render() {
    const key = localKey(),
      stored = status?.key;
    const relation = status?.needsFreshDevice
      ? "History deleted. Register a different browser identity and activate its key before resetting this list."
      : stored && !same(stored, key)
        ? "The browser key changed. These identities are unavailable for the current key; review a list reset before saving new invitations."
        : stored
          ? "Saved identities match the locally observed key. Current identity checks, reciprocal device checks and task permission are still required."
          : "No device identities saved yet.";
    current.textContent = `Saved list version ${status?.revision ?? 0}. ${relation} ${online() ? "" : "For new invitations, refresh registration and finish browser key setup first."}`;
    list.replaceChildren();
    if (!status?.state?.peers.length)
      list.append(el("li", "No saved devices in this list."));
    for (const p of status?.state?.peers ?? []) {
      const row = el("li");
      row.append(
        el("h4", p.revoked ? "Revoked on this browser" : "Reviewed identity"),
        el(
          "p",
          `Device ${p.peerId}. Key version ${p.keyEpoch}.`,
          "browser-keys-reference",
        ),
        el("p", p.fingerprint, "browser-peers-fingerprint"),
      );
      if (!p.revoked)
        row.append(
          button("Review local device revocation", () =>
            openReview("revoke", p.peerId),
          ),
        );
      list.append(row);
    }
    controls();
  }
  function failure(e: unknown) {
    const code = e instanceof Error ? e.message : "";
    const messages: Record<string, string> = {
      CAPACITY:
        "The saved-device or retired-key limit was reached. No older history was removed automatically.",
      REPAIR_REQUIRED:
        "This list needs an explicit reset with an eligible browser identity and active key.",
      CONFLICT: "The key or device list changed during this review.",
      DENIED:
        "The invitation or access could not be verified. Check the account, intended device, expiry and registration.",
      BUSY: "Another operation is still finishing.",
    };
    error.textContent = `${messages[code] ?? "The operation was not confirmed."} Refresh saved devices to see the current list version before a new review. A failed response can follow a saved change; this review cannot be retried.`;
  }
  async function load() {
    if (busy || !focused() || !scope()) return;
    reset("Reading public device history…", true);
    const g = generation,
      s = scope();
    busy = true;
    pending = { started: now(), mono: monotonic(), expires: now() + 120000 };
    controls();
    try {
      const k = await host.keyAPI.status();
      if (!alive(g, s)) return;
      const p = await host.peerAPI.status();
      if (!alive(g, s)) return;
      keys = k;
      status = p;
      loaded = s;
      notice.textContent = `Public device history loaded. Saved list version ${p.revision}.`;
      render();
    } catch (e) {
      if (alive(g, s)) failure(e);
    } finally {
      if (g === generation) {
        if (!alive(g, s))
          reset(
            "Response expired or access changed. Refresh saved devices to inspect the current list.",
            true,
            false,
          );
        else {
          busy = false;
          pending = null;
          controls();
        }
      }
    }
  }
  function begin(action: Action, extra: Partial<Review> = {}) {
    const n = now();
    review = {
      action,
      revision: status!.revision,
      started: n,
      mono: monotonic(),
      expires: n + 120000,
      ...extra,
    };
    check.checked = false;
    comparison.input.value = "";
    const descriptions = {
      incoming: [
        "Compare the Mac fingerprint",
        "Read the full fingerprint from the Mac that created this invitation. Enter it independently below; do not copy the fingerprint displayed on this page.",
        "I compared the full fingerprint on my Mac and reviewed this device.",
        "Save reviewed Mac identity",
      ],
      outgoing: [
        "Create a public invitation",
        "Share this invitation only with the Mac identified below. It contains a public key, not a recovery code. Review it and compare its fingerprint on your Mac.",
        "I checked the intended Mac device ID.",
        "Create public invitation",
      ],
      revoke: [
        "Revoke this device locally",
        "This removes trust on this browser only. It does not revoke the Mac remotely, delete exported copies or undo already completed work.",
        "I understand this revocation applies only to this browser.",
        "Confirm local device revocation",
      ],
      reset: [
        "Reset the saved device list",
        "This clears active identities and retires their public keys. Old keys cannot be approved again. New invitations must be reviewed with the current browser key. After history deletion, a different verified browser registration is required.",
        "I understand that every device will need a new invitation and review.",
        "Confirm device list reset",
      ],
      clear: [
        "Delete public device history",
        "This deletes the saved identities and retired-key history from this browser. A small hashed device marker remains to prevent reuse of this registration. Register a different browser identity and activate a key before resetting the list. Exported copies and the Mac are unchanged.",
        "I understand that this browser will need a new registration and key setup.",
        "Confirm device history deletion",
      ],
    };
    const text = descriptions[action];
    heading.textContent = text[0]!;
    details.textContent = text[1]!;
    checkText.textContent = text[2]!;
    confirm.textContent = text[3]!;
    const p = review.prepared,
      b = localKey()?.binding;
    identity.textContent = p
      ? `Account ${p.invitation.ownerId}. Intended browser ${p.invitation.recipientId}. Mac ${p.invitation.peerId}. Key version ${p.invitation.keyEpoch}. List version ${p.expectedRevision}. ${p.replaces ? `Replaces key version ${p.replaces.keyEpoch}, fingerprint ${p.replaces.fingerprint}.` : "No saved key for this Mac will be replaced."}`
      : `Account ${host.session()?.ownerId}. ${action === "outgoing" ? `Browser ${b?.deviceId}. Intended Mac ${review.recipient}.` : `${review.peerId ? `Device ${review.peerId}.` : "All saved devices."} List version ${review.revision}.`}`;
    fingerprint.textContent = p
      ? `Invitation fingerprint: ${p.fingerprint}`
      : "";
    notice.textContent =
      "Review this exact change. Leaving this window closes the review.";
    controls();
    heading.focus();
  }
  function openReview(action: Exclude<Action, "incoming">, peerId?: string) {
    if (!snapshot() || busy || !focused() || !status) return;
    const id = recipient.input.value.trim();
    if ((action === "outgoing" || action === "reset") && !online()) return;
    if (
      action === "outgoing" &&
      (!uuid.safeParse(id).success || id === localKey()?.binding.deviceId)
    ) {
      error.textContent =
        "Enter the distinct Mac device ID shown by the companion.";
      return;
    }
    if (
      action === "revoke" &&
      !status.state?.peers.some((p) => p.peerId === peerId && !p.revoked)
    )
      return;
    if (action === "clear" && !status.state) return;
    reset("Reviewing device change…");
    begin(action, {
      recipient: action === "outgoing" ? id : undefined,
      peerId,
    });
  }
  async function prepare() {
    if (prepareButton.disabled || !snapshot() || !status) return;
    const raw = incoming.input.value;
    reset("Checking the public invitation…");
    const g = generation,
      s = loaded;
    busy = true;
    pending = { started: now(), mono: monotonic(), expires: now() + 120000 };
    controls();
    try {
      if (raw.length > 4096) throw Error("DENIED");
      const p = await host.peerAPI.prepare(JSON.parse(raw));
      if (!alive(g, s)) return;
      if (p.expectedRevision !== status!.revision) throw Error("CONFLICT");
      busy = false;
      pending = null;
      begin("incoming", {
        prepared: p,
        expires: Math.min(p.expiresAt, now() + 120000),
      });
    } catch (e) {
      if (alive(g, s)) {
        reset(
          "Invitation review closed. Refresh saved devices to continue.",
          true,
        );
        failure(e);
      }
    } finally {
      if (g === generation) {
        if (!alive(g, s))
          reset(
            "Response expired or access changed. Refresh saved devices to inspect the current list.",
            true,
            false,
          );
        else {
          busy = false;
          pending = null;
          controls();
        }
      }
    }
  }
  async function submit() {
    if (!valid() || confirm.disabled || !check.checked) return;
    const r = review!,
      compared = comparison.input.value,
      g = generation,
      s = loaded;
    if (r.action === "incoming" && compared !== r.prepared?.fingerprint) return;
    review = null;
    check.checked = false;
    comparison.input.value = "";
    busy = true;
    pending = { started: r.started, mono: r.mono, expires: r.expires };
    controls();
    try {
      const observed = await host.keyAPI.status();
      if (!alive(g, s)) return;
      if (!same(observed, keys) || !timed(r.started, r.mono, r.expires))
        throw Error("CONFLICT");
      const input = { expectedRevision: r.revision, confirmed: true };
      if (r.action === "outgoing") {
        const started = now(),
          mono = monotonic();
        const value = await host.peerAPI.invitation({
          recipientId: r.recipient,
          confirmed: true,
        });
        if (!alive(g, s)) return;
        outgoing = { value, started, mono };
        if (!liveTimeOutput()) throw Error("DENIED");
        outputText.input.value = JSON.stringify(value.invitation, null, 2);
        outputFingerprint.textContent = `Full fingerprint: ${value.fingerprint}`;
        outputInfo.textContent = `Intended Mac ${value.invitation.recipientId}. Expires ${new Date(value.invitation.expiresAt).toLocaleString()}. Creating this invitation has not saved a Mac identity or allowed tasks.`;
        notice.textContent =
          "Public invitation created. Compare the full fingerprint on your Mac.";
        controls();
        outputHeading.focus();
      } else {
        const result =
          r.action === "incoming"
            ? await host.peerAPI.approve({
                ...input,
                reviewId: r.prepared!.reviewId,
                comparedFingerprint: compared,
              })
            : r.action === "revoke"
              ? await host.peerAPI.revoke({ ...input, peerId: r.peerId })
              : r.action === "reset"
                ? await host.peerAPI.reset(input)
                : await host.peerAPI.clear(input);
        if (!alive(g, s)) return;
        const message =
          r.action === "incoming"
            ? "Mac identity saved. Reciprocal device checks and task permission remain separate."
            : r.action === "revoke"
              ? "Device revoked on this browser only. Remote revocation was not confirmed."
              : r.action === "reset"
                ? "Device list reset. Retired public keys remain blocked."
                : "Public device history deleted. A hashed device marker remains; a different registration is required.";
        reset(
          `${message} Saved list version ${result.revision}. Refresh saved devices to inspect the result.`,
          true,
        );
      }
    } catch (e) {
      if (alive(g, s)) {
        reset(
          "Response not confirmed. Refresh saved devices before another review.",
          true,
        );
        failure(e);
      }
    } finally {
      if (g === generation) {
        if (!alive(g, s))
          reset(
            "Response expired or access changed. Refresh saved devices to inspect the current list.",
            true,
            false,
          );
        else {
          busy = false;
          pending = null;
          controls();
        }
      }
    }
  }
  function liveTimeOutput() {
    return (
      !!outgoing &&
      timed(
        outgoing.started,
        outgoing.mono,
        outgoing.value.invitation.expiresAt,
      )
    );
  }
  function save(text: string, name: string) {
    const url = URL.createObjectURL(
      new Blob([text + "\n"], { type: "application/json" }),
    );
    urls.add(url);
    const a = el("a");
    a.href = url;
    a.download = name;
    box.append(a);
    a.click();
    a.remove();
    const timer = setTimeout(() => {
      URL.revokeObjectURL(url);
      urls.delete(url);
      timers.delete(timer);
    }, 30000);
    timers.add(timer);
  }
  function exportHistory() {
    if (!snapshot() || !focused() || busy || !status) return;
    // Only the typed public snapshot is serialized. This is not a restore/consent artifact.
    save(
      JSON.stringify(
        {
          format: "bittrees-browser-public-peers-v1",
          exportedAt: now(),
          history: status,
        },
        null,
        2,
      ),
      "bittrees-public-device-history.json",
    );
    notice.textContent =
      "Public device history exported. This file contains no private keys and does not restore trust or task permission.";
  }
  const blur = () =>
      reset(
        "Device review closed after leaving this window. Refresh saved devices to continue.",
        true,
      ),
    visibility = () => {
      if (document.visibilityState === "hidden") blur();
    },
    focus = () => controls(),
    keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape")
        reset("Device review closed. Refresh saved devices to continue.", true);
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
        "Account, registration or key controls changed. Refresh saved devices to continue.",
        true,
        false,
      );
    else if (pending && !timed(pending.started, pending.mono, pending.expires))
      reset(
        "Response timed out. Refresh saved devices to check whether a change was saved.",
        true,
      );
    else if (
      (review && !busy && !valid()) ||
      (outgoing && !busy && !liveOutput())
    )
      reset(
        "Invitation or review expired. Refresh saved devices and start again.",
        true,
      );
    controls();
  }, 500);
  controls();
  return {
    invalidate() {
      reset("Access changed. Refresh saved devices to continue.", true, false);
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      generation++;
      host.peerAPI.invalidate();
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
