import {
  privateEnvelopeSchema,
  type PrivateEnvelope,
} from "../../modules/remote/private-envelope.js";
import type { BrowserKeyHost } from "../../modules/remote/browser-key-host.js";
type Host = Pick<
  BrowserKeyHost,
  | "conversationAPI"
  | "relayConversationAPI"
  | "keyAPI"
  | "peerAPI"
  | "checkAPI"
  | "session"
  | "keyContext"
  | "reviewVersion"
>;
type Status = Awaited<ReturnType<Host["conversationAPI"]["status"]>>;
type Keys = Awaited<ReturnType<Host["keyAPI"]["status"]>>;
type Peers = Awaited<ReturnType<Host["peerAPI"]["status"]>>;
type Checks = Awaited<ReturnType<Host["checkAPI"]["status"]>>;
type Prepared = Awaited<ReturnType<Host["conversationAPI"]["prepare"]>>;
type Inspected = Awaited<ReturnType<Host["conversationAPI"]["inspectOffer"]>>;
type Snapshot = { keys: Keys; peers: Peers; checks: Checks; status: Status };
type Queue = Awaited<ReturnType<Host["relayConversationAPI"]["inspect"]>>;
type Cursor = Queue["nextCursor"];
type QueueSelection = {
  after: Cursor;
  selection: NonNullable<Queue["item"]>["selection"];
};
type Deadline = { started: number; mono: number; expires: number };
type Review = Deadline & {
  action: "approve" | "revoke" | "clear" | "reset" | "acknowledge";
  selected?: QueueSelection;
  before: Snapshot;
  prepared?: Prepared;
  grantId?: string;
};
/** Independent browser conversation consent. Offer inspection never selects access. */
export function mountBrowserConversations(
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
  let queue: (Queue & { after: Cursor }) | null = null;
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
    input.id = `browser-conversation-${crypto.randomUUID()}`;
    label.htmlFor = input.id;
    const wrapper = el("div", "", "browser-permission-select");
    wrapper.append(input);
    return { label, input, wrapper };
  };
  const box = el("section", "", "browser-keys browser-conversations");
  box.setAttribute("aria-label", "Browser conversation permissions");
  const notice = el(
      "p",
      "Refresh conversation permissions to read your saved choices.",
      "browser-keys-notice",
    ),
    error = el("p", "", "browser-keys-error"),
    current = el("p", "", "browser-keys-reference");
  notice.setAttribute("role", "status");
  error.setAttribute("role", "alert");
  const actions = el("div", "", "browser-keys-actions"),
    refresh = button("Refresh conversation permissions", () => void load()),
    exportButton = button(
      "Export conversation permission history",
      exportHistory,
    ),
    clearButton = button("Review conversation permission deletion", () =>
      maintenance("clear"),
    ),
    resetButton = button("Review conversation permission reset", () =>
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
  const peer = select("Mac for conversation access"),
    duration = select("Conversation access duration"),
    messagesToMac = checkbox("Allow messages from this browser to the Mac"),
    messagesToBrowser = checkbox("Allow messages from the Mac to this browser"),
    questionsToBrowser = checkbox(
      "Allow task questions from the Mac to this browser",
    ),
    answersToMac = checkbox(
      "Allow reviewed answers from this browser to the Mac",
    );
  const directions = {
    messagesToMac,
    messagesToBrowser,
    questionsToBrowser,
    answersToMac,
  };
  const offerLabel = el("label", "Encrypted conversation offer from your Mac"),
    offerInput = el("textarea");
  offerInput.id = "conversation-offer-" + crypto.randomUUID();
  offerLabel.htmlFor = offerInput.id;
  offerInput.rows = 4;
  offerInput.maxLength = 98304;
  offerInput.autocomplete = "off";
  offerInput.spellcheck = false;
  const fileLabel = el("label", "Choose an encrypted offer file"),
    fileInput = el("input");
  fileInput.type = "file";
  fileInput.accept = ".json,application/json";
  fileInput.id = "conversation-offer-file-" + crypto.randomUUID();
  fileLabel.htmlFor = fileInput.id;
  const opening = button("Open selected Mac offer", () => void openOffer());
  const offered = el("p", "", "browser-keys-reference");
  const queueBox = el("div"),
    queueInfo = el(
      "p",
      "Inspect the queue to find an encrypted offer sent by your Mac.",
      "browser-keys-reference",
    ),
    queueInspect = button("Inspect offer queue", () => void inspectQueue(null)),
    queueNext = button("Inspect next queued item", () => {
      if (queue?.item) void inspectQueue(queue.item.cursor);
    }),
    queueOpen = button("Open queued Mac offer", () => void openOffer(true));
  queueBox.append(
    el("h3", "Offers sent by your Mac"),
    el(
      "p",
      "Inspecting does not open or remove anything. Choose the verified Mac below before opening an offer. Task replies use the task controls.",
    ),
    queueInfo,
    queueInspect,
    queueNext,
    queueOpen,
  );

  for (const [value, text] of [
    ["1", "1 minute"],
    ["15", "15 minutes"],
    ["60", "1 hour"],
  ]) {
    const option = el("option", text);
    option.value = value!;
    duration.input.append(option);
  }
  const start = button("Review conversation access", () => void prepare());
  form.append(
    el("h3", "Open your Mac’s offer"),
    el(
      "p",
      "Choose the Mac you already verified. Opening its encrypted offer shows the available access; all your choices start off.",
    ),
    peer.label,
    peer.wrapper,
    queueBox,
    fileLabel,
    fileInput,
    offerLabel,
    offerInput,
    opening,
    offered,
    messagesToMac.label,
    messagesToBrowser.label,
    questionsToBrowser.label,
    answersToMac.label,
    duration.label,
    duration.wrapper,
    el(
      "p",
      "Access ends sooner if the Mac offer or this browser’s registration expires. Each conversation has its own choices.",
    ),
    start,
  );
  const reviewBox = el("div"),
    heading = el("h3"),
    details = el("p"),
    identity = el("p", "", "browser-keys-reference"),
    ack = checkbox(
      "I reviewed this conversation, Mac and these exact choices.",
    ),
    confirm = button("Save conversation access", () => void submit()),
    cancel = button("Cancel conversation review", () =>
      reset("Permission review closed.", true),
    );
  heading.tabIndex = -1;
  reviewBox.append(heading, details, identity, ack.label, confirm, cancel);
  stage.append(form, reviewBox);
  columns.append(history, stage);
  box.append(
    el("h2", "Choose conversation access"),
    el(
      "p",
      "Accept only the conversation access you want. The Mac keeps its own choices. Task creation, app access and publishing permissions stay separate. Conversation delivery is still being prepared.",
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
    queueInspect.disabled = !ready || !paired() || !!review;
    queueNext.disabled = queueInspect.disabled || !queue?.item;
    queueOpen.disabled =
      queueInspect.disabled || !queue?.item || !peer.input.value;
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
    for (const [name, control] of Object.entries(directions)) {
      const key = name as keyof typeof directions;
      control.input.disabled =
        !ready ||
        !inspected ||
        !inspected.offer.permissions[key] ||
        (key === "answersToMac" && !questionsToBrowser.input.checked);
    }
    start.disabled =
      !ready ||
      !inspected ||
      !inspectionDeadline ||
      !timed(inspectionDeadline) ||
      !(
        messagesToMac.input.checked ||
        messagesToBrowser.input.checked ||
        questionsToBrowser.input.checked
      ) ||
      (answersToMac.input.checked && !questionsToBrowser.input.checked);
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
    for (const c of Object.values(directions)) c.input.checked = false;
  }
  for (const c of Object.values(directions))
    c.input.onchange = () => {
      if (!questionsToBrowser.input.checked) answersToMac.input.checked = false;
      controls();
    };
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
      host.conversationAPI.invalidate();
    }
    version = host.reviewVersion();
    busy = false;
    review = null;
    pending = null;
    ack.input.checked = false;
    clearInspection();
    queue = null;
    queueInfo.textContent =
      "Inspect the queue to find an encrypted offer sent by your Mac.";
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
    current.textContent = `Saved permission version ${state!.status.revision}. ${state!.status.needsFreshDevice ? "Permissions deleted. Use a different browser registration and active key before resetting." : "Conversation choices are separate from task access and do not confirm a current connection."}`;
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
          `Mac ${grant.choices.peerId}. Conversation ${grant.choices.scope.conversationRef}. Permission ${grant.id}. Version ${grant.revision}.`,
          "browser-keys-reference",
        ),
        el(
          "p",
          `${describeDirections(grant.choices.permissions)} Ends ${new Date(grant.choices.expiresAt).toLocaleString()}.`,
        ),
      );
      const receipt = grant.relayAcknowledgement;
      li.append(
        el(
          "p",
          receipt
            ? `Receipt attempts: ${receipt.attempts}. ${
                receipt.observation
                  ? `Server receipt last confirmed: ${receipt.observation.receipt.state === "deleted" ? "removed" : "received"}.${receipt.observation.attempt < receipt.attempts ? " Latest attempt remains unconfirmed." : ""}`
                  : "Server receipt is unconfirmed. Refresh, then review a retry."
              }`
            : "No relay receipt recorded. Saving browser choices does not acknowledge the offer.",
        ),
      );
      if (
        !grant.revoked &&
        grant.choices.expiresAt > now() &&
        grant.offerReplay &&
        (receipt || queue?.item)
      )
        li.append(
          button(
            receipt
              ? "Review retrying offer receipt"
              : "Review acknowledging queued offer",
            () => reviewReceipt(grant.id),
          ),
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
    error.textContent = `${messages[e instanceof Error ? e.message : ""] ?? "The operation was not confirmed."} Refresh conversation permissions before another review. A failed response can follow a saved change; do not repeat the old approval.`;
  }
  async function read(g: number, s: string | null): Promise<Snapshot | null> {
    const keys = await host.keyAPI.status();
    if (!alive(g, s)) return null;
    const peers = await host.peerAPI.status();
    if (!alive(g, s)) return null;
    const checks = await host.checkAPI.status();
    if (!alive(g, s)) return null;
    const status = await host.conversationAPI.status();
    return alive(g, s) ? { keys, peers, checks, status } : null;
  }
  function finish(g: number, s: string | null) {
    if (g !== generation) return;
    if (!alive(g, s))
      reset(
        "Response expired or access changed. Refresh conversation permissions to inspect any saved result.",
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
  function describeDirections(permissions: Inspected["offer"]["permissions"]) {
    return `Messages to Mac: ${permissions.messagesToMac ? "allowed" : "off"}. Messages to browser: ${permissions.messagesToBrowser ? "allowed" : "off"}. Questions to browser: ${permissions.questionsToBrowser ? "allowed" : "off"}. Answers to Mac: ${permissions.answersToMac ? "allowed" : "off"}.`;
  }
  async function inspectQueue(after: Cursor) {
    if (queueInspect.disabled || !state || !snapshot()) return;
    const before = structuredClone(state);
    reset("Inspecting one queued item…");
    const g = generation,
      s = loaded;
    busy = true;
    pending = deadline();
    controls();
    try {
      const fresh = await read(g, s);
      if (!fresh) return;
      if (!same(before, fresh)) throw Error("CONFLICT");
      const result = await host.relayConversationAPI.inspect({
        after,
        confirmed: true,
      });
      if (!alive(g, s)) return;
      queue = { ...result, after };
      queueInfo.textContent = result.item
        ? `Queued item ${result.item.selection.messageId}. Stored ${new Date(result.item.selection.storedAt).toLocaleString()}. Available until ${new Date(result.item.expiresAt).toLocaleString()}. Content has not been opened or acknowledged.`
        : "No queued item here. Inspect from the start to check again.";
      notice.textContent =
        "Queue inspected. No permission changed and nothing was acknowledged.";
      render();
    } catch (e) {
      if (alive(g, s)) {
        reset("Queue inspection was not confirmed.", true);
        failure(e);
      }
    } finally {
      finish(g, s);
    }
  }
  function reviewReceipt(grantId: string) {
    if (!state || !snapshot() || !focused() || busy || !paired()) return;
    const grant = state.status.grants.find((g) => g.id === grantId);
    if (
      !grant ||
      grant.revoked ||
      grant.choices.expiresAt <= now() ||
      !grant.offerReplay
    )
      return;
    const selected =
      !grant.relayAcknowledgement && queue?.item
        ? {
            after: queue.after,
            selection: structuredClone(queue.item.selection),
          }
        : undefined;
    if (!selected && !grant.relayAcknowledgement) return;
    const before = structuredClone(state),
      selection = selected?.selection ?? grant.relayAcknowledgement!.selection;
    reset("Review the exact offer receipt.");
    review = {
      ...deadline(
        Math.min(
          grant.choices.expiresAt,
          grant.relayAcknowledgement?.deliveryExpiresAt ?? now() + 120000,
        ),
      ),
      action: "acknowledge",
      before,
      grantId,
      ...(selected ? { selected } : {}),
    };
    heading.textContent = "Acknowledge this offer’s receipt";
    details.textContent =
      "Tell the server this browser saved its choices for this exact offer. This may remove the encrypted offer from the queue. It does not renew access, send conversation messages or approve work.";
    identity.textContent = `Mac ${grant.choices.peerId}. Conversation ${grant.choices.scope.conversationRef}. Permission ${grant.id}. Queued offer ${selection.messageId}. Saved version ${before.status.revision}.`;
    confirm.textContent = "Acknowledge offer receipt";
    ack.input.checked = false;
    controls();
    heading.focus();
  }
  async function openOffer(fromQueue = false) {
    if (
      (fromQueue ? queueOpen.disabled : opening.disabled) ||
      !state ||
      !snapshot() ||
      !focused() ||
      busy
    )
      return;
    const before = structuredClone(state),
      k = local()!,
      selected = state.peers.state?.peers.find(
        (p) => p.peerId === peer.input.value && !p.revoked,
      );
    if (!selected) return;
    const selectedQueue =
      fromQueue && queue?.item
        ? {
            after: queue.after,
            selection: structuredClone(queue.item.selection),
          }
        : null;
    let envelope: PrivateEnvelope;
    try {
      if (!fromQueue)
        envelope = privateEnvelopeSchema.parse(JSON.parse(offerInput.value));
      else if (!selectedQueue) return;
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
      let value: Inspected;
      if (selectedQueue) {
        const received = await host.relayConversationAPI.open({
          ...request,
          ...selectedQueue,
          confirmed: true,
        });
        if (!same(received.selection, selectedQueue.selection))
          throw Error("CONFLICT");
        envelope = privateEnvelopeSchema.parse(received.envelope);
        value = received.opened;
      } else
        value = await host.conversationAPI.inspectOffer({
          ...request,
          envelope: envelope!,
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
      offered.textContent = `Verified Mac ${selected.peerId}. Fingerprint ${selected.fingerprint}. Conversation ${value.offer.scope.conversationRef}. ${describeDirections(value.offer.permissions)} Mac access ends ${new Date(value.offer.expiresAt).toLocaleString()}. Choose only the directions you want below.`;
      notice.textContent =
        "Mac offer authenticated. No permission is selected or saved.";
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
    const permissions = {
      messagesToMac: messagesToMac.input.checked,
      messagesToBrowser: messagesToBrowser.input.checked,
      questionsToBrowser: questionsToBrowser.input.checked,
      answersToMac: answersToMac.input.checked,
    };
    const choices = {
      peerId: selected.peerId,
      peerKeyEpoch: selected.keyEpoch,
      scope: inspection.offer.scope,
      permissions,
      expiresAt: Math.min(
        now() + minutes * 60000,
        k.binding.expiresAt,
        inspection.offer.expiresAt,
      ),
    };
    reset("Checking the exact conversation choices…");
    const g = generation,
      s = loaded;
    busy = true;
    pending = deadline();
    controls();
    try {
      const fresh = await read(g, s);
      if (!fresh) return;
      if (!same(before, fresh)) throw Error("CONFLICT");
      const prepared = await host.conversationAPI.prepare({
        expectedRevision: before.status.revision,
        peerId: selected.peerId,
        peerKeyEpoch: selected.keyEpoch,
        envelope,
        permissions,
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
      heading.textContent = "Review browser conversation access";
      details.textContent = `${describeDirections(permissions)} Access ends ${new Date(choices.expiresAt).toLocaleString()}. The Mac retains its own access choices. Saving these choices sends no message and grants no task or publishing permission.`;
      identity.textContent = `Conversation ${choices.scope.conversationRef}. Browser ${k.binding.deviceId}. Mac ${selected.peerId}. Verified Mac fingerprint ${selected.fingerprint}.`;
      ack.input.checked = false;
      confirm.textContent = "Save conversation access";
      notice.textContent =
        "Review these exact choices. Leaving this window closes the review.";
      controls();
      heading.focus();
    } catch (e) {
      if (alive(g, s)) {
        reset("Conversation review could not be prepared.", true);
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
        "Stop further conversation access under this browser permission. This does not revoke Mac choices, cancel tasks or retract downloaded messages and exports.",
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
    identity.textContent = `Account ${host.session()?.ownerId}. ${selectedGrant ? `Conversation ${selectedGrant.choices.scope.conversationRef}. Mac ${selectedGrant.choices.peerId}. Permission ${selectedGrant.id}. ${describeDirections(selectedGrant.choices.permissions)}` : "All saved browser conversation permissions."} Saved version ${before.status.revision}.`;
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
        await host.conversationAPI.approve({
          reviewId: r.prepared!.reviewId,
          expectedRevision: r.prepared!.expectedRevision,
          confirmed: true,
          acknowledged: true,
        });
      else if (r.action === "acknowledge") {
        const result = await host.relayConversationAPI.acknowledge({
          grantId: r.grantId!,
          expectedRevision: r.before.status.revision,
          confirmed: true,
          ...(r.selected ? { selected: r.selected } : {}),
        });
        const original = r.before.status.grants.find(
          (v) => v.id === r.grantId,
        )!;
        if (
          result.grant.id !== original.id ||
          !same(result.grant.choices, original.choices) ||
          result.grant.approvedAt !== original.approvedAt ||
          !result.grant.relayAcknowledgement?.observation
        )
          throw Error("CONFLICT");
      } else if (r.action === "revoke")
        await host.conversationAPI.revoke({
          grantId: r.grantId!,
          expectedRevision: r.before.status.revision,
          confirmed: true,
        });
      else
        await host.conversationAPI[r.action]({
          expectedRevision: r.before.status.revision,
          confirmed: true,
        });
      if (!alive(g, s)) return;
      reset(
        `${r.action === "acknowledge" ? "Offer receipt confirmed by the server. Conversation choices are unchanged." : r.action === "approve" ? "Browser conversation access saved. No messages were sent." : r.action === "revoke" ? "Permission revoked on this browser only." : r.action === "clear" ? "Browser permissions deleted. A different registration and active key are required before reset." : "Browser permissions reset. No choices are enabled."} Refresh conversation permissions to inspect the result.`,
        true,
      );
    } catch (e) {
      if (alive(g, s)) {
        reset(
          "Response not confirmed. Refresh conversation permissions to inspect the saved state.",
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
              format: "bittrees-browser-conversation-permissions-v1",
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
    a.download = "bittrees-browser-conversation-permissions.json";
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
        "Permission review closed after leaving this window. Refresh conversation permissions to continue.",
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
          "Permission review closed. Refresh conversation permissions to continue.",
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
        "Account, registration or device controls changed. Refresh conversation permissions to continue.",
        true,
        false,
      );
    else if (
      (pending && !timed(pending)) ||
      (review && !busy && !timed(review)) ||
      (inspectionDeadline && !busy && !timed(inspectionDeadline))
    )
      reset(
        "Permission review expired. Refresh conversation permissions to inspect the saved state.",
        true,
      );
    controls();
  }, 500);
  controls();
  return {
    invalidate() {
      reset(
        "Access changed. Refresh conversation permissions to continue.",
        true,
        false,
      );
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      generation++;
      host.conversationAPI.invalidate();
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
