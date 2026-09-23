import type { BrowserKeyHost } from "../../modules/remote/browser-key-host.js";
import {
  privateEnvelopeSchema,
  type PrivateEnvelope,
} from "../../modules/remote/private-envelope.js";

type Host = Pick<
  BrowserKeyHost,
  "checkAPI" | "keyAPI" | "peerAPI" | "session" | "keyContext" | "reviewVersion"
>;
type Status = Awaited<ReturnType<Host["checkAPI"]["status"]>>;
type Keys = Awaited<ReturnType<Host["keyAPI"]["status"]>>;
type Peers = Awaited<ReturnType<Host["peerAPI"]["status"]>>;
type Action =
  "begin" | "respond" | "complete" | "resume" | "stop" | "clear" | "reset";
type Deadline = { started: number; mono: number; expires: number };
type Review = Deadline & {
  action: Action;
  peerId?: string;
  row?: Status["checks"][number];
  envelope?: PrivateEnvelope;
};
/** Manual encrypted device checks. This view never grants task permission. */
export function mountBrowserChecks(
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
    status: Status | null = null,
    keys: Keys | null = null,
    peers: Peers | null = null;
  let review: Review | null = null,
    pending: Deadline | null = null;
  let outgoing: (Deadline & { envelope: PrivateEnvelope }) | null = null;
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
  const box = el("section", "", "browser-keys browser-checks");
  box.setAttribute("aria-label", "Browser device checks");
  const notice = el(
      "p",
      "Refresh device checks to read saved history.",
      "browser-keys-notice",
    ),
    error = el("p", "", "browser-keys-error"),
    current = el("p", "", "browser-keys-reference");
  notice.setAttribute("role", "status");
  error.setAttribute("role", "alert");
  const actions = el("div", "", "browser-keys-actions"),
    refresh = button("Refresh device checks", () => void load()),
    exportButton = button("Export device check history", exportHistory),
    clearButton = button("Review check history deletion", () =>
      openReview("clear"),
    ),
    resetButton = button("Review check history reset", () =>
      openReview("reset"),
    );
  actions.append(refresh, exportButton, clearButton, resetButton);
  const columns = el("div", "", "browser-keys-columns"),
    history = el("div"),
    list = el("ul"),
    stage = el("div", "", "browser-keys-stage"),
    idle = el("div");
  history.append(
    el("h3", "Saved device checks"),
    el(
      "p",
      "Recorded checks are history, not a live connection or permission to run tasks.",
    ),
    list,
  );
  const peerLabel = el("label", "Reviewed Mac"),
    peerSelect = el("select");
  peerSelect.id = `browser-check-peer-${crypto.randomUUID()}`;
  peerLabel.htmlFor = peerSelect.id;
  const start = button("Review new Mac check", () => openReview("begin"));
  const incomingLabel = el("label", "Encrypted check message from your Mac"),
    incoming = el("textarea");
  incoming.rows = 6;
  incoming.maxLength = 8192;
  incoming.spellcheck = false;
  incomingLabel.append(incoming);
  const respond = button("Review answering Mac check", () =>
      openReview("respond"),
    ),
    complete = button("Review saving Mac reply", () => openReview("complete"));
  idle.append(
    el("h3", "Exchange checks with your Mac"),
    el(
      "p",
      "First review both device identities. Start a check here and take its encrypted message to the Mac. Bring the Mac’s reply back to save the result. Separately, answer a check started on the Mac so it can verify this browser.",
    ),
    peerLabel,
    peerSelect,
    start,
    incomingLabel,
    respond,
    complete,
  );
  const reviewBox = el("div"),
    heading = el("h3"),
    details = el("p"),
    identity = el("p", "", "browser-keys-reference"),
    label = el("label", "", "browser-keys-check"),
    check = el("input"),
    checkText = el("span");
  check.type = "checkbox";
  check.onchange = controls;
  label.append(check, checkText);
  heading.tabIndex = -1;
  const confirm = button("Confirm device check", () => void submit()),
    cancel = button("Cancel check review", () =>
      reset("Check review closed.", true),
    );
  reviewBox.append(heading, details, identity, label, confirm, cancel);
  const output = el("div"),
    outputHeading = el("h3", "Encrypted message for your Mac"),
    outputInfo = el("p"),
    outputLabel = el("label", "Encrypted check message to share"),
    outputText = el("textarea");
  outputHeading.tabIndex = -1;
  outputText.rows = 7;
  outputText.readOnly = true;
  outputText.spellcheck = false;
  outputLabel.append(outputText);
  const copy = button("Select check message to copy", () => {
      if (liveOutput()) {
        outputText.focus();
        outputText.select();
      }
    }),
    download = button("Download encrypted check message", () => {
      if (liveOutput()) save(outputText.value, "bittrees-device-check.json");
    }),
    hide = button("Hide check message", () =>
      reset(
        "Message hidden. Refresh device checks to resume the saved exchange.",
        true,
      ),
    );
  output.append(outputHeading, outputInfo, outputLabel, copy, download, hide);
  stage.append(idle, reviewBox, output);
  columns.append(history, stage);
  box.append(
    el("h2", "Check your Mac"),
    el(
      "p",
      "Verify that each device can use its reviewed key. Both devices complete their own check. This does not allow private tasks or send anything automatically.",
    ),
    current,
    actions,
    notice,
    error,
    columns,
  );
  root.append(box);
  const scope = () => {
    const s = host.session();
    return s ? JSON.stringify([s, host.keyContext()?.binding ?? null]) : null;
  };
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  const focused = () =>
    document.visibilityState !== "hidden" && document.hasFocus();
  const snapshot = () =>
    !!loaded && loaded === scope() && version === host.reviewVersion();
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
  const alive = (g: number, s: string | null) =>
    !disposed &&
    generation === g &&
    !!s &&
    scope() === s &&
    version === host.reviewVersion() &&
    focused() &&
    (!pending || timed(pending));
  const localKey = () => {
    const a = keys?.slots.find((s) => s.state === "active");
    return keys && !keys.locked && a?.publicKey
      ? {
          revision: keys!.revision,
          keyId: a.id,
          keyEpoch: a.keyEpoch,
          binding: a.binding,
          publicKey: a.publicKey,
        }
      : null;
  };
  const online = () => {
    const k = localKey(),
      b = host.keyContext()?.binding;
    return !!k && !!b && same(k.binding, b) && b.expiresAt > now();
  };
  const paired = () =>
    online() &&
    !!peers &&
    !peers.needsFreshDevice &&
    same(peers.key, localKey()) &&
    !status?.needsFreshDevice;
  const valid = () =>
    !!review && snapshot() && focused() && !busy && timed(review);
  const liveOutput = () =>
    !!outgoing && snapshot() && focused() && !busy && timed(outgoing);
  function controls() {
    const ready = snapshot() && focused() && !busy && !!status;
    refresh.disabled = !scope() || !focused() || busy;
    exportButton.disabled = !ready;
    clearButton.disabled = !ready || !status?.revision;
    resetButton.disabled = !ready || !online() || !status?.revision;
    peerSelect.disabled = !ready || !paired();
    start.disabled = peerSelect.disabled || !peerSelect.value;
    incoming.disabled =
      respond.disabled =
      complete.disabled =
        !ready || !paired();
    for (const b of list.querySelectorAll<HTMLButtonElement>("button"))
      b.disabled = !ready || (b.dataset.online === "true" && !paired());
    idle.hidden = !!review || !!outgoing;
    reviewBox.hidden = !review;
    output.hidden = !outgoing;
    check.disabled = busy;
    confirm.disabled = !valid() || !check.checked;
    cancel.disabled = busy;
    copy.disabled = download.disabled = !liveOutput();
  }
  peerSelect.onchange = controls;
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
      host.checkAPI.invalidate();
    }
    version = host.reviewVersion();
    busy = false;
    review = null;
    pending = null;
    outgoing = null;
    check.checked = false;
    incoming.value = outputText.value = "";
    identity.textContent = outputInfo.textContent = "";
    clearDownloads();
    if (forget) {
      loaded = null;
      status = null;
      keys = null;
      peers = null;
      list.replaceChildren();
      peerSelect.replaceChildren();
      current.textContent = "";
    }
    notice.textContent = message;
    error.textContent = "";
    controls();
  }
  function render() {
    current.textContent = `Saved history version ${status!.revision}. ${status!.needsFreshDevice ? "History deleted. A different browser registration and active key are required before resetting these checks. Review fresh device identities afterward; a retired Mac key cannot be reused." : "A saved result describes this browser’s check only. Changes to either device’s identity can make it unusable."}`;
    list.replaceChildren();
    peerSelect.replaceChildren(el("option", "Choose a reviewed Mac"));
    peerSelect.options[0]!.value = "";
    for (const p of peers?.state?.peers ?? [])
      if (!p.revoked) {
        const o = el("option", p.peerId);
        o.value = p.peerId;
        peerSelect.append(o);
      }
    if (!status!.checks.length)
      list.append(
        el("li", "No saved checks. Choose a reviewed Mac to start one."),
      );
    for (const row of status!.checks) {
      const li = el("li"),
        state =
          row.state === "verified"
            ? "Mac reply verified here"
            : row.state === "stopped"
              ? "Stopped on this browser"
              : row.expiresAt <= now()
                ? "Exchange expired"
                : row.state === "preparing"
                  ? "Preparation saved"
                  : row.role === "challenge"
                    ? "Waiting for Mac reply"
                    : "Answer ready for Mac";
      li.append(
        el("h4", state),
        el(
          "p",
          row.role === "challenge"
            ? "Started on this browser"
            : "Answer to a check started on the Mac",
        ),
        el(
          "p",
          `Mac ${row.peerId}. Check ${row.id}. Version ${row.revision}.`,
          "browser-keys-reference",
        ),
        el(
          "p",
          row.verifiedAt
            ? `Recorded ${new Date(row.verifiedAt).toLocaleString()}. This does not confirm the Mac completed its own check.`
            : `Exchange deadline ${new Date(row.expiresAt).toLocaleString()}.`,
        ),
      );
      if (row.state === "preparing" || row.state === "pending") {
        if (row.expiresAt > now()) {
          const resume = button("Review saved check message", () =>
            openReview("resume", row),
          );
          resume.dataset.online = "true";
          li.append(resume);
        }
        li.append(
          button("Review stopping this check", () => openReview("stop", row)),
        );
      }
      list.append(li);
    }
    controls();
  }
  function failure(e: unknown) {
    const message: Record<string, string> = {
      DENIED: "The message, device or access could not be verified.",
      CONFLICT:
        "The saved key, device or check history changed during this review.",
      REPAIR_REQUIRED:
        "A different browser registration and active key are required for this reset.",
      CAPACITY:
        "The saved check limit was reached. No history was removed automatically.",
      BUSY: "Another operation is still finishing.",
      STORAGE_UNAVAILABLE: "Saved device checks are unavailable.",
    };
    error.textContent = `${message[e instanceof Error ? e.message : ""] ?? "The operation was not confirmed."} Refresh device checks before another review. A failed response can follow a saved change; this review cannot be retried.`;
  }
  async function load() {
    if (busy || !focused() || !scope()) return;
    reset("Reading saved device checks…", true);
    const g = generation,
      s = scope();
    busy = true;
    pending = deadline();
    controls();
    try {
      const k = await host.keyAPI.status();
      if (!alive(g, s)) return;
      const p = await host.peerAPI.status();
      if (!alive(g, s)) return;
      const c = await host.checkAPI.status();
      if (!alive(g, s)) return;
      keys = k;
      peers = p;
      status = c;
      loaded = s;
      notice.textContent =
        "Device check history loaded. Saved results do not grant task permission.";
      render();
    } catch (e) {
      if (alive(g, s)) failure(e);
    } finally {
      finish(g, s);
    }
  }
  function finish(g: number, s: string | null) {
    if (g !== generation) return;
    if (!alive(g, s))
      reset(
        "Response expired or access changed. Refresh device checks to inspect any saved result.",
        true,
        false,
      );
    else {
      busy = false;
      pending = null;
      controls();
    }
  }
  const wording: Record<Action, [string, string, string]> = {
    begin: [
      "Start a check of this Mac",
      "Create an encrypted challenge for this reviewed Mac. Take it to the Mac, then bring its encrypted reply back here. Nothing is sent automatically.",
      "Create Mac check",
    ],
    respond: [
      "Answer the Mac’s check",
      "The routing below comes from an unverified message. Confirm to authenticate it and prepare an encrypted answer. Take the answer back to the Mac; answering does not complete this browser’s own check.",
      "Answer Mac check",
    ],
    complete: [
      "Save the Mac’s reply",
      "The routing below comes from an unverified message. Confirm to authenticate the reply against the original pending check. A successful result records this browser’s verification only.",
      "Verify and save Mac reply",
    ],
    resume: [
      "Open the saved check message",
      "Finish any saved preparation and show the original encrypted message. Its identity, deadline and sequence stay unchanged. This does not send it or create another check.",
      "Open saved check message",
    ],
    stop: [
      "Stop this check locally",
      "Prevent further use of this unfinished check on this browser. Copies already shared and the Mac’s own records remain unchanged.",
      "Stop device check",
    ],
    clear: [
      "Delete device check history",
      "Delete saved checks and their encrypted restart material from this browser. Minimal device and sequence markers remain to prevent reuse. A different browser registration and active key are required before resetting checks. Exported copies and the Mac are unchanged.",
      "Delete device check history",
    ],
    reset: [
      "Reset checks for a different browser",
      "Use the current, different browser registration and active key for future checks. Old proof does not regain authority. Review device identities again as needed; resetting their list retires old Mac keys and may require a new Mac key and invitation.",
      "Reset device check history",
    ],
  };
  function openReview(action: Action, row?: Status["checks"][number]) {
    if (!snapshot() || !focused() || busy || !status) return;
    const peerId = peerSelect.value;
    if (
      ["begin", "respond", "complete", "resume"].includes(action) &&
      !paired()
    )
      return;
    if (
      action === "begin" &&
      !peers?.state?.peers.some((p) => p.peerId === peerId && !p.revoked)
    )
      return;
    if ((action === "clear" || action === "reset") && !status.revision) return;
    if (action === "reset" && !online()) return;
    if (row && !status.checks.some((c) => same(c, row))) return;
    let envelope: PrivateEnvelope | undefined;
    if (action === "respond" || action === "complete") {
      try {
        if (incoming.value.length > 8192) throw Error();
        envelope = privateEnvelopeSchema.parse(JSON.parse(incoming.value));
        const b = localKey()!.binding,
          h = envelope.header;
        if (
          h.ownerId !== b.ownerId ||
          h.recipientId !== b.deviceId ||
          h.senderId === b.deviceId ||
          h.expiresAt <= now() ||
          !peers!.state?.peers.some(
            (p) => p.peerId === h.senderId && !p.revoked,
          )
        )
          throw Error();
      } catch {
        error.textContent =
          "Paste an unexpired encrypted check message addressed to this browser from a reviewed Mac.";
        return;
      }
    }
    reset(
      "Review this exact device check. Leaving this window closes the review.",
    );
    review = {
      ...deadline(
        Math.min(
          now() + 120000,
          envelope?.header.expiresAt ?? Infinity,
          action === "resume" ? row!.expiresAt : Infinity,
        ),
      ),
      action,
      peerId,
      row,
      envelope,
    };
    const text = wording[action];
    heading.textContent = text[0];
    details.textContent = text[1];
    confirm.textContent = text[2];
    checkText.textContent = "I reviewed this device and this exact action.";
    identity.textContent = `Account ${host.session()?.ownerId}. Browser ${host.keyContext()?.binding?.deviceId}. ${envelope ? `Unverified sender ${envelope.header.senderId}. Check ${envelope.header.operationId}. Message deadline ${new Date(envelope.header.expiresAt).toLocaleString()}.` : row ? `Mac ${row.peerId}. Check ${row.id}. Version ${row.revision}.` : action === "begin" ? `Mac ${peerId}.` : "All saved checks on this browser."} History version ${status.revision}.`;
    controls();
    heading.focus();
  }
  async function submit() {
    if (!valid() || confirm.disabled || !check.checked) return;
    const r = review!,
      g = generation,
      s = loaded,
      before = { keys, peers, status };
    review = null;
    check.checked = false;
    busy = true;
    pending = r;
    controls();
    try {
      // Review snapshots are not authority. Durable providers revalidate atomically;
      // these comparisons prevent replacing the user's reviewed selection first.
      const k = await host.keyAPI.status();
      if (!alive(g, s)) return;
      const p = await host.peerAPI.status();
      if (!alive(g, s)) return;
      const c = await host.checkAPI.status();
      if (!alive(g, s)) return;
      if (!same(before, { keys: k, peers: p, status: c }))
        throw Error("CONFLICT");
      const confirmed = true;
      if (r.action === "stop")
        await host.checkAPI.stop({
          id: r.row!.id,
          expectedRevision: r.row!.revision,
          confirmed,
        });
      else if (r.action === "clear")
        await host.checkAPI.clear({ expectedRevision: c.revision, confirmed });
      else if (r.action === "reset")
        await host.checkAPI.reset({ expectedRevision: c.revision, confirmed });
      else if (r.action === "complete")
        await host.checkAPI.complete({ envelope: r.envelope, confirmed });
      else {
        const result =
          r.action === "begin"
            ? await host.checkAPI.begin({
                peerId: r.peerId,
                expectedKeyRevision: k.revision,
                expectedPeerRevision: p.revision,
                confirmed,
              })
            : r.action === "respond"
              ? await host.checkAPI.respond({ envelope: r.envelope, confirmed })
              : await host.checkAPI.resume({ id: r.row!.id, confirmed });
        if (!alive(g, s)) return;
        const envelope = await host.checkAPI.envelope({
          id: result.id,
          confirmed,
        });
        if (!alive(g, s)) return;
        outgoing = {
          ...deadline(Math.min(envelope.header.expiresAt, now() + 120000)),
          envelope,
        };
        if (!timed(outgoing)) throw Error("DENIED");
        outputText.value = JSON.stringify(envelope, null, 2);
        outputInfo.textContent = `For Mac ${envelope.header.recipientId}. Expires ${new Date(envelope.header.expiresAt).toLocaleString()}. ${result.role === "challenge" ? "Bring the Mac’s reply back here to complete this browser’s check." : "Take this answer back to the Mac to complete its check. This browser still needs its own completed check."}`;
        notice.textContent =
          "Encrypted check message ready. Nothing was sent automatically.";
        controls();
        outputHeading.focus();
      }
      if (!alive(g, s)) return;
      if (!outgoing)
        reset(
          `${r.action === "complete" ? "Mac reply verified and saved on this browser. The Mac must complete its own check separately." : r.action === "stop" ? "Check stopped on this browser only." : r.action === "clear" ? "Device check history deleted. A different browser registration and key are required before reset." : "Device checks reset for the current browser identity."} Refresh device checks to inspect the result.`,
          true,
        );
    } catch (e) {
      if (alive(g, s)) {
        reset(
          "Response not confirmed. Refresh device checks before another review.",
          true,
        );
        failure(e);
      }
    } finally {
      finish(g, s);
    }
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
    save(
      JSON.stringify(
        {
          format: "bittrees-browser-device-check-history-v1",
          exportedAt: now(),
          history: status,
        },
        null,
        2,
      ),
      "bittrees-device-check-history.json",
    );
    notice.textContent =
      "Device check history exported. This metadata file contains no private keys or encrypted messages and cannot restore verification or task permission.";
  }
  const blur = () =>
      reset(
        "Check review closed after leaving this window. Refresh device checks to continue.",
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
        reset("Check review closed. Refresh device checks to continue.", true);
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
        "Account, registration or key controls changed. Refresh device checks to continue.",
        true,
        false,
      );
    else if (pending && !timed(pending))
      reset(
        "Response timed out. Refresh device checks to see whether a change was saved.",
        true,
      );
    else if (
      (review && !busy && !valid()) ||
      (outgoing && !busy && !liveOutput())
    )
      reset(
        "Check message or review expired. Refresh device checks to continue.",
        true,
      );
    controls();
  }, 500);
  controls();
  return {
    invalidate() {
      reset("Access changed. Refresh device checks to continue.", true, false);
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      generation++;
      host.checkAPI.invalidate();
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
