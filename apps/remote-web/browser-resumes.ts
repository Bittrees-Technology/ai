import {
  privateEnvelopeSchema,
  type PrivateEnvelope,
} from "../../modules/remote/private-envelope.js";
import type { BrowserKeyHost } from "../../modules/remote/browser-key-host.js";
type Host = Pick<
  BrowserKeyHost,
  | "resumeAPI"
  | "keyAPI"
  | "peerAPI"
  | "checkAPI"
  | "session"
  | "keyContext"
  | "reviewVersion"
>;
type Status = Awaited<ReturnType<Host["resumeAPI"]["status"]>>;
type Keys = Awaited<ReturnType<Host["keyAPI"]["status"]>>;
type Peers = Awaited<ReturnType<Host["peerAPI"]["status"]>>;
type Checks = Awaited<ReturnType<Host["checkAPI"]["status"]>>;
type Prepared = Awaited<ReturnType<Host["resumeAPI"]["prepare"]>>;
type Inspected = Awaited<ReturnType<Host["resumeAPI"]["inspectOffer"]>>;
type Snapshot = { keys: Keys; peers: Peers; checks: Checks; status: Status };
type Deadline = { started: number; mono: number; expires: number };
type Review = Deadline & {
  action: "approve" | "revoke" | "clear" | "reset";
  before: Snapshot;
  prepared?: Prepared;
  grantId?: string;
};
/** Independent permission for one exact paused task and model. Inspection grants no authority. */
export function mountBrowserResumes(
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
    pending: Deadline | null = null,
    inspected: Inspected | null = null,
    inspectionDeadline: Deadline | null = null,
    selectedEnvelope: PrivateEnvelope | null = null;
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
    input.id = `browser-resume-${crypto.randomUUID()}`;
    label.htmlFor = input.id;
    const wrapper = el("div", "", "browser-permission-select");
    wrapper.append(input);
    return { label, input, wrapper };
  };
  const box = el("section", "", "browser-keys browser-resumes");
  box.setAttribute("aria-label", "Browser resume permissions");
  const notice = el(
      "p",
      "Refresh resume permissions to read your saved choices.",
      "browser-keys-notice",
    ),
    error = el("p", "", "browser-keys-error"),
    current = el("p", "", "browser-keys-reference");
  notice.setAttribute("role", "status");
  error.setAttribute("role", "alert");
  const actions = el("div", "", "browser-keys-actions"),
    refresh = button("Refresh resume permissions", () => void load()),
    exportButton = button("Export resume permission history", exportHistory),
    clearButton = button("Review resume permission deletion", () =>
      maintenance("clear"),
    ),
    resetButton = button("Review resume permission reset", () =>
      maintenance("reset"),
    );
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
  const peer = select("Mac for task resume"),
    duration = select("Resume permission duration");
  const offerLabel = el("label", "Encrypted resume offer from your Mac"),
    offerInput = el("textarea");
  offerInput.id = "resume-offer-" + crypto.randomUUID();
  offerLabel.htmlFor = offerInput.id;
  offerInput.rows = 4;
  offerInput.maxLength = 98304;
  offerInput.autocomplete = "off";
  offerInput.spellcheck = false;
  const fileLabel = el("label", "Choose an encrypted offer file"),
    fileInput = el("input");
  fileInput.type = "file";
  fileInput.accept = ".json,application/json";
  fileInput.id = "resume-offer-file-" + crypto.randomUUID();
  fileLabel.htmlFor = fileInput.id;
  const opening = button("Open selected Mac offer", () => void openOffer());
  const offered = el("p", "", "browser-keys-reference");
  for (const [value, text] of [
    ["1", "1 minute"],
    ["15", "15 minutes"],
    ["60", "1 hour"],
  ]) {
    const option = el("option", text);
    option.value = value!;
    duration.input.append(option);
  }
  const start = button("Review resume permission", () => void prepare());
  form.append(
    el("h3", "Open your Mac’s offer"),
    el(
      "p",
      "Choose the Mac you already verified. Open its encrypted offer to inspect the exact paused task and model before reviewing permission.",
    ),
    peer.label,
    peer.wrapper,
    fileLabel,
    fileInput,
    offerLabel,
    offerInput,
    opening,
    offered,
    duration.label,
    duration.wrapper,
    el(
      "p",
      "Permission ends sooner if the Mac offer or this browser’s registration expires. Saving permission does not resume the task.",
    ),
    start,
  );
  const reviewBox = el("div"),
    heading = el("h3"),
    details = el("p"),
    identity = el("p", "", "browser-keys-reference"),
    ack = checkbox(
      "I reviewed this exact task, task version, model, Mac and expiry.",
    ),
    confirm = button("Save resume permission", () => void submit()),
    cancel = button("Cancel resume review", () =>
      reset("Permission review closed.", true),
    );
  heading.tabIndex = -1;
  reviewBox.append(heading, details, identity, ack.label, confirm, cancel);
  stage.append(form, reviewBox);
  columns.append(history, stage);
  box.append(
    el("h2", "Choose task resume permission"),
    el(
      "p",
      "Review permission for one paused task on your Mac. Saving permission alone does not resume it. Sending a resume request and receiving its confirmation are still being prepared.",
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
      offerInput.disabled =
      opening.disabled =
        !ready || !paired();
    fileInput.disabled = !scope() || !focused() || busy;
    opening.disabled ||= !peer.input.value || !offerInput.value.trim();
    duration.input.disabled = !ready || !inspected;
    start.disabled =
      !ready || !inspected || !inspectionDeadline || !timed(inspectionDeadline);
    for (const b of list.querySelectorAll<HTMLButtonElement>("button"))
      b.disabled = !ready;
    form.hidden = !!review;
    reviewBox.hidden = !review;
    ack.input.disabled = busy;
    confirm.disabled =
      !ready || !review || !timed(review) || !ack.input.checked;
    cancel.disabled = busy;
  }
  function clearInspection() {
    inspected = null;
    selectedEnvelope = null;
    inspectionDeadline = null;
    offered.textContent = "";
  }
  peer.input.onchange = offerInput.oninput = () => {
    clearInspection();
    controls();
  };
  duration.input.onchange = ack.input.onchange = controls;
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0],
      s = scope();
    fileInput.value = "";
    if (!file || !s || busy) return;
    reset("Reading the selected encrypted offer file…");
    const g = generation;
    if (file.size > 98304) {
      error.textContent =
        "Choose an encrypted offer file no larger than 96 KiB.";
      return;
    }
    try {
      const text = await file.text();
      if (disposed || g !== generation || s !== scope() || !focused()) return;
      privateEnvelopeSchema.parse(JSON.parse(text));
      const loading = load(),
        loadedGeneration = generation;
      await loading;
      if (
        disposed ||
        loadedGeneration !== generation ||
        !state ||
        !snapshot() ||
        s !== scope() ||
        !focused()
      )
        return;
      offerInput.value = text;
      notice.textContent =
        "Offer file loaded. Choose its verified Mac and open the offer to see available access.";
      controls();
    } catch {
      if (!disposed && g === generation && s === scope() && focused())
        error.textContent =
          "The selected file is not a supported encrypted offer. No access was saved.";
    }
  };
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
      host.resumeAPI.invalidate();
    }
    version = host.reviewVersion();
    busy = false;
    review = null;
    pending = null;
    ack.input.checked = false;
    clearInspection();
    offerInput.value = "";
    fileInput.value = "";
    duration.input.value = "15";
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
    current.textContent = `Saved permission version ${state!.status.revision}. ${state!.status.needsFreshDevice ? "Permissions deleted. Use a different browser registration and active key before resetting." : "Resume permission applies to an exact task and model and does not confirm a current connection."}`;
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
          "No saved resume permissions. Choose a reviewed Mac and open its encrypted offer.",
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
          `Mac ${grant.choices.peerId}. ${describeTask(grant.choices)} Permission ${grant.id}. Version ${grant.revision}.`,
          "browser-keys-reference",
        ),
        el("p", `Ends ${new Date(grant.choices.expiresAt).toLocaleString()}.`),
      );
      if (!grant.revoked)
        li.append(
          button("Review revoking permission", () =>
            maintenance("revoke", grant.id),
          ),
        );
      list.append(li);
    }
    controls();
  }
  function failure(e: unknown) {
    const messages: Record<string, string> = {
      DENIED:
        "The device, completed check, offer or access could not be verified.",
      CONFLICT:
        "The saved device, check or permission changed during this review.",
      REPAIR_REQUIRED:
        "A different browser registration and active key are required before resetting permissions.",
      CAPACITY:
        "The permission limit was reached. No choices were removed automatically.",
      BUSY: "Another operation is still finishing.",
      STORAGE_UNAVAILABLE: "Saved permissions are unavailable.",
    };
    error.textContent = `${messages[e instanceof Error ? e.message : ""] ?? "The operation was not confirmed."} Refresh resume permissions before another review. A failed response can follow a saved change; do not repeat the old approval.`;
  }
  async function read(g: number, s: string | null): Promise<Snapshot | null> {
    const keys = await host.keyAPI.status();
    if (!alive(g, s)) return null;
    const peers = await host.peerAPI.status();
    if (!alive(g, s)) return null;
    const checks = await host.checkAPI.status();
    if (!alive(g, s)) return null;
    const status = await host.resumeAPI.status();
    return alive(g, s) ? { keys, peers, checks, status } : null;
  }
  function finish(g: number, s: string | null) {
    if (g !== generation) return;
    if (!alive(g, s))
      reset(
        "Response expired or access changed. Refresh resume permissions to inspect any saved result.",
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
  function describeTask(
    value: Pick<
      Inspected["offer"],
      "taskId" | "taskRevision" | "modelDigest" | "permissionId"
    >,
  ) {
    return `Task ${value.taskId}. Task version ${value.taskRevision}. Model ${value.modelDigest}. Mac permission ${value.permissionId}.`;
  }
  async function openOffer() {
    if (opening.disabled || !state || !snapshot() || !focused() || busy) return;
    const before = structuredClone(state),
      k = local()!,
      selected = state.peers.state?.peers.find(
        (p) => p.peerId === peer.input.value && !p.revoked,
      );
    if (!selected) return;
    let envelope: PrivateEnvelope;
    try {
      envelope = privateEnvelopeSchema.parse(JSON.parse(offerInput.value));
    } catch {
      error.textContent =
        "The offer is not valid encrypted JSON. No access was saved.";
      return;
    }
    reset("Authenticating the selected Mac offer…");
    const g = generation,
      s = loaded;
    busy = true;
    pending = deadline();
    controls();
    try {
      const fresh = await read(g, s);
      if (!fresh) return;
      if (!same(before, fresh)) throw Error("CONFLICT");
      const request = {
        expectedRevision: before.status.revision,
        peerId: selected.peerId,
        peerKeyEpoch: selected.keyEpoch,
      };
      const value = await host.resumeAPI.inspectOffer({
        ...request,
        envelope,
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
        !same(value.local, k) ||
        !same(value.peer, proof) ||
        value.expectedRevision !== before.status.revision ||
        value.openingExpiresAt !== envelope!.header.expiresAt
      )
        throw Error("CONFLICT");
      inspected = value;
      selectedEnvelope = envelope!;
      inspectionDeadline = deadline(
        Math.min(
          pending!.expires,
          value.openingExpiresAt,
          value.offer.expiresAt,
        ),
      );
      offered.textContent = `Verified Mac ${selected.peerId}. Fingerprint ${selected.fingerprint}. ${describeTask(value.offer)} Mac access ends ${new Date(value.offer.expiresAt).toLocaleString()}. Choose how long this browser may request this exact resume.`;
      notice.textContent =
        "Mac offer authenticated. No permission was saved and no task was resumed.";
      controls();
    } catch (e) {
      if (alive(g, s)) {
        reset("Offer could not be opened.", true);
        failure(e);
      }
    } finally {
      finish(g, s);
    }
  }
  async function prepare() {
    if (
      start.disabled ||
      !state ||
      !snapshot() ||
      !focused() ||
      busy ||
      !inspected ||
      !selectedEnvelope
    )
      return;
    const before = structuredClone(state),
      k = local()!,
      inspection = structuredClone(inspected),
      envelope = structuredClone(selectedEnvelope),
      selected = state.peers.state?.peers.find(
        (p) => p.peerId === inspection.peer.peerId && !p.revoked,
      ),
      minutes = Number(duration.input.value);
    if (!selected || ![1, 15, 60].includes(minutes)) return;
    const choices = {
      peerId: selected.peerId,
      peerKeyEpoch: selected.keyEpoch,
      permissionId: inspection.offer.permissionId,
      taskId: inspection.offer.taskId,
      taskRevision: inspection.offer.taskRevision,
      modelDigest: inspection.offer.modelDigest,
      expiresAt: Math.min(
        now() + minutes * 60000,
        k.binding.expiresAt,
        inspection.offer.expiresAt,
      ),
    };
    reset("Checking the exact resume choices…");
    const g = generation,
      s = loaded;
    busy = true;
    pending = deadline();
    controls();
    try {
      const fresh = await read(g, s);
      if (!fresh) return;
      if (!same(before, fresh)) throw Error("CONFLICT");
      const prepared = await host.resumeAPI.prepare({
        expectedRevision: before.status.revision,
        peerId: selected.peerId,
        peerKeyEpoch: selected.keyEpoch,
        envelope,
        expiresAt: choices.expiresAt,
      });
      if (!alive(g, s)) return;
      if (
        !same(prepared.choices, choices) ||
        !same(prepared.offer, inspection.offer) ||
        !same(prepared.local, k) ||
        !same(prepared.peer, inspection.peer)
      )
        throw Error("CONFLICT");
      review = {
        ...pending!,
        expires: Math.min(pending!.expires, prepared.expiresAt),
        action: "approve",
        before,
        prepared,
      };
      heading.textContent = "Review browser resume permission";
      details.textContent = `Access ends ${new Date(choices.expiresAt).toLocaleString()}. The Mac keeps its own permission checks. Saving this permission sends no resume request and does not run the task.`;
      identity.textContent = `${describeTask(choices)} Browser ${k.binding.deviceId}. Mac ${selected.peerId}. Verified Mac fingerprint ${selected.fingerprint}.`;
      ack.input.checked = false;
      confirm.textContent = "Save resume permission";
      notice.textContent =
        "Review these exact choices. Leaving this window closes the review.";
      controls();
      heading.focus();
    } catch (e) {
      if (alive(g, s)) {
        reset("Resume review could not be prepared.", true);
        failure(e);
      }
    } finally {
      finish(g, s);
    }
  }
  function maintenance(action: "revoke" | "clear" | "reset", grantId?: string) {
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
      !state.status.grants.some((g) => g.id === grantId && !g.revoked)
    )
      return;
    const before = structuredClone(state),
      selectedGrant = state.status.grants.find((g) => g.id === grantId);
    reset("Review this exact permission change.");
    review = { ...deadline(), action, before, grantId };
    const wording = {
      revoke: [
        "Revoke this browser’s permission",
        "Stop this browser from requesting a resume with this permission. This does not revoke Mac permissions, cancel running tasks or delete exports.",
        "Revoke browser permission",
      ],
      clear: [
        "Delete saved browser permissions",
        "Delete saved permission choices and their local encryption key. A minimal locked marker remains; a different browser registration and active key are required before reset. Task history, Mac choices and exported copies are not deleted.",
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
    identity.textContent = `Account ${host.session()?.ownerId}. ${selectedGrant ? `${describeTask(selectedGrant.choices)} Mac ${selectedGrant.choices.peerId}. Permission ${selectedGrant.id}.` : "All saved browser resume permissions."} Saved version ${before.status.revision}.`;
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
        await host.resumeAPI.approve({
          reviewId: r.prepared!.reviewId,
          expectedRevision: r.prepared!.expectedRevision,
          confirmed: true,
          acknowledged: true,
        });
      else if (r.action === "revoke")
        await host.resumeAPI.revoke({
          grantId: r.grantId!,
          expectedRevision: r.before.status.revision,
          confirmed: true,
        });
      else
        await host.resumeAPI[r.action]({
          expectedRevision: r.before.status.revision,
          confirmed: true,
        });
      if (!alive(g, s)) return;
      reset(
        `${r.action === "approve" ? "Browser resume permission saved. No task was resumed." : r.action === "revoke" ? "Permission revoked on this browser only." : r.action === "clear" ? "Browser permissions deleted. A different registration and active key are required before reset." : "Browser permissions reset. No choices are enabled."} Refresh resume permissions to inspect the result.`,
        true,
      );
    } catch (e) {
      if (alive(g, s)) {
        reset(
          "Response not confirmed. Refresh resume permissions to inspect the saved state.",
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
              format: "bittrees-browser-resume-permissions-v1",
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
    a.download = "bittrees-browser-resume-permissions.json";
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
        "Permission review closed after leaving this window. Refresh resume permissions to continue.",
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
          "Permission review closed. Refresh resume permissions to continue.",
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
        "Account, registration or device controls changed. Refresh resume permissions to continue.",
        true,
        false,
      );
    else if (
      (pending && !timed(pending)) ||
      (review && !busy && !timed(review)) ||
      (inspectionDeadline && !busy && !timed(inspectionDeadline))
    )
      reset(
        "Permission review expired. Refresh resume permissions to inspect the saved state.",
        true,
      );
    controls();
  }, 500);
  controls();
  return {
    invalidate() {
      reset(
        "Access changed. Refresh resume permissions to continue.",
        true,
        false,
      );
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      generation++;
      host.resumeAPI.invalidate();
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
