import { browserTaskBytes } from "../../modules/remote/browser-task-preparation.js";
import type { BrowserKeyHost } from "../../modules/remote/browser-key-host.js";
import {
  privateEnvelopeSchema,
  type PrivateEnvelope,
} from "../../modules/remote/private-envelope.js";
import {
  privateTaskPayloadSchema,
  privateResultPayloadSchema,
} from "../../modules/remote/private-task-contracts.js";
type Host = Pick<
  BrowserKeyHost,
  | "taskAPI"
  | "relayTaskAPI"
  | "keyAPI"
  | "peerAPI"
  | "checkAPI"
  | "consentAPI"
  | "session"
  | "keyContext"
  | "reviewVersion"
>;
type History = Awaited<ReturnType<Host["taskAPI"]["status"]>>;
type Row = History["entries"][number];
type Prepared = Awaited<ReturnType<Host["taskAPI"]["prepare"]>>;
type Snapshot = {
  history: History;
  keys: Awaited<ReturnType<Host["keyAPI"]["status"]>>;
  peers: Awaited<ReturnType<Host["peerAPI"]["status"]>>;
  checks: Awaited<ReturnType<Host["checkAPI"]["status"]>>;
  permissions: Awaited<ReturnType<Host["consentAPI"]["status"]>>;
};
type Action =
  | "initialize"
  | "submit"
  | "relayPrepare"
  | "relaySend"
  | "relayCheck"
  | "resume"
  | "envelope"
  | "receive"
  | "read"
  | "stop"
  | "export"
  | "clear";
type Deadline = { wall: number; mono: number; expiresAt: number };
type Review = Deadline & {
  action: Action;
  before: Snapshot;
  row?: Row;
  prepared?: Prepared;
  incoming?: {
    kind: "receipt" | "result";
    envelope: PrivateEnvelope;
    peerId: string;
    peerKeyEpoch: number;
  };
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
/** Exact task reviews over the verified host. Encrypted handoff stays explicit;
 * configured private delivery remains separately reviewed; no model selection or execution of model text. */
export function mountBrowserTasks(
  root: HTMLElement,
  host: Host,
  now = Date.now,
  monotonic = () => performance.now(),
  closeOtherReviews = () => {},
  privateDelivery = false,
) {
  let disposed = false,
    generation = 0,
    busy = false,
    version = host.reviewVersion();
  let loaded: string | null = null,
    state: Snapshot | null = null,
    review: Review | null = null,
    pending: Deadline | null = null;
  let visible: Deadline | null = null;
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
  const select = (text: string) => {
    const label = el("label", text),
      input = el("select"),
      wrapper = el("div", "", "browser-permission-select");
    input.id = `browser-task-${crypto.randomUUID()}`;
    label.htmlFor = input.id;
    wrapper.append(input);
    return { label, input, wrapper };
  };
  const box = el("section", "", "browser-keys browser-tasks");
  box.setAttribute("aria-label", "Browser private tasks");
  const notice = el(
      "p",
      "Refresh tasks to read this browser’s saved history.",
      "browser-keys-notice",
    ),
    error = el("p", "", "browser-keys-error"),
    current = el("p", "", "browser-keys-reference");
  notice.setAttribute("role", "status");
  error.setAttribute("role", "alert");
  const refresh = button("Refresh tasks", () => void load()),
    initialize = button(
      "Review task storage setup",
      () => void openReview("initialize"),
    ),
    exportButton = button(
      "Review task history export",
      () => void openReview("export"),
    ),
    clear = button(
      "Review task history deletion",
      () => void openReview("clear"),
    );
  const actions = el("div", "", "browser-keys-actions");
  const checkReplies = button(
    "Review checking for a Mac reply",
    () => void openReview("relayCheck"),
  );
  actions.append(refresh, initialize, exportButton, clear);
  if (privateDelivery) actions.append(checkReplies);
  const columns = el("div", "", "browser-keys-columns"),
    history = el("div"),
    list = el("ul"),
    stage = el("div", "", "browser-keys-stage");
  list.setAttribute("aria-label", "Saved browser tasks");
  history.append(
    el("h3", "Tasks saved on this browser"),
    el(
      "p",
      "Saved tasks do not confirm delivery. Your Mac keeps its own history and permissions.",
    ),
    list,
  );
  const form = el("div"),
    peer = select("Mac for this task"),
    kind = select("Task type"),
    promptLabel = el("label", "What should your Mac work on?"),
    prompt = el("textarea"),
    start = button("Review task content", () => void openReview("submit")),
    relayStart = button(
      "Review task for private delivery",
      () => void openReview("relayPrepare"),
    );
  for (const [value, text] of [
    ["query", "Answer a question"],
    ["summarize", "Summarize supplied text"],
    ["draft", "Draft text"],
  ]) {
    const option = el("option", text);
    option.value = value!;
    kind.input.append(option);
  }
  prompt.id = `browser-task-prompt-${crypto.randomUUID()}`;
  promptLabel.htmlFor = prompt.id;
  prompt.rows = 8;
  prompt.maxLength = 32000;
  prompt.spellcheck = true;
  form.append(
    el("h3", "Prepare a task for your Mac"),
    el(
      "p",
      "Provide the text needed for this task. Your Mac chooses its local model. This task cannot access your apps, memories or tools.",
    ),
    peer.label,
    peer.wrapper,
    kind.label,
    kind.wrapper,
    promptLabel,
    prompt,
    start,
  );
  if (privateDelivery)
    form.append(
      relayStart,
      el(
        "p",
        "Private delivery needs approved connections on this browser and your Mac. Preparing a task saves it here; sending is a separate action.",
      ),
    );
  const incomingBox = el("div"),
    incomingKind = select("Message from your Mac"),
    incomingLabel = el("label", "Encrypted message"),
    incoming = el("textarea"),
    receive = button(
      "Review incoming task message",
      () => void openReview("receive"),
    );
  for (const [value, text] of [
    ["receipt", "Task acceptance"],
    ["result", "Task result"],
  ]) {
    const option = el("option", text);
    option.value = value!;
    incomingKind.input.append(option);
  }
  incoming.id = `browser-task-incoming-${crypto.randomUUID()}`;
  incomingLabel.htmlFor = incoming.id;
  incoming.rows = 5;
  incoming.maxLength = 100000;
  incoming.spellcheck = false;
  incomingBox.append(
    el("h3", "Bring back a Mac message"),
    el(
      "p",
      "Choose the Mac above and paste its encrypted acceptance or result. Saving a result does not display its text.",
    ),
    incomingKind.label,
    incomingKind.wrapper,
    incomingLabel,
    incoming,
    receive,
  );
  const reviewBox = el("div"),
    heading = el("h3"),
    details = el("p"),
    identity = el("p", "", "browser-keys-reference"),
    exact = el("pre", "", "browser-task-exact"),
    label = el("label", "", "browser-keys-check"),
    acknowledge = el("input"),
    ackText = el("span");
  heading.tabIndex = -1;
  acknowledge.type = "checkbox";
  label.append(acknowledge, ackText);
  const confirm = button("Confirm task change", () => void submit()),
    cancel = button("Cancel task review", () =>
      reset("Task review closed.", true),
    );
  reviewBox.append(heading, details, identity, exact, label, confirm, cancel);
  const outputBox = el("div", "", "browser-keys-result"),
    outputHeading = el("h3"),
    outputNote = el("p"),
    wire = el("textarea"),
    result = el("pre", "", "browser-task-exact"),
    selectWire = button("Select encrypted task message", () => {
      if (liveOutput()) {
        wire.focus();
        wire.select();
      }
    }),
    downloadWire = button("Download encrypted task message", () => {
      if (liveOutput()) save(wire.value, "bittrees-encrypted-task.json");
    }),
    hide = button("Hide task output", () => reset("Task output hidden.", true));
  wire.readOnly = true;
  wire.rows = 7;
  wire.setAttribute("aria-label", "Encrypted task message to share");
  outputHeading.tabIndex = -1;
  outputBox.append(
    outputHeading,
    outputNote,
    wire,
    selectWire,
    downloadWire,
    result,
    hide,
  );
  stage.append(form, incomingBox, reviewBox, outputBox);
  columns.append(history, stage);
  box.append(
    el("h2", "Private tasks for your Mac"),
    el(
      "p",
      "Prepare and review a task here, then explicitly take its encrypted message to your Mac. Automatic delivery is not connected.",
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
    return c ? JSON.stringify(c) : null;
  };
  const focused = () =>
    document.visibilityState !== "hidden" && document.hasFocus();
  const timed = (d: Deadline) => {
    const n = now(),
      elapsed = monotonic() - d.mono;
    return (
      Number.isSafeInteger(n) &&
      n >= d.wall &&
      n < d.expiresAt &&
      Number.isFinite(elapsed) &&
      elapsed >= 0 &&
      elapsed < d.expiresAt - d.wall
    );
  };
  const deadline = (expiresAt = now() + 120000): Deadline => ({
    wall: now(),
    mono: monotonic(),
    expiresAt,
  });
  const alive = (g: number, captured: string | null) =>
    !disposed &&
    generation === g &&
    !!captured &&
    captured === scope() &&
    focused() &&
    version === host.reviewVersion();
  const ready = () =>
    !busy &&
    !!state &&
    !!loaded &&
    loaded === scope() &&
    focused() &&
    version === host.reviewVersion();
  const online = () => {
    const b = host.keyContext()?.binding;
    return !!b && b.expiresAt > now();
  };
  const liveOutput = () => !!visible && timed(visible) && ready();
  function controls() {
    const active = ready();
    refresh.disabled = busy || !scope() || !focused();
    initialize.disabled = !active || !host.keyContext()?.freshRegistration;
    exportButton.disabled = !active || !state?.history.meta;
    clear.disabled = exportButton.disabled;
    peer.input.disabled =
      kind.input.disabled =
      prompt.disabled =
        !active || !online();
    start.disabled =
      peer.input.disabled ||
      !peer.input.value ||
      !prompt.value.trim() ||
      !!state?.history.meta?.locked ||
      !state?.history.meta;
    relayStart.disabled = start.disabled;
    checkReplies.disabled =
      !active ||
      !online() ||
      !state?.history.meta ||
      !!state?.history.meta?.locked;
    incoming.disabled = incomingKind.input.disabled = peer.input.disabled;
    receive.disabled =
      peer.input.disabled || !peer.input.value || !incoming.value.trim();
    for (const b of list.querySelectorAll<HTMLButtonElement>("button"))
      b.disabled = !active || (b.dataset.online === "true" && !online());
    form.hidden = incomingBox.hidden = !!review || !!visible;
    reviewBox.hidden = !review;
    exact.hidden = !exact.textContent;
    acknowledge.disabled = busy;
    confirm.disabled =
      !active || !review || !timed(review) || !acknowledge.checked;
    cancel.disabled = busy;
    outputBox.hidden = !visible;
  }
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
      host.taskAPI.invalidate();
    }
    version = host.reviewVersion();
    busy = false;
    review = null;
    pending = null;
    visible = null;
    acknowledge.checked = false;
    prompt.value = incoming.value = wire.value = "";
    exact.textContent = result.textContent = identity.textContent = "";
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
  async function snapshot(
    g: number,
    captured: string | null,
  ): Promise<Snapshot> {
    const history = await host.taskAPI.status();
    if (!alive(g, captured)) throw Error("DENIED");
    const keys = await host.keyAPI.status();
    if (!alive(g, captured)) throw Error("DENIED");
    const peers = await host.peerAPI.status();
    if (!alive(g, captured)) throw Error("DENIED");
    const checks = await host.checkAPI.status();
    if (!alive(g, captured)) throw Error("DENIED");
    const permissions = await host.consentAPI.status();
    if (!alive(g, captured)) throw Error("DENIED");
    return { history, keys, peers, checks, permissions };
  }
  function render() {
    const meta = state!.history.meta;
    current.textContent = !meta
      ? "Task storage is not set up. Review setup immediately after registering this browser, before completing device pairing."
      : meta.locked
        ? "Task history was deleted. A different fresh browser registration is required to reset task storage."
        : `Task history version ${meta.revision}. Tasks and original input stay here until you delete them.`;
    list.replaceChildren();
    const placeholder = el("option", "Choose a permitted Mac");
    placeholder.value = "";
    peer.input.replaceChildren(placeholder);
    for (const grant of state!.permissions.grants) {
      if (
        grant.revoked ||
        !grant.choices.sendTasks ||
        grant.choices.expiresAt <= now()
      )
        continue;
      const option = el("option", `Mac ${grant.choices.peerId}`);
      option.value = grant.choices.peerId;
      peer.input.append(option);
    }
    if (!state!.history.entries.length)
      list.append(el("li", "No tasks are saved on this browser."));
    for (const row of state!.history.entries) {
      const li = el("li"),
        title = el(
          "h4",
          row.state === "reserved"
            ? "Preparation interrupted"
            : row.state === "pending"
              ? privateDelivery
                ? "Prepared task"
                : "Prepared for handoff"
              : row.state === "accepted"
                ? "Accepted by your Mac"
                : "Further retries stopped",
        );
      li.append(
        title,
        el("p", `Task ${row.id}`, "browser-keys-reference"),
        el(
          "p",
          `Mac ${row.context.peerId}. Delivery deadline ${new Date(row.header.expiresAt).toLocaleString()}.`,
          "browser-keys-reference",
        ),
      );
      if (privateDelivery) {
        li.append(
          el(
            "p",
            row.relayDelivery
              ? `Last relay confirmation: ${row.relayDelivery.state === "stored" ? "stored for delivery" : row.relayDelivery.state === "received" ? "destination acknowledged delivery" : "message removed"}. Recorded ${new Date(row.relayDelivery.observedAt).toLocaleString()}. This does not confirm task acceptance or reading.`
              : "No relay acknowledgement is saved.",
          ),
        );
        if (row.attempts > (row.relayDelivery?.attempt ?? 0))
          li.append(
            el(
              "p",
              "The latest handoff attempt has no saved relay confirmation. Review before retrying the original task.",
            ),
          );
      }
      const add = (text: string, action: Action, online = true) => {
        const b = button(text, () => void openReview(action, row));
        b.dataset.online = String(online);
        li.append(b);
      };
      if (row.state === "reserved" && row.composed)
        add("Review resuming this task", "resume");
      if (row.state === "pending")
        add("Review encrypted task handoff", "envelope");
      if (privateDelivery && row.state === "pending")
        add("Review sending this task", "relaySend");
      if (row.hasResult) add("Review opening this result", "read");
      if (row.state !== "accepted" && row.state !== "stopped")
        add("Review stopping task retries", "stop", false);
      list.append(li);
    }
    controls();
  }
  function failure(e: unknown) {
    const messages: Record<string, string> = {
      DENIED:
        "The current account, registration or permission no longer allows this operation.",
      CONFLICT: "Saved task or device details changed during review.",
      CAPACITY:
        "The task or saved history exceeded a limit, or local storage could not complete the change.",
      SETUP_REQUIRED:
        "Task storage needs explicit setup under a fresh browser registration.",
      STORAGE_UNAVAILABLE: "Saved task storage is unavailable.",
      BUSY: "Another operation is still finishing.",
    };
    error.textContent = `${messages[e instanceof Error ? e.message : ""] ?? "The operation was not confirmed."} Refresh tasks to inspect what was saved. A failed response may follow a saved change; this review cannot be retried.`;
  }
  async function load() {
    if (busy || !scope() || !focused()) return;
    reset("Reading saved tasks…", true);
    const g = generation,
      captured = scope();
    busy = true;
    controls();
    try {
      const value = await snapshot(g, captured);
      if (!alive(g, captured)) return;
      state = value;
      loaded = captured;
      render();
      notice.textContent =
        "Task history loaded. Review a change or prepare new task content.";
    } catch (e) {
      if (alive(g, captured)) failure(e);
    } finally {
      if (generation === g) {
        busy = false;
        controls();
      }
    }
  }
  function selectedRoute() {
    const grant = state?.permissions.grants.find(
      (g) =>
        g.choices.peerId === peer.input.value &&
        !g.revoked &&
        g.choices.sendTasks &&
        g.choices.expiresAt > now(),
    );
    if (!grant) throw Error("DENIED");
    return {
      peerId: grant.choices.peerId,
      peerKeyEpoch: grant.choices.peerKeyEpoch,
    };
  }
  async function openReview(action: Action, row?: Row) {
    if (!ready()) return;
    if (action.startsWith("relay") && !privateDelivery) return;
    const before = structuredClone(state!),
      draft = {
        version: 1,
        type: "task.submit",
        kind: kind.input.value,
        prompt: prompt.value,
      },
      incomingText = incoming.value,
      selectedKind = incomingKind.input.value;
    let route: { peerId: string; peerKeyEpoch: number } | undefined;
    try {
      if (action === "submit" || action === "relayPrepare")
        browserTaskBytes(draft).fill(0);
      if (
        action === "submit" ||
        action === "relayPrepare" ||
        action === "receive"
      )
        route = selectedRoute();
    } catch (e) {
      error.textContent =
        e instanceof Error && e.message === "CAPACITY"
          ? "This task is too large. Shorten the supplied text and review again."
          : "Choose a currently permitted Mac and provide valid task text before reviewing.";
      return;
    }
    reset("Checking this exact task review…");
    const g = generation,
      captured = loaded,
      start = deadline();
    pending = start;
    busy = true;
    controls();
    try {
      const fresh = await snapshot(g, captured);
      if (!alive(g, captured) || !timed(start)) throw Error("DENIED");
      if (!same(fresh, before)) throw Error("CONFLICT");
      const next: Review = {
        ...start,
        action,
        before,
        ...(row ? { row: structuredClone(row) } : {}),
      };
      if (action === "relaySend" && row)
        next.expiresAt = Math.min(next.expiresAt, row.header.expiresAt);
      if (action === "submit" || action === "relayPrepare") {
        const payload = privateTaskPayloadSchema.parse(draft);
        next.prepared = await (action === "relayPrepare"
          ? host.relayTaskAPI.prepare({ ...route!, payload })
          : host.taskAPI.prepare({ ...route!, payload }));
        next.expiresAt = Math.min(next.expiresAt, next.prepared.expiresAt);
      } else if (action === "receive") {
        if (
          incomingText.length > 100000 ||
          (selectedKind !== "receipt" && selectedKind !== "result")
        )
          throw Error("DENIED");
        next.incoming = {
          ...route!,
          kind: selectedKind,
          envelope: privateEnvelopeSchema.parse(JSON.parse(incomingText)),
        };
      }
      if (!alive(g, captured) || !timed(next)) throw Error("DENIED");
      review = next;
      describe(next);
      notice.textContent =
        "Review this exact operation and acknowledge it before confirming.";
    } catch (e) {
      if (alive(g, captured)) {
        host.taskAPI.invalidate();
        version = host.reviewVersion();
        failure(e);
      }
    } finally {
      if (g === generation) {
        busy = false;
        pending = null;
        controls();
        if (review) heading.focus();
      }
    }
  }
  function describe(r: Review) {
    const text: Record<Action, [string, string, string, string]> = {
      initialize: [
        "Set up this browser’s task storage",
        "This explicitly prepares local task storage for the current fresh registration. It does not create keys, allow a Mac or send a task. A reset needs a different browser identity; existing history is not silently removed.",
        "I reviewed this browser and want to set up its task storage.",
        "Confirm task storage setup",
      ],
      submit: [
        "Review the exact task",
        "This saves an encrypted preparation for the selected Mac. You will separately review its encrypted handoff. The Mac independently decides whether to accept it and which local model to use.",
        "I reviewed the complete task text, selected Mac and delivery deadline.",
        "Confirm task preparation",
      ],
      relayPrepare: [
        "Review task for private delivery",
        "Save this exact task for the selected Mac using the current connection deadlines. You will separately review sending it. Your Mac chooses its local model and independently checks task permission.",
        "I reviewed the complete task text, selected Mac and delivery deadline.",
        "Save task for private delivery",
      ],
      relaySend: [
        "Send this saved task to your Mac",
        "Send the original encrypted message for this exact task and Mac through ai.bittrees.org. Server storage does not confirm Mac acceptance or completion. A new review is needed for each retry.",
        "Send this exact saved task to the Mac identified in this review.",
        "Send reviewed task",
      ],
      relayCheck: [
        "Check for one Mac reply",
        "Check for one encrypted acceptance or result for this browser. A reply is authenticated and saved before delivery is acknowledged. Saved result text stays hidden until you separately open it.",
        "Check and save one authenticated Mac reply on this browser.",
        "Check for Mac reply",
      ],
      resume: [
        "Resume the saved task preparation",
        "Continue the original saved operation, input and deadline. A committed task keeps its original ciphertext. This does not create a replacement task or send automatically.",
        "Resume this exact saved task.",
        "Confirm task resume",
      ],
      envelope: [
        "Review encrypted task handoff",
        "Show the original encrypted task message so you can take it to your Mac. This records a handoff attempt; it does not confirm receipt or connect a relay.",
        "Show this exact task’s encrypted message for handoff.",
        "Show encrypted task message",
      ],
      receive: [
        "Save the Mac’s encrypted message",
        "The current verified identity and permission will be checked before this acceptance or result is saved. Result text stays hidden until separately opened.",
        "Save this exact encrypted message from the selected Mac.",
        "Confirm incoming task message",
      ],
      read: [
        "Open this Mac result",
        "Display the saved result text under current verified permission. Model text cannot run actions here. Leaving this window hides it.",
        "Display this task result on this browser.",
        "Open reviewed task result",
      ],
      stop: [
        "Stop further task retries",
        "Keep the saved input and encrypted history while stopping further handoff attempts. This cannot retract a copied message or cancel work already accepted by your Mac.",
        "Stop further retries for this saved task.",
        "Stop task retries",
      ],
      export: [
        "Export this browser’s task history",
        "The download includes your original task text in readable form and encrypted task/result messages. It contains no keys or restore authority. Exported copies remain separate from later browser deletion.",
        "I understand that the download contains my original task text.",
        "Export reviewed task history",
      ],
      clear: [
        "Delete this browser’s task history",
        "Remove original task preparations and their local keys, plus encrypted tasks and results. Minimal retry counters remain to prevent reuse. This does not delete Mac history or exported copies. Sending again requires a different fresh browser registration and setup.",
        "Delete this browser’s saved task content and encrypted history.",
        "Delete reviewed task history",
      ],
    };
    [
      heading.textContent,
      details.textContent,
      ackText.textContent,
      confirm.textContent,
    ] = text[r.action];
    const binding = host.keyContext()?.binding;
    identity.textContent = `Account ${host.session()!.ownerId}.${binding ? ` Browser ${binding.deviceId}.` : ""} History version ${r.before.history.meta?.revision ?? 0}.${r.row ? ` Task ${r.row.id}, task version ${r.row.revision}, Mac ${r.row.context.peerId}. Delivery deadline ${new Date(r.row.header.expiresAt).toLocaleString()}.` : ""}`;
    exact.textContent = "";
    if (r.prepared) {
      const p = r.prepared;
      identity.textContent += ` Mac ${p.context.peerId}, key version ${p.context.peerKeyEpoch}. Fingerprint ${p.context.peerFingerprint}. Permission ${p.context.permissionId}. Delivery deadline ${new Date(p.deliveryExpiresAt).toLocaleString()}.`;
      exact.textContent = `Task type: ${p.payload.kind}\n\n${p.payload.prompt}`;
    }
    if (r.incoming) {
      const p = r.incoming;
      identity.textContent += ` Selected Mac ${p.peerId}, key version ${p.peerKeyEpoch}. Message ${p.envelope.header.messageId}, task ${p.envelope.header.operationId}.`;
      exact.textContent = JSON.stringify(p.envelope);
    }
  }
  async function submit() {
    if (!ready() || !review || !timed(review) || !acknowledge.checked) return;
    const selected = review,
      g = generation,
      captured = loaded;
    review = null;
    acknowledge.checked = false;
    busy = true;
    pending = selected;
    controls();
    try {
      const fresh = await snapshot(g, captured);
      if (!alive(g, captured) || !timed(selected)) throw Error("DENIED");
      if (!same(fresh, selected.before)) throw Error("CONFLICT");
      const row = selected.row,
        route = row
          ? {
              peerId: row.context.peerId,
              peerKeyEpoch: row.context.peerKeyEpoch,
              id: row.id,
              expectedRevision: row.revision,
              confirmed: true,
            }
          : null;
      let encrypted: PrivateEnvelope | undefined,
        plaintext: string | undefined,
        deliveryNotice: string | undefined;
      switch (selected.action) {
        case "initialize":
          await host.taskAPI.initialize({
            expectedRevision: fresh.history.meta?.revision ?? 0,
            confirmed: true,
          });
          break;
        case "submit":
        case "relayPrepare":
          await host.taskAPI.confirm({
            reviewId: selected.prepared!.reviewId,
            confirmed: true,
            acknowledged: true,
          });
          break;
        case "relaySend": {
          if (!privateDelivery) throw Error("DENIED");
          const sent = await host.relayTaskAPI.send(route!);
          deliveryNotice =
            sent.receipt.state === "deleted"
              ? "The server previously removed this encrypted message. No replacement was sent. Review your saved history before preparing another task."
              : `Encrypted task ${sent.receipt.state === "received" ? "already delivered" : "stored for delivery"}${sent.duplicate ? " (the original message was already recorded)" : ""}. This does not confirm Mac acceptance or task completion. Check for a Mac reply separately.`;
          break;
        }
        case "relayCheck": {
          if (!privateDelivery) throw Error("DENIED");
          const checked = await host.relayTaskAPI.check({
            after: null,
            confirmed: true,
          });
          deliveryNotice = checked.received
            ? `Authenticated Mac ${checked.received.kind === "result" ? "result" : "acceptance"} saved for task ${checked.received.operationId}.${checked.received.kind === "result" ? " Review opening this result in task history to read its text." : " Acceptance does not mean the task is complete."}`
            : "No new Mac reply is waiting for this browser.";
          break;
        }
        case "resume":
          await host.taskAPI.resume(route!);
          break;
        case "envelope":
          encrypted = await host.taskAPI.envelope(route!);
          break;
        case "receive":
          await host.taskAPI.receive({
            ...selected.incoming!,
            confirmed: true,
          });
          break;
        case "read": {
          const output = privateResultPayloadSchema.parse(
            await host.taskAPI.readResult(route!),
          );
          plaintext =
            output.task.output ??
            `Task ${output.task.status}. No result text was returned.`;
          break;
        }
        case "stop":
          await host.taskAPI.stop({
            id: row!.id,
            expectedRevision: row!.revision,
            confirmed: true,
          });
          break;
        case "clear":
          await host.taskAPI.clear({
            expectedRevision: fresh.history.meta!.revision,
            confirmed: true,
          });
          break;
        case "export": {
          const exported = await host.taskAPI.export({
            expectedRevision: fresh.history.meta!.revision,
            confirmed: true,
          });
          if (!alive(g, captured) || !timed(selected)) throw Error("DENIED");
          save(JSON.stringify(exported, null, 2), "bittrees-task-history.json");
          break;
        }
      }
      if (!alive(g, captured) || !timed(selected)) throw Error("DENIED");
      // Saved mutations invalidate the displayed snapshot even if a later refresh fails.
      state = null;
      list.replaceChildren();
      current.textContent = "";
      exact.textContent = "";
      identity.textContent = "";
      const after = await snapshot(g, captured);
      if (!alive(g, captured) || !timed(selected)) throw Error("DENIED");
      state = after;
      render();
      if (encrypted || plaintext !== undefined) {
        visible = deadline(
          encrypted
            ? Math.min(now() + 120000, encrypted.header.expiresAt)
            : undefined,
        );
        wire.value = encrypted ? JSON.stringify(encrypted) : "";
        result.textContent = plaintext ?? "";
        wire.hidden = selectWire.hidden = downloadWire.hidden = !encrypted;
        result.hidden = plaintext === undefined;
        outputHeading.textContent = encrypted
          ? "Encrypted task ready for handoff"
          : "Mac result";
        outputNote.textContent = encrypted
          ? "Take this exact message to your Mac. Copying it does not confirm delivery."
          : "Model text is shown as text only. It has no authority to run actions.";
        notice.textContent = encrypted
          ? "Original encrypted task message opened."
          : "Saved result opened under current permission.";
      } else
        notice.textContent =
          deliveryNotice ??
          (selected.action === "relayPrepare"
            ? "Task saved for private delivery. Review sending this task in history; nothing was sent automatically."
            : selected.action === "export"
              ? "History exported. The download includes your original task text."
              : selected.action === "clear"
                ? "Task content deleted from this browser."
                : selected.action === "submit" || selected.action === "resume"
                  ? "Task preparation saved. Review its encrypted handoff in history; nothing was sent automatically."
                  : "Task change saved. Refreshed history shows the current state.");
    } catch (e) {
      if (alive(g, captured)) {
        state = null;
        list.replaceChildren();
        current.textContent = "";
        visible = null;
        wire.value = "";
        result.textContent = exact.textContent = "";
        host.taskAPI.invalidate();
        version = host.reviewVersion();
        failure(e);
      }
    } finally {
      if (g === generation) {
        busy = false;
        pending = null;
        controls();
        if (visible) outputHeading.focus();
      }
    }
  }
  function save(content: string, name: string) {
    const url = URL.createObjectURL(
      new Blob([content], { type: "application/json" }),
    );
    urls.add(url);
    const a = el("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    const timer = setTimeout(() => {
      URL.revokeObjectURL(url);
      urls.delete(url);
      timers.delete(timer);
    }, 30000);
    timers.add(timer);
  }
  acknowledge.onchange = controls;
  prompt.oninput = incoming.oninput = controls;
  peer.input.onchange =
    kind.input.onchange =
    incomingKind.input.onchange =
      controls;
  const blur = () =>
      reset(
        "Task review and output closed after leaving this window. Refresh tasks to continue.",
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
        reset("Task review closed. Refresh tasks to continue.", true);
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
        "Account or device controls changed. Refresh tasks to continue.",
        true,
        false,
      );
    else if (
      (pending && !timed(pending)) ||
      (review && !timed(review)) ||
      (visible && !timed(visible))
    )
      reset(
        "Task review or output expired. Refresh tasks to inspect saved history.",
        true,
      );
    controls();
  }, 500);
  controls();
  return {
    invalidate() {
      reset("Access changed. Refresh tasks to continue.", true, false);
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      generation++;
      host.taskAPI.invalidate();
      clearDownloads();
      clearInterval(timer);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
      box.removeEventListener("keydown", keydown);
      prompt.value = incoming.value = wire.value = "";
      result.textContent = exact.textContent = "";
      box.remove();
    },
  };
}
